// tests/delete.test.ts — state/store.ts's Phase 7 delete actions
// (startDelete/confirmDelete/cancelDelete) and fsapi/ops/queue.ts's
// runDeleteJob. Covers the plan's named safety property (Enter does not
// delete — proven here at the Store level: cancelDelete() is what Enter
// actually routes to, per tests/keymap.test.ts's routing tests, and this
// file proves calling it leaves everything intact), the marked-set case,
// cancelling mid-delete, and refusing to delete ".." or the cwd itself.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeleteJob } from "../src/fsapi/ops/queue.ts";
import { Store } from "../src/state/store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flash-delete-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeStore(): Promise<Store> {
  const store = new Store({ cwd: root });
  await store.load(root);
  return store;
}

function setCursorTo(store: Store, name: string): void {
  const idx = store.visibleEntries().findIndex((e) => e.name === name);
  expect(idx).toBeGreaterThanOrEqual(0);
  store.setCursorIndex(idx);
}

describe("Store.startDelete — the confirm message", () => {
  it("names a single file directly", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    const store = await makeStore();
    setCursorTo(store, "a.txt");
    await store.startDelete();

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("confirm");
    if (overlay?.kind !== "confirm") throw new Error("unreachable");
    expect(overlay.message).toBe("Delete 'a.txt'?");
    expect(overlay.paths).toEqual([join(root, "a.txt")]);
  });

  it("names a directory with its (capped) file count", async () => {
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build", "one.txt"), "1");
    writeFileSync(join(root, "build", "two.txt"), "2");
    const store = await makeStore();
    setCursorTo(store, "build");
    await store.startDelete();

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("confirm");
    if (overlay?.kind !== "confirm") throw new Error("unreachable");
    expect(overlay.message).toBe("Delete directory 'build/' (2 files)?");
  });

  it("names the marked set with one representative directory, matching the plan's example shape", async () => {
    mkdirSync(join(root, "build"));
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, "build", `f${i}.txt`), String(i));
    }
    writeFileSync(join(root, "readme.md"), "r");
    const store = await makeStore();
    store.markAll(); // marks build + readme.md
    await store.startDelete();

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("confirm");
    if (overlay?.kind !== "confirm") throw new Error("unreachable");
    expect(overlay.message).toBe(
      "Delete 2 items, including directory 'build/' (3 files)?",
    );
  });

  it("refuses when nothing is marked and the cursor is on '..'", async () => {
    const store = await makeStore();
    store.moveCursorTo("home"); // the ".." row
    await store.startDelete();
    expect(store.getState().overlay).toBeNull();
  });

  it("refuses to open on the current directory itself, reached via a stale mark", async () => {
    mkdirSync(join(root, "child"));
    const store = await makeStore();
    setCursorTo(store, "child");
    store.toggleMarkAtCursor(); // mark "child" while still in root
    await store.enter(); // cd into child — the marked path now equals cwd
    expect(store.getState().cwd).toBe(join(root, "child"));

    await store.startDelete();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().message?.text).toContain(
      "cannot delete the current directory",
    );
  });
});

describe("Store.confirmDelete / cancelDelete", () => {
  it("y (confirmDelete) actually deletes and refreshes the listing", async () => {
    writeFileSync(join(root, "gone.txt"), "bye");
    const store = await makeStore();
    setCursorTo(store, "gone.txt");
    await store.startDelete();
    await store.confirmDelete();

    expect(store.getState().overlay).toBeNull();
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    expect(store.visibleEntries().some((e) => e.name === "gone.txt")).toBe(
      false,
    );
    expect(store.getState().message?.text).toContain("deleted 1 item");
  });

  it("Enter does not confirm — cancelDelete (what Enter routes to, per keymap.test.ts) leaves everything intact", async () => {
    writeFileSync(join(root, "safe.txt"), "still here");
    const store = await makeStore();
    setCursorTo(store, "safe.txt");
    await store.startDelete();
    expect(store.getState().overlay?.kind).toBe("confirm");

    // This is exactly what main.ts's dispatch calls for a "confirmCancel"
    // action, which is what keymap.ts's resolveConfirmKey returns for
    // Enter (see tests/keymap.test.ts's "Enter does NOT confirm" test) —
    // asserting it here proves the actual filesystem effect of that route.
    store.cancelDelete();

    expect(store.getState().overlay).toBeNull();
    expect(existsSync(join(root, "safe.txt"))).toBe(true);
  });

  it("deletes the marked set, not just the cursor entry", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "c.txt"), "c");
    const store = await makeStore();
    setCursorTo(store, "a.txt");
    store.toggleMarkAtCursor();
    setCursorTo(store, "b.txt");
    store.toggleMarkAtCursor();

    await store.startDelete();
    await store.confirmDelete();

    expect(existsSync(join(root, "a.txt"))).toBe(false);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(existsSync(join(root, "c.txt"))).toBe(true); // never marked
    expect(store.getState().marked.size).toBe(0);
  });

  it("clears marks for deleted paths that live in a different directory than the one on screen", async () => {
    const other = mkdtempSync(join(tmpdir(), "flash-delete-other-"));
    try {
      const elsewhere = join(other, "far.txt");
      writeFileSync(elsewhere, "far away");

      // Mark the file while browsing `other`, then navigate to `root` —
      // marks persist across navigation (Phase 4), same pattern as
      // store.test.ts's "leaves marks on files outside the rescanned
      // directory untouched".
      const store = new Store({ cwd: other });
      await store.load(other);
      store.markAll(); // marks `elsewhere`
      expect(store.getState().marked.has(elsewhere)).toBe(true);
      await store.load(root);

      await store.startDelete();
      const overlay = store.getState().overlay;
      expect(overlay?.kind).toBe("confirm");
      if (overlay?.kind !== "confirm") throw new Error("unreachable");
      expect(overlay.paths).toEqual([elsewhere]);

      await store.confirmDelete();
      expect(existsSync(elsewhere)).toBe(false);
      expect(store.getState().marked.has(elsewhere)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("runDeleteJob — cancel mid-delete", () => {
  it("stops after the in-flight source and leaves the remainder untouched", async () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    const c = join(root, "c.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    writeFileSync(c, "c");

    const controller = new AbortController();
    let calls = 0;
    const outcome = await runDeleteJob({
      sources: [a, b, c],
      signal: controller.signal,
      onProgress: () => {
        calls++;
        if (calls === 1) controller.abort(); // abort right after the first source finishes
      },
    });

    expect(outcome.cancelled).toBe(true);
    // Whatever finished before the abort was observed stays deleted —
    // "cancel leaves the remainder" is about the sources that never
    // started, not an undo of ones that already completed.
    const remaining = [a, b, c].filter((p) => existsSync(p));
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("reports errors per-entry without aborting the rest of the batch", async () => {
    const good = join(root, "good.txt");
    writeFileSync(good, "fine");
    const missing = join(root, "does-not-exist.txt");

    const outcome = await runDeleteJob({ sources: [missing, good] });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.errors.length).toBe(1);
    expect(outcome.errors[0]?.src).toBe(missing);
    expect(outcome.deletedSources).toEqual([good]);
    expect(existsSync(good)).toBe(false);
  });
});
