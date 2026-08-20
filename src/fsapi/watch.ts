// fsapi/watch.ts — fs.watch wrapper, debounced + coalesced (Phase 6).
//
// Watches exactly one directory — the one currently on screen — never
// recursively; recursive watching is unreliable on Linux and the app only
// ever displays one directory at a time. `FsWatcher.retarget()` closes the
// old `fs.watch` handle and opens a new one every time the caller navigates,
// so exactly one native watch is ever open.
//
// Three failure modes were verified on this machine and each is handled
// deliberately, not by the obvious naive wrapper:
//
//   1. Event payloads are unusable. A `rename a -> b` was observed
//      delivering only `["rename", "a.txt"]` — the arrival of `b` was
//      simply lost. So every event, whatever its type or filename argument,
//      is treated as an opaque "something changed, rescan" signal — the
//      callback passed to `fs.watch` below never even looks at its
//      arguments, on purpose.
//   2. `fs.watch` dies silently when the watched directory is removed: no
//      `error` event, no `close`, and it never recovers even if the
//      directory is recreated at the same path. This can only be detected
//      by trying to use the directory and catching ENOENT — `settle()`
//      below does exactly that with a plain `stat()` (cheaper than a full
//      `readdir`, since all it needs is "does this path still exist") and,
//      on ENOENT, walks up parent directories until one survives, re-arms
//      `fs.watch` there, and reports the new directory to the caller so the
//      UI's `cwd` follows it.
//   3. Bursts are not coalesced by the OS. Creating 500 files in one `tar
//      -x` produced 500 separate `fs.watch` callbacks. `Coalescer` below
//      debounces on the trailing edge (~80ms) but caps the wait at ~500ms
//      from the *first* event in a burst, so a sustained stream of events
//      (an extraction that never pauses for 80ms) still produces periodic
//      rescans instead of starving the view indefinitely.
//
// `Coalescer` is deliberately its own small, pure, injectable-clock class:
// `fs.watch` timing is unavoidably real-clock and flaky to test, but the
// debounce/max-wait arithmetic that decides *when* to fire is not, and is
// tested in isolation with a fake clock (see tests/watch.test.ts).
//
// Suppressing rescans while a paste/cut job is in flight (the destination
// directory of a running copy is itself a burst-event generator) is a
// caller concern, not this file's: `WatcherOptions.suppressed` is a plain
// predicate the caller supplies (`() => isBusy()` from ops/queue.ts in
// main.ts) so this file never has to import the job queue. The job itself
// already reloads the directory when it finishes (state/store.ts's
// `paste()`/cut path), so there is nothing left for the watcher to do once
// the predicate flips back to false — no "replay the suppressed event"
// bookkeeping needed here.

import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

// ── Coalescer: pure, injectable-clock debounce with a max wait ──

/** The subset of a JS timer API `Coalescer` needs — swappable in tests. */
export type Clock = {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_DEBOUNCE_MS = 80;
export const DEFAULT_MAX_WAIT_MS = 500;

export type CoalescerOptions = {
  /** Trailing-edge quiet period before firing. Default 80ms. */
  debounceMs?: number;
  /** Ceiling on how long a sustained stream of events can postpone a fire,
   *  measured from the first event of the current burst. Default 500ms. */
  maxWaitMs?: number;
  clock?: Clock;
};

/**
 * Trailing-edge debounce with a maximum wait. Call `trigger()` on every raw
 * event; `onFire` runs once, ~`debounceMs` after the last `trigger()` call,
 * but never later than `maxWaitMs` after the first `trigger()` in the
 * current burst. A burst that never goes quiet for `debounceMs` still fires
 * periodically instead of starving forever.
 */
export class Coalescer {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly clock: Clock;
  private timer: unknown = null;
  private burstStartedAt: number | null = null;

  constructor(
    private readonly onFire: () => void,
    opts: CoalescerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  /** Record one raw event and (re)arm the trailing-edge timer. */
  trigger(): void {
    const now = this.clock.now();
    if (this.burstStartedAt === null) this.burstStartedAt = now;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);

    const elapsed = now - this.burstStartedAt;
    const remainingToMaxWait = this.maxWaitMs - elapsed;
    // Never schedule negative delay, and never wait past the burst's own
    // max-wait ceiling even if that means firing sooner than a fresh
    // debounceMs would otherwise call for.
    const delay = Math.max(0, Math.min(this.debounceMs, remainingToMaxWait));

    this.timer = this.clock.setTimeout(() => this.fire(), delay);
  }

  /** Cancel any pending fire without invoking the callback. */
  cancel(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.burstStartedAt = null;
  }

  private fire(): void {
    this.timer = null;
    this.burstStartedAt = null;
    this.onFire();
  }
}

// ── FsWatcher: fs.watch + Coalescer + the ENOENT/walk-up recovery ──

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Walk up from `dir` until `stat()` succeeds, returning the nearest
 * surviving ancestor. Stops at the filesystem root even if the root itself
 * somehow fails to stat (it won't in practice) — `dirname()` of the root is
 * the root, which is the loop's own termination signal.
 */
async function nearestSurvivingAncestor(dir: string): Promise<string> {
  let d = dir;
  for (;;) {
    try {
      await stat(d);
      return d;
    } catch {
      const parent = dirname(d);
      if (parent === d) return d;
      d = parent;
    }
  }
}

export type WatcherHandlers = {
  /**
   * Called once the debounced burst has settled. `dir` is the directory to
   * treat as current: identical to whatever was last targeted when nothing
   * moved, or a surviving ancestor when the watched directory vanished
   * (`walkedUp: true`) — the caller decides how to apply each case (an
   * in-place rescan vs. something closer to a navigation, since `cwd`
   * itself needs to follow a walk-up).
   */
  onSettle(dir: string, walkedUp: boolean): void;
};

export type WatcherOptions = {
  debounceMs?: number;
  maxWaitMs?: number;
  clock?: Clock;
  /** Test seam: swap in a fake `fs.watch`. Defaults to node:fs's `watch`. */
  fsWatch?: typeof watch;
  /**
   * Checked at the top of every settle; when it returns true the whole
   * settle is skipped — no rescan, no walk-up check. Meant for "a paste/cut
   * job is in flight" (see the file header for why the predicate lives on
   * the caller's side, not this file's).
   */
  suppressed?: () => boolean;
};

export class FsWatcher {
  private dir: string;
  private handle: FSWatcher | null = null;
  private closed = false;
  private readonly coalescer: Coalescer;
  private readonly fsWatch: typeof watch;
  private readonly suppressed: () => boolean;

  constructor(
    initialDir: string,
    private readonly handlers: WatcherHandlers,
    opts: WatcherOptions = {},
  ) {
    this.dir = initialDir;
    this.fsWatch = opts.fsWatch ?? watch;
    this.suppressed = opts.suppressed ?? (() => false);
    this.coalescer = new Coalescer(() => void this.settle(), {
      debounceMs: opts.debounceMs,
      maxWaitMs: opts.maxWaitMs,
      clock: opts.clock,
    });
    this.arm(initialDir);
  }

  /** The directory currently watched — may differ from what was last
   *  requested via `retarget()` if a walk-up happened since. */
  currentDir(): string {
    return this.dir;
  }

  /**
   * Point the watcher at a new directory because of ordinary navigation —
   * closes the old `fs.watch` handle and opens a new one. A no-op when
   * already watching `dir`, so re-announcing the directory a walk-up
   * already retargeted internally doesn't churn a redundant close/reopen.
   */
  retarget(dir: string): void {
    if (this.closed) return;
    if (dir === this.dir && this.handle !== null) return;
    this.dir = dir;
    this.arm(dir);
  }

  /** Close the underlying watch and cancel any pending debounce. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.coalescer.cancel();
    this.handle?.close();
    this.handle = null;
  }

  private arm(dir: string): void {
    this.handle?.close();
    this.handle = null;
    try {
      this.handle = this.fsWatch(
        dir,
        { persistent: false, recursive: false },
        () => {
          // Never read (eventType, filename) — see the file header's failure
          // mode 1. Every event, whatever it claims, just means "rescan."
          this.coalescer.trigger();
        },
      );
      this.handle.on("error", () => {
        // Not observed in practice (the directory-removed case is silent,
        // not an `error` event) but if one ever arrives, treat it exactly
        // like any other signal to re-check: settle() will find the
        // directory gone, or not, on its own.
        this.coalescer.trigger();
      });
    } catch {
      // `dir` vanished between being chosen and this call (or never
      // existed) — fall through to the same recovery path a live watcher's
      // silent death takes, by asking settle() to run.
      this.coalescer.trigger();
    }
  }

  private async settle(): Promise<void> {
    if (this.closed) return;
    if (this.suppressed()) return;

    try {
      await stat(this.dir);
      this.handlers.onSettle(this.dir, false);
    } catch (err) {
      if (!isEnoent(err)) {
        // Some other failure (e.g. permissions changed under us) — still
        // worth reporting as a settle; the caller's own scan renders
        // whatever in-pane error is appropriate. Not a walk-up case.
        this.handlers.onSettle(this.dir, false);
        return;
      }
      const survivor = await nearestSurvivingAncestor(this.dir);
      this.dir = survivor;
      if (!this.closed) this.arm(survivor);
      this.handlers.onSettle(survivor, true);
    }
  }
}
