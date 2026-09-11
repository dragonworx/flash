// tests/store.test.ts — state/store.ts: navigation (every real move lands
// the cursor on the synthetic ".." row so repeated up-navigation is fast),
// hidden-file toggling, and sort cycling. Runs against a throwaway temp
// tree rather than tests/fixtures/sample, since it needs nested
// directories the committed fixture deliberately keeps shallow.
//
// The "Phase 4: selection and clipboard" section near the bottom uses its
// own, wider six-file fixture — range-extend needs enough entries to
// reverse direction past its anchor without running off either edge.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "flash-store-test-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  writeFileSync(join(root, "alpha", "leaf.txt"), "leaf");
  writeFileSync(join(root, "top.txt"), "top");
  writeFileSync(join(root, ".dotfile"), "dot");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeLoadedStore(cwd: string = root): Promise<Store> {
  const store = new Store({ cwd });
  await store.load(cwd);
  return store;
}

describe("Store.load", () => {
  it("lands the cursor on the synthetic '..' row", async () => {
    const store = await makeLoadedStore();
    const list = store.visibleEntries();
    expect(list[0]?.name).toBe(".."); // parent row always first
    expect(store.getState().cursor).toBe(0);
  });

  it("excludes dotfiles from itemCount and visibleEntries by default", async () => {
    const store = await makeLoadedStore();
    expect(store.itemCount()).toBe(3); // alpha, beta, top.txt — not .dotfile
    expect(store.visibleEntries().some((e) => e.name === ".dotfile")).toBe(
      false,
    );
  });
});

describe("Store.selectedSize", () => {
  it("falls back to the entry under the cursor when nothing is marked", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.setCursorIndex(idx);
    expect(store.selectedSize()).toBe(3); // "top"
  });

  it("is 0 for a directory right away, then fills in with its recursive total", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "alpha");
    store.setCursorIndex(idx);
    // `entry.size` there is the raw inode size, not a total — the real
    // total comes from `load()`'s background batch walk over the whole
    // listing (see `Store.scheduleDirSizeScan`), so it isn't available on
    // the same tick.
    expect(store.selectedSize()).toBe(0);
    await Bun.sleep(300);
    expect(store.selectedSize()).toBe(4); // alpha/leaf.txt, contents "leaf"
  });

  it("sums marked files immediately and marked directories once their walk resolves", async () => {
    const store = await makeLoadedStore();
    const list = store.visibleEntries();
    for (const name of ["alpha", "top.txt"]) {
      store.setCursorIndex(list.findIndex((e) => e.name === name));
      store.toggleMarkAtCursor();
    }
    expect(store.selectedSize()).toBe(3); // "top" only — alpha not resolved yet
    await Bun.sleep(300);
    expect(store.selectedSize()).toBe(7); // "top" (3) + alpha/leaf.txt (4)
  });

  it("is 0 when the cursor is on the synthetic '..' row and nothing is marked", async () => {
    const store = await makeLoadedStore();
    store.moveCursorTo("home");
    expect(store.selectedSize()).toBe(0);
  });

  it("reflects a selection change immediately once the batch scan has already resolved", async () => {
    const store = await makeLoadedStore();
    const list = store.visibleEntries();
    store.setCursorIndex(list.findIndex((e) => e.name === "alpha"));
    await Bun.sleep(300); // let the whole-listing batch scan resolve
    store.setCursorIndex(list.findIndex((e) => e.name === "top.txt"));
    // No further delay needed — alpha's cached total simply isn't part of
    // this selection.
    expect(store.selectedSize()).toBe(3);
  });
});

describe("Store.dirSizes", () => {
  it("fills in every directory in the listing, not just the selection", async () => {
    const store = await makeLoadedStore();
    await Bun.sleep(300);
    const list = store.visibleEntries();
    const alphaPath = list.find((e) => e.name === "alpha")?.path ?? "";
    const betaPath = list.find((e) => e.name === "beta")?.path ?? "";
    expect(store.dirSizes().get(alphaPath)).toBe(4); // alpha/leaf.txt
    expect(store.dirSizes().get(betaPath)).toBe(0); // beta is empty
  });

  it("reuses a cached total when the same directory is revisited, with no further delay", async () => {
    const store = await makeLoadedStore();
    await Bun.sleep(300);
    const alphaPath =
      store.visibleEntries().find((e) => e.name === "alpha")?.path ?? "";
    expect(store.dirSizes().get(alphaPath)).toBe(4);

    await store.load(join(root, "alpha"));
    await store.load(root);
    expect(store.dirSizes().get(alphaPath)).toBe(4);
  });

  it("drops a rescanned directory's own cached total so it's recomputed", async () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "flash-store-dirsize-test-"));
    mkdirSync(join(scanRoot, "sub"));
    writeFileSync(join(scanRoot, "sub", "a.txt"), "a"); // 1 byte
    try {
      const store = await makeLoadedStore(scanRoot);
      await Bun.sleep(300);
      const subPath =
        store.visibleEntries().find((e) => e.name === "sub")?.path ?? "";
      expect(store.dirSizes().get(subPath)).toBe(1);

      writeFileSync(join(scanRoot, "sub", "b.txt"), "bb"); // +2 bytes
      await store.refresh(scanRoot);
      await Bun.sleep(300);
      expect(store.dirSizes().get(subPath)).toBe(3);
    } finally {
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });
});

describe("Store navigation", () => {
  it("enter() descends into the directory under the cursor", async () => {
    const store = await makeLoadedStore();
    // cursor starts on the first real entry; find "alpha" explicitly for
    // a test that doesn't depend on sort order.
    const idx = store.visibleEntries().findIndex((e) => e.name === "alpha");
    store.moveCursorTo("home");
    store.moveCursor(idx);
    await store.enter();
    expect(store.getState().cwd).toBe(join(root, "alpha"));
  });

  it("up() lands the cursor on the synthetic '..' row, for rapid backtracking", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "beta");
    store.moveCursorTo("home");
    store.moveCursor(idx);
    await store.enter();
    expect(store.getState().cwd).toBe(join(root, "beta"));

    await store.up();
    expect(store.getState().cwd).toBe(root);
    expect(store.getState().cursor).toBe(0);
    const current = store.visibleEntries()[store.getState().cursor];
    expect(current?.name).toBe("..");
  });

  it("up() at the filesystem root is a no-op", async () => {
    const store = await makeLoadedStore("/");
    const before = store.getState().cwd;
    await store.up();
    expect(store.getState().cwd).toBe(before);
  });

  it("selecting the '..' row goes up, same as up()", async () => {
    const store = await makeLoadedStore(join(root, "alpha"));
    store.moveCursorTo("home"); // the ".." row
    await store.enter();
    expect(store.getState().cwd).toBe(root);
  });

  it("entering a plain file is a no-op (read-only browsing this phase)", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.moveCursorTo("home");
    store.moveCursor(idx);
    await store.enter();
    expect(store.getState().cwd).toBe(root);
  });
});

describe("Store.toggleHidden", () => {
  it("reveals dotfiles and keeps the cursor on the same entry", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.moveCursorTo("home");
    store.moveCursor(idx);
    const before = store.visibleEntries()[store.getState().cursor]?.name;

    store.toggleHidden();
    expect(store.itemCount()).toBe(4);
    expect(store.visibleEntries().some((e) => e.name === ".dotfile")).toBe(
      true,
    );
    expect(store.visibleEntries()[store.getState().cursor]?.name).toBe(before);
  });
});

describe("Store.cycleSort / toggleSortReverse", () => {
  it("cycles through name -> size -> mtime -> extension -> name", async () => {
    const store = await makeLoadedStore();
    expect(store.getState().sort.key).toBe("name");
    store.cycleSort();
    expect(store.getState().sort.key).toBe("size");
    store.cycleSort();
    expect(store.getState().sort.key).toBe("mtime");
    store.cycleSort();
    expect(store.getState().sort.key).toBe("extension");
    store.cycleSort();
    expect(store.getState().sort.key).toBe("name");
  });

  it("toggles reverse independently of the sort key", async () => {
    const store = await makeLoadedStore();
    expect(store.getState().sort.reverse).toBe(false);
    store.toggleSortReverse();
    expect(store.getState().sort.reverse).toBe(true);
  });
});

describe("Store.load error handling", () => {
  it("surfaces a readdir failure as scanError instead of throwing", async () => {
    const store = new Store({ cwd: root });
    await store.load(join(root, "does-not-exist"));
    expect(store.getState().scanError).not.toBeNull();
    // No real entries, but the synthetic ".." row still lets the user
    // navigate back out of the directory that failed to read.
    const list = store.visibleEntries();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("..");
  });
});

// ── Phase 4: selection and clipboard ──
//
// A separate, wider fixture (six numbered files, sorted deterministically by
// name) so range-extend has enough room to reverse direction past its
// anchor without running off either edge.

let selRoot: string;
const SEL_NAMES = ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"];

beforeAll(() => {
  selRoot = mkdtempSync(join(tmpdir(), "flash-store-sel-test-"));
  for (const name of SEL_NAMES) writeFileSync(join(selRoot, name), name);
});

afterAll(() => {
  rmSync(selRoot, { recursive: true, force: true });
});

/** cursor lands on the synthetic ".." row first; step past it onto f1.txt. */
async function makeSelStore(): Promise<Store> {
  const store = new Store({ cwd: selRoot });
  await store.load(selRoot);
  return store;
}

/** Index of `name` within `visibleEntries()` (".." included at 0). */
function indexOf(store: Store, name: string): number {
  return store.visibleEntries().findIndex((e) => e.name === name);
}

describe("Store.toggleMarkAtCursor", () => {
  it("marks the entry under the cursor and advances the cursor by one", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f2.txt"));
    store.toggleMarkAtCursor();
    const f2 = store.visibleEntries()[indexOf(store, "f2.txt")];
    expect(f2).toBeDefined();
    expect(store.getState().marked.has(f2?.path ?? "")).toBe(true);
    expect(store.getState().cursor).toBe(indexOf(store, "f2.txt") + 1);
  });

  it("toggles back off on a second press, without moving the cursor a second time", async () => {
    const store = await makeSelStore();
    const idx = indexOf(store, "f3.txt");
    store.setCursorIndex(idx);
    const path = store.visibleEntries()[idx]?.path ?? "";
    store.toggleMarkAtCursor(); // marks f3, cursor -> f4
    expect(store.getState().marked.has(path)).toBe(true);
    store.setCursorIndex(idx); // back onto f3
    store.toggleMarkAtCursor(); // unmarks f3, cursor -> f4 again
    expect(store.getState().marked.has(path)).toBe(false);
  });

  it("never marks the synthetic '..' row", async () => {
    const store = await makeSelStore();
    store.moveCursorTo("home"); // the ".." row
    store.toggleMarkAtCursor();
    expect(store.getState().marked.size).toBe(0);
  });
});

describe("Store.extendSelection", () => {
  it("marks the inclusive range from the anchor to the cursor", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f2.txt")); // anchor
    store.extendSelection("down"); // -> f3
    store.extendSelection("down"); // -> f4
    const marked = store.getState().marked;
    for (const name of ["f2.txt", "f3.txt", "f4.txt"]) {
      const path = store.visibleEntries()[indexOf(store, name)]?.path ?? "";
      expect(marked.has(path)).toBe(true);
    }
    // Outside the range: untouched.
    const f5path = store.visibleEntries()[indexOf(store, "f5.txt")]?.path ?? "";
    expect(marked.has(f5path)).toBe(false);
  });

  it("un-marks the far side when the direction reverses back past the anchor", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f4.txt")); // anchor
    store.extendSelection("down"); // range [f4, f5]
    store.extendSelection("down"); // range [f4, f6]
    // Reverse: walk back up past the anchor to f2.
    store.extendSelection("up"); // f5
    store.extendSelection("up"); // f4 (== anchor)
    store.extendSelection("up"); // f3
    store.extendSelection("up"); // f2 — anchor now the *high* end
    const marked = store.getState().marked;
    for (const name of ["f2.txt", "f3.txt", "f4.txt"]) {
      const path = store.visibleEntries()[indexOf(store, name)]?.path ?? "";
      expect(marked.has(path)).toBe(true);
    }
    // f5 and f6 were marked by the initial downward extend but are outside
    // the final [f2, f4] range — the reversal must have un-marked them.
    for (const name of ["f5.txt", "f6.txt"]) {
      const path = store.visibleEntries()[indexOf(store, name)]?.path ?? "";
      expect(marked.has(path)).toBe(false);
    }
  });

  it("leaves a Tab-placed mark outside the range alone", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f6.txt"));
    store.toggleMarkAtCursor(); // Tab-marks f6.txt independently
    const f6path = store.visibleEntries()[indexOf(store, "f6.txt")]?.path ?? "";

    store.setCursorIndex(indexOf(store, "f1.txt"));
    store.extendSelection("down"); // range [f1, f2], nowhere near f6

    expect(store.getState().marked.has(f6path)).toBe(true);
  });

  it("starts a fresh anchor after an unrelated cursor move", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f2.txt"));
    store.extendSelection("down"); // range [f2, f3]
    store.moveCursor(1); // plain move: f3 -> f4, resets the anchor
    store.extendSelection("down"); // new anchor at f4; range [f4, f5]
    const marked = store.getState().marked;
    const f5path = store.visibleEntries()[indexOf(store, "f5.txt")]?.path ?? "";
    expect(marked.has(f5path)).toBe(true);
    // f2/f3 remain marked from the first extend — a fresh anchor doesn't
    // retroactively unmark an unrelated, already-completed range.
    const f2path = store.visibleEntries()[indexOf(store, "f2.txt")]?.path ?? "";
    expect(marked.has(f2path)).toBe(true);
  });
});

describe("Store.markAll", () => {
  it("marks every real entry and never the synthetic '..' row", async () => {
    const store = await makeSelStore();
    store.markAll();
    const marked = store.getState().marked;
    expect(marked.size).toBe(SEL_NAMES.length);
    for (const name of SEL_NAMES) {
      const path = store.visibleEntries()[indexOf(store, name)]?.path ?? "";
      expect(marked.has(path)).toBe(true);
    }
  });
});

describe("Store.clearMarks", () => {
  it("empties the marked set", async () => {
    const store = await makeSelStore();
    store.markAll();
    expect(store.getState().marked.size).toBeGreaterThan(0);
    store.clearMarks();
    expect(store.getState().marked.size).toBe(0);
  });

  it("cancels a staged cut, even one staged via the cursor with no marks", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f5.txt"));
    store.cut();
    expect(store.getState().clipboard?.mode).toBe("cut");
    store.clearMarks();
    expect(store.getState().clipboard).toBeNull();
  });

  it("clears a staged copy too, so the first Escape never navigates while anything is selected", async () => {
    const store = await makeSelStore();
    store.markAll();
    store.copy();
    expect(store.getState().clipboard?.mode).toBe("copy");
    store.clearMarks();
    expect(store.getState().marked.size).toBe(0);
    expect(store.getState().clipboard).toBeNull();
  });
});

describe("Store.pruneMarks", () => {
  it("drops marks for paths no longer present, keeps the rest", async () => {
    const store = await makeSelStore();
    store.markAll();
    const f1path = store.visibleEntries()[indexOf(store, "f1.txt")]?.path ?? "";
    const f2path = store.visibleEntries()[indexOf(store, "f2.txt")]?.path ?? "";
    // Simulate a rescan where f2..f6 vanished — only f1 still exists.
    store.pruneMarks([f1path]);
    expect(store.getState().marked.has(f1path)).toBe(true);
    expect(store.getState().marked.has(f2path)).toBe(false);
    expect(store.getState().marked.size).toBe(1);
  });
});

describe("Store clipboard (copy/cut)", () => {
  it("stages the marked set, in mark order not insertion-dependent order", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f1.txt"));
    store.extendSelection("down"); // marks f1, f2
    store.copy();
    const clipboard = store.getState().clipboard;
    expect(clipboard?.mode).toBe("copy");
    expect(clipboard?.paths).toHaveLength(2);
    const f1path = store.visibleEntries()[indexOf(store, "f1.txt")]?.path;
    const f2path = store.visibleEntries()[indexOf(store, "f2.txt")]?.path;
    expect(clipboard?.paths).toContain(f1path);
    expect(clipboard?.paths).toContain(f2path);
  });

  it("falls back to the entry under the cursor when nothing is marked", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f5.txt"));
    store.cut();
    const clipboard = store.getState().clipboard;
    const f5path = store.visibleEntries()[indexOf(store, "f5.txt")]?.path ?? "";
    expect(clipboard).toEqual({ mode: "cut", paths: [f5path] });
  });

  it("does not touch disk — the source file still exists after a cut is staged", async () => {
    const store = await makeSelStore();
    const idx = indexOf(store, "f1.txt");
    store.setCursorIndex(idx);
    const path = store.visibleEntries()[idx]?.path ?? "";
    store.cut();
    expect(existsSync(path)).toBe(true);
  });

  it("does nothing when the cursor is on the synthetic '..' row and nothing is marked", async () => {
    const store = await makeSelStore();
    store.moveCursorTo("home"); // the ".." row
    store.copy();
    expect(store.getState().clipboard).toBeNull();
  });
});

describe("Store.pathClipboardText (Ctrl+C / Ctrl+Alt+C)", () => {
  it("joins the marked set one path per line for the newline separator", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f1.txt"));
    store.extendSelection("down"); // marks f1, f2
    const text = store.pathClipboardText("newline");
    expect(text).not.toBeNull();
    const lines = text?.split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines).toContain(
      store.visibleEntries()[indexOf(store, "f1.txt")]?.path ?? "",
    );
    expect(lines).toContain(
      store.visibleEntries()[indexOf(store, "f2.txt")]?.path ?? "",
    );
  });

  it("joins on a single space for the space separator", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f1.txt"));
    store.extendSelection("down"); // marks f1, f2
    const text = store.pathClipboardText("space");
    expect(text).not.toBeNull();
    expect(text).not.toContain("\n");
    expect(text?.split(" ")).toHaveLength(2);
  });

  it("falls back to the entry under the cursor when nothing is marked", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f5.txt"));
    const f5path = store.visibleEntries()[indexOf(store, "f5.txt")]?.path ?? "";
    expect(store.pathClipboardText("newline")).toBe(f5path);
  });

  it("returns null on the synthetic '..' row with nothing marked", async () => {
    const store = await makeSelStore();
    store.moveCursorTo("home"); // the ".." row
    expect(store.pathClipboardText("newline")).toBeNull();
    expect(store.getState().message?.text).toBe("nothing to copy");
  });

  it("reports the copy through the status message", async () => {
    const store = await makeSelStore();
    store.setCursorIndex(indexOf(store, "f5.txt"));
    store.pathClipboardText("newline");
    expect(store.getState().message?.text).toBe(
      "1 path copied to the system clipboard",
    );
  });

  it("shortens paths under the user's home directory to a ~/ prefix", async () => {
    const store = await makeSelStore();
    // Marked paths are joined verbatim (no existence check), so synthetic
    // paths under the real home dir exercise the shortening without any
    // fixture needing to live there. Bun's `os.homedir()` ignores a
    // runtime-mutated $HOME, so faking home via env is not an option.
    store.getState().marked.add(join(homedir(), "alpha.txt"));
    store.getState().marked.add(join(homedir(), "beta.txt"));
    expect(store.pathClipboardText("newline")).toBe("~/alpha.txt\n~/beta.txt");
  });
});

describe("Store.goHome", () => {
  it("navigates to the user's home directory", async () => {
    const store = await makeSelStore();
    await store.goHome();
    expect(store.getState().cwd).toBe(homedir());
  });
});

// ── Phase 5a: paste ──
//
// A separate destination directory per test (a fresh mkdtemp under
// `pasteRoot`) rather than sharing `selRoot`, since paste actually writes
// to disk and each test wants a clean destination to assert against.

describe("Store.paste", () => {
  it("copies the clipboard into the current directory and clears the clipboard", async () => {
    const dest = mkdtempSync(join(tmpdir(), "flash-store-paste-dest-"));
    try {
      const store = await makeSelStore();
      store.setCursorIndex(indexOf(store, "f1.txt"));
      store.copy();
      const clipboard = store.getState().clipboard;
      expect(clipboard).not.toBeNull();

      // Simulate navigating to `dest` without a real directory rescan
      // dependency: load() is the same path `enter()`/`up()` use.
      await store.load(dest);
      await store.paste();

      expect(existsSync(join(dest, "f1.txt"))).toBe(true);
      expect(store.getState().clipboard).toBeNull();
      expect(store.getState().overlay).toBeNull();
      expect(store.getState().message?.kind).toBe("info");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("moves a cut clipboard into the current directory, clearing the clipboard and marks on the moved source (Phase 5b)", async () => {
    // A dedicated source dir, not `selRoot` — this test deletes the source
    // for real (that's the whole point of cut/move), and `selRoot` is
    // shared read-mostly fixture data other tests in this file still rely
    // on by name.
    const src = mkdtempSync(join(tmpdir(), "flash-store-cut-src-"));
    const dest = mkdtempSync(join(tmpdir(), "flash-store-paste-dest-"));
    try {
      writeFileSync(join(src, "cutme.txt"), "cut me");
      const store = new Store({ cwd: src });
      await store.load(src);
      const idx = indexOf(store, "cutme.txt");
      store.setCursorIndex(idx);
      const srcPath = store.visibleEntries()[idx]?.path ?? "";
      store.toggleMarkAtCursor(); // marked, so we can prove the mark is cleared too
      store.cut();
      expect(store.getState().clipboard).toEqual({
        mode: "cut",
        paths: [srcPath],
      });

      await store.load(dest);
      await store.paste();

      expect(existsSync(join(dest, "cutme.txt"))).toBe(true);
      expect(existsSync(srcPath)).toBe(false);
      expect(store.getState().clipboard).toBeNull();
      expect(store.getState().marked.has(srcPath)).toBe(false);
      expect(store.getState().overlay).toBeNull();
      expect(store.getState().message?.text).toContain("moved 1 item");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("reports and clears the clipboard when every staged path has vanished", async () => {
    const dest = mkdtempSync(join(tmpdir(), "flash-store-paste-dest-"));
    const gone = mkdtempSync(join(tmpdir(), "flash-store-paste-gone-"));
    const goneFile = join(gone, "vanished.txt");
    writeFileSync(goneFile, "x");
    try {
      const store = await makeSelStore();
      await store.load(gone);
      store.setCursorIndex(1); // the only real entry
      store.copy();
      rmSync(goneFile); // vanish it before paste runs

      await store.load(dest);
      await store.paste();

      expect(store.getState().clipboard).toBeNull();
      expect(readdirSync(dest)).toEqual([]);
      expect(store.getState().message?.kind).toBe("error");
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(gone, { recursive: true, force: true });
    }
  });

  it("does nothing and reports an empty clipboard", async () => {
    const store = await makeSelStore();
    await store.paste();
    expect(store.getState().message?.text).toBe("clipboard is empty");
  });
});

// ── Store.refresh (Phase 6: live updates) ──
//
// `refresh()` is the watcher's entry point — a real fs.watch is not needed
// to test it, since the interesting behavior is entirely in how it
// re-derives cursor and marks from a fresh scan, not in fs.watch's own
// timing (that lives in tests/watch.test.ts). Each test gets its own
// throwaway directory so mutating it mid-test never bleeds into another.

describe("Store.refresh", () => {
  it("keeps the cursor on the same path when new entries are added above it in sort order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-store-refresh-test-"));
    try {
      writeFileSync(join(dir, "mango.txt"), "m");
      writeFileSync(join(dir, "zebra.txt"), "z");
      const store = new Store({ cwd: dir });
      await store.load(dir);

      const idx = store
        .visibleEntries()
        .findIndex((e) => e.name === "zebra.txt");
      store.setCursorIndex(idx);
      const zebraPath = store.visibleEntries()[store.getState().cursor]?.path;
      expect(zebraPath).toBeDefined();

      // "apple" and "banana" both sort ahead of "zebra", so a naive
      // index-based cursor would now be pointing at the wrong file.
      writeFileSync(join(dir, "apple.txt"), "a");
      writeFileSync(join(dir, "banana.txt"), "b");
      await store.refresh(dir);

      const after = store.visibleEntries()[store.getState().cursor];
      expect(after?.name).toBe("zebra.txt");
      expect(after?.path).toBe(zebraPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the clamped numeric index when the cursor's entry is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-store-refresh-test-"));
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      writeFileSync(join(dir, "b.txt"), "b");
      writeFileSync(join(dir, "c.txt"), "c");
      const store = new Store({ cwd: dir });
      await store.load(dir);

      const idx = store.visibleEntries().findIndex((e) => e.name === "b.txt");
      store.setCursorIndex(idx);

      rmSync(join(dir, "b.txt"));
      await store.refresh(dir);

      // b.txt is gone; the cursor should land near where it was (clamped
      // into the now-shorter list), not snap back to the top.
      const list = store.visibleEntries();
      expect(store.getState().cursor).toBeLessThan(list.length);
      expect(store.getState().cursor).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes marks for files deleted from the rescanned directory and reports the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-store-refresh-test-"));
    try {
      writeFileSync(join(dir, "keep.txt"), "k");
      writeFileSync(join(dir, "gone.txt"), "g");
      const store = new Store({ cwd: dir });
      await store.load(dir);
      store.markAll();
      expect(store.getState().marked.size).toBe(2);

      rmSync(join(dir, "gone.txt"));
      await store.refresh(dir);

      const marked = store.getState().marked;
      expect(marked.size).toBe(1);
      expect([...marked].every((p) => p.endsWith("keep.txt"))).toBe(true);
      expect(store.getState().message?.text).toContain("1 mark");
      expect(store.getState().message?.text).toContain("dropped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves marks on files outside the rescanned directory untouched", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "flash-store-refresh-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "flash-store-refresh-b-"));
    try {
      const fileInA = join(dirA, "elsewhere.txt");
      writeFileSync(fileInA, "a");
      writeFileSync(join(dirB, "local.txt"), "b");

      const store = new Store({ cwd: dirA });
      await store.load(dirA);
      store.markAll(); // marks fileInA
      expect(store.getState().marked.has(fileInA)).toBe(true);

      await store.load(dirB); // navigate away — the mark on dirA's file persists
      expect(store.getState().marked.has(fileInA)).toBe(true);

      // Rescanning dirB must never touch a mark that lives in dirA — this
      // rescan has no information about dirA at all.
      await store.refresh(dirB);
      expect(store.getState().marked.has(fileInA)).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("does not disturb subsequent navigation's cursor placement", async () => {
    const root = mkdtempSync(join(tmpdir(), "flash-store-refresh-test-"));
    try {
      mkdirSync(join(root, "child"));
      writeFileSync(join(root, "child", "inner.txt"), "i");
      const store = new Store({ cwd: root });
      await store.load(root);

      const idx = store.visibleEntries().findIndex((e) => e.name === "child");
      store.setCursorIndex(idx);
      await store.enter();
      expect(store.getState().cwd).toBe(join(root, "child"));

      // A rescan of the child directory must not disturb where up()
      // lands the cursor afterward — the synthetic ".." row, as always.
      await store.refresh(join(root, "child"));
      await store.up();
      expect(store.getState().cwd).toBe(root);
      const current = store.visibleEntries()[store.getState().cursor];
      expect(current?.name).toBe("..");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Store: text preview (Enter on a plain file)", () => {
  it("Enter on a regular file opens the preview overlay with its contents", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.setCursorIndex(idx);
    await store.enter();
    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("preview");
    if (overlay?.kind === "preview") {
      expect(overlay.path).toBe(join(root, "top.txt"));
      expect(overlay.loading).toBe(false);
      expect(overlay.error).toBeNull();
      expect(
        overlay.lines
          .flat()
          .map((s) => s.text)
          .join(""),
      ).toContain("top");
    }
  });

  it("Enter on a directory still navigates instead of previewing", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "alpha");
    store.setCursorIndex(idx);
    await store.enter();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().cwd).toBe(join(root, "alpha"));
  });

  it("does not stack a preview on top of an already-open overlay", async () => {
    const store = await makeLoadedStore();
    store.startMkdir();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.setCursorIndex(idx);
    await store.enter();
    expect(store.getState().overlay?.kind).toBe("prompt"); // unchanged
  });

  it("previewScroll clamps within [0, maxScrollOffset] and is a no-op off the preview overlay", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.setCursorIndex(idx);
    await store.enter();

    store.previewScroll(-5, 10);
    expect(
      store.getState().overlay?.kind === "preview"
        ? store.getState().overlay
        : null,
    ).not.toBeNull();
    const overlay1 = store.getState().overlay;
    if (overlay1?.kind === "preview") expect(overlay1.scrollOffset).toBe(0);

    store.previewScroll(100, 10);
    const overlay2 = store.getState().overlay;
    if (overlay2?.kind === "preview") expect(overlay2.scrollOffset).toBe(10);

    store.cancelPreview();
    // No overlay open now — previewScroll must not throw or reopen one.
    expect(() => store.previewScroll(1, 10)).not.toThrow();
    expect(store.getState().overlay).toBeNull();
  });

  it("cancelPreview closes the overlay", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "top.txt");
    store.setCursorIndex(idx);
    await store.enter();
    expect(store.getState().overlay?.kind).toBe("preview");
    store.cancelPreview();
    expect(store.getState().overlay).toBeNull();
  });

  it("a broken symlink stays inert instead of opening a preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-store-preview-test-"));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync("does-not-exist", join(dir, "broken"));
      const store = new Store({ cwd: dir, showHidden: true });
      await store.load(dir);
      const idx = store.visibleEntries().findIndex((e) => e.name === "broken");
      store.setCursorIndex(idx);
      await store.enter();
      expect(store.getState().overlay).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Store: goto bookmarks", () => {
  let gotoHome: string;
  let originalGotoHome: string | undefined;

  beforeAll(() => {
    gotoHome = mkdtempSync(join(tmpdir(), "flash-store-goto-test-"));
    writeFileSync(
      join(gotoHome, "config.json"),
      JSON.stringify({ alpha: join(root, "alpha"), beta: join(root, "beta") }),
    );
    originalGotoHome = process.env.GOTO_HOME;
    process.env.GOTO_HOME = gotoHome;
  });

  afterAll(() => {
    if (originalGotoHome === undefined) {
      // biome-ignore lint/performance/noDelete: matches tests/config.test.ts
      delete process.env.GOTO_HOME;
    } else {
      process.env.GOTO_HOME = originalGotoHome;
    }
    rmSync(gotoHome, { recursive: true, force: true });
  });

  it("isBookmarked is true only for a bookmarked cwd", async () => {
    const store = await makeLoadedStore(join(root, "alpha"));
    expect(store.isBookmarked()).toBe(true);
    await store.load(root);
    expect(store.isBookmarked()).toBe(false);
  });

  it("bookmarkedPaths lists every bookmark's target", async () => {
    const store = await makeLoadedStore();
    const paths = store.bookmarkedPaths();
    expect(paths.has(join(root, "alpha"))).toBe(true);
    expect(paths.has(join(root, "beta"))).toBe(true);
    expect(paths.size).toBe(2);
  });

  it("startBookmarks opens the picker, pre-selecting the current bookmark", async () => {
    const store = await makeLoadedStore(join(root, "beta"));
    store.startBookmarks();
    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("bookmarks");
    if (overlay?.kind !== "bookmarks") return;
    expect(overlay.items).toEqual([
      { name: "alpha", path: join(root, "alpha") },
      { name: "beta", path: join(root, "beta") },
    ]);
    expect(overlay.items[overlay.cursor]?.name).toBe("beta");
  });

  it("startBookmarks sets a message and opens no overlay when there are none", async () => {
    const emptyGotoHome = mkdtempSync(
      join(tmpdir(), "flash-store-goto-empty-"),
    );
    const prev = process.env.GOTO_HOME;
    process.env.GOTO_HOME = emptyGotoHome;
    try {
      const store = await makeLoadedStore();
      store.startBookmarks();
      expect(store.getState().overlay).toBeNull();
      expect(store.getState().message?.text).toBe("no goto bookmarks found");
    } finally {
      process.env.GOTO_HOME = prev;
      rmSync(emptyGotoHome, { recursive: true, force: true });
    }
  });

  it("bookmarksMove clamps within the list, bookmarksMoveTo jumps to the ends", async () => {
    const store = await makeLoadedStore();
    store.startBookmarks();
    store.bookmarksMoveTo("home");
    expect((store.getState().overlay as { cursor: number }).cursor).toBe(0);
    store.bookmarksMove(-5);
    expect((store.getState().overlay as { cursor: number }).cursor).toBe(0);
    store.bookmarksMoveTo("end");
    expect((store.getState().overlay as { cursor: number }).cursor).toBe(1);
    store.bookmarksMove(5);
    expect((store.getState().overlay as { cursor: number }).cursor).toBe(1);
  });

  it("selectBookmark closes the overlay and navigates to the selected path", async () => {
    const store = await makeLoadedStore();
    store.startBookmarks();
    store.bookmarksMoveTo("home"); // "alpha"
    await store.selectBookmark();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().cwd).toBe(join(root, "alpha"));
  });

  it("closeBookmarks dismisses the picker without navigating", async () => {
    const store = await makeLoadedStore();
    store.startBookmarks();
    store.closeBookmarks();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().cwd).toBe(root);
  });
});
