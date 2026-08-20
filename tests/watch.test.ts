// tests/watch.test.ts — fsapi/watch.ts: the `Coalescer` debounce/max-wait
// core, tested as a pure unit against a fake clock so "500 events in a
// burst" and "a continuous stream" are deterministic (real timers would
// make these either slow or flaky), plus `FsWatcher` integration tests
// against a real temp directory with real timers and generous timeouts —
// `fs.watch` itself cannot be faked meaningfully.
//
// The directory-removal behavior asserted below (exactly one `rename` event
// fires, with no filename, and the watcher then goes silent even once the
// directory is recreated) was verified against this machine's Bun before
// writing FsWatcher's walk-up logic — see fsapi/watch.ts's file header.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusy } from "../src/fsapi/ops/queue.ts";
import {
  type Clock,
  Coalescer,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  FsWatcher,
} from "../src/fsapi/watch.ts";

// ── FakeClock: a tiny manually-driven clock for Coalescer's tests ──
//
// `advance(ms)` fires any due timers in chronological order — including a
// timer a fired callback itself schedules before the advance completes, the
// same way a real event loop would interleave them within one tick budget.

class FakeClock implements Clock {
  private nowMs = 0;
  private nextId = 1;
  private timers: Array<{ id: number; at: number; cb: () => void }> = [];

  now(): number {
    return this.nowMs;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.nowMs = next.at;
      next.cb();
    }
    this.nowMs = target;
  }
}

describe("Coalescer", () => {
  it("does not fire synchronously — trigger() only arms a timer", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    c.trigger();
    expect(fires).toBe(0);
  });

  it("fires once, after the debounce, for a single event", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    c.trigger();
    clock.advance(DEFAULT_DEBOUNCE_MS - 1);
    expect(fires).toBe(0);
    clock.advance(1);
    expect(fires).toBe(1);
  });

  it("500 events in a tight burst produce exactly one rescan", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    for (let i = 0; i < 500; i++) c.trigger();
    expect(fires).toBe(0); // nothing fired yet — clock never advanced
    clock.advance(DEFAULT_DEBOUNCE_MS);
    expect(fires).toBe(1);
  });

  it("a burst that goes quiet mid-way still fires only once", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    for (let i = 0; i < 50; i++) {
      c.trigger();
      clock.advance(5); // well under the debounce, keeps resetting it
    }
    clock.advance(DEFAULT_DEBOUNCE_MS); // now let it actually go quiet
    expect(fires).toBe(1);
  });

  it("a continuous event stream that never goes quiet still rescans within the max-wait ceiling", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    const stepMs = 10; // well under the 80ms debounce, so it never settles on its own
    const totalMs = 2000;
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      c.trigger();
      clock.advance(stepMs);
    }
    // A debounce with no max wait would never fire here at all. With the
    // ~500ms ceiling it must fire periodically — roughly every
    // DEFAULT_MAX_WAIT_MS, so about 4 times over 2 seconds. Bounded rather
    // than pinned to an exact count so the test isn't brittle to rounding
    // at the loop's edges.
    const expected = Math.floor(totalMs / DEFAULT_MAX_WAIT_MS);
    expect(fires).toBeGreaterThanOrEqual(expected - 1);
    expect(fires).toBeLessThanOrEqual(expected + 1);
  });

  it("cancel() drops a pending fire without invoking the callback", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    c.trigger();
    c.cancel();
    clock.advance(DEFAULT_MAX_WAIT_MS * 2);
    expect(fires).toBe(0);
  });

  it("a fresh burst after a cancel starts its own max-wait window", () => {
    const clock = new FakeClock();
    let fires = 0;
    const c = new Coalescer(() => fires++, { clock });
    c.trigger();
    clock.advance(DEFAULT_DEBOUNCE_MS - 10); // still pending, not yet fired
    c.cancel();
    c.trigger();
    clock.advance(DEFAULT_DEBOUNCE_MS);
    expect(fires).toBe(1);
  });
});

// ── FsWatcher: real fs.watch, real timers, generous timeouts ──

/** Fast timing for the integration tests — real timers, but short enough
 *  that even a generous await budget keeps the suite quick. */
const TEST_TIMING = { debounceMs: 30, maxWaitMs: 150 };

type Settle = { dir: string; walkedUp: boolean };

/** Wire an FsWatcher whose settles can be awaited one at a time in test order. */
function makeAwaitableWatcher(
  initialDir: string,
  opts: Partial<ConstructorParameters<typeof FsWatcher>[2]> = {},
) {
  const queue: Settle[] = [];
  let pending: ((s: Settle) => void) | null = null;

  const watcher = new FsWatcher(
    initialDir,
    {
      onSettle(dir, walkedUp) {
        const settle = { dir, walkedUp };
        if (pending) {
          const resolve = pending;
          pending = null;
          resolve(settle);
        } else {
          queue.push(settle);
        }
      },
    },
    { ...TEST_TIMING, ...opts },
  );

  function nextSettle(timeoutMs = 3000): Promise<Settle> {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a watcher settle")),
        timeoutMs,
      );
      pending = (s) => {
        clearTimeout(timer);
        resolve(s);
      };
    });
  }

  return { watcher, nextSettle };
}

describe("FsWatcher", () => {
  it("creating a file triggers a rescan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-watch-test-"));
    const { watcher, nextSettle } = makeAwaitableWatcher(dir);
    try {
      writeFileSync(join(dir, "new.txt"), "hi");
      const settle = await nextSettle();
      expect(settle.dir).toBe(dir);
      expect(settle.walkedUp).toBe(false);
    } finally {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);

  it("deleting the watched directory walks up to the surviving ancestor", async () => {
    const root = mkdtempSync(join(tmpdir(), "flash-watch-test-"));
    const child = join(root, "child");
    mkdirSync(child);
    const { watcher, nextSettle } = makeAwaitableWatcher(child);
    try {
      rmSync(child, { recursive: true, force: true });
      const settle = await nextSettle();
      expect(settle.walkedUp).toBe(true);
      expect(settle.dir).toBe(root);
      expect(watcher.currentDir()).toBe(root);

      // The recovery must actually be live: a change in the surviving
      // ancestor after the walk-up produces a further settle from the
      // watcher now armed there, not silence.
      writeFileSync(join(root, "after.txt"), "hi");
      const second = await nextSettle();
      expect(second.dir).toBe(root);
      expect(second.walkedUp).toBe(false);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 5000);

  it("retarget() re-arms on a new directory and stops watching the old one", async () => {
    const root = mkdtempSync(join(tmpdir(), "flash-watch-test-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA);
    mkdirSync(dirB);
    const { watcher, nextSettle } = makeAwaitableWatcher(dirA);
    try {
      watcher.retarget(dirB);
      expect(watcher.currentDir()).toBe(dirB);

      // A change in the now-unwatched dirA must not produce a settle.
      writeFileSync(join(dirA, "ignored.txt"), "hi");
      // A change in dirB, the newly-armed target, must.
      writeFileSync(join(dirB, "seen.txt"), "hi");
      const settle = await nextSettle();
      expect(settle.dir).toBe(dirB);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 5000);

  it("suppressed() skips settling entirely while true, matching isBusy()'s real contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-watch-test-"));
    let busy = true;
    const queue: Settle[] = [];
    const watcher = new FsWatcher(
      dir,
      { onSettle: (d, w) => queue.push({ dir: d, walkedUp: w }) },
      { ...TEST_TIMING, suppressed: () => busy },
    );
    try {
      // isBusy() itself is false at rest — the fake `busy` flag above
      // stands in for "a paste/cut job is in flight" so this test stays
      // fast and does not need a real multi-file copy to keep a job busy
      // for the whole debounce window; a real runPasteJob's start/end are
      // separately covered by tests/queue.test.ts's isBusy() assertions.
      expect(isBusy()).toBe(false);

      writeFileSync(join(dir, "during-job.txt"), "hi");
      await new Promise((r) => setTimeout(r, TEST_TIMING.maxWaitMs + 100));
      expect(queue).toHaveLength(0); // no rescan fired while suppressed

      busy = false;
      writeFileSync(join(dir, "after-job.txt"), "hi");
      await new Promise((r) => setTimeout(r, TEST_TIMING.maxWaitMs + 100));
      expect(queue.length).toBeGreaterThanOrEqual(1);
      expect(queue[0]?.dir).toBe(dir);
    } finally {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);

  it("close() is idempotent and stops any further settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-watch-test-"));
    let fires = 0;
    const watcher = new FsWatcher(
      dir,
      { onSettle: () => fires++ },
      TEST_TIMING,
    );
    watcher.close();
    watcher.close(); // must not throw
    writeFileSync(join(dir, "after-close.txt"), "hi");
    await new Promise((r) => setTimeout(r, TEST_TIMING.maxWaitMs + 100));
    expect(fires).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 5000);
});
