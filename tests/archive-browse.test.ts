// tests/archive-browse.test.ts — state/store.ts's Phase 8 archive
// integration: entering a .zip sets state.archive, navigation stays inside
// the cached VFS tree, Esc/up leave the archive at its root (keymap.ts's
// Escape arm 3), and every write operation refuses while browsing inside
// one. Fixtures live under the system temp dir and are cleaned up.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEscape } from "../src/keymap.ts";
import { Store } from "../src/state/store.ts";

let workDir: string;
let realDir: string;
let zipPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "flash-archive-browse-test-"));
  realDir = join(workDir, "real");
  await mkdir(realDir);
  await writeFile(join(realDir, "plain.txt"), "hi");

  const srcRoot = join(workDir, "payload");
  await mkdir(join(srcRoot, "sub"), { recursive: true });
  await writeFile(join(srcRoot, "top.txt"), "top");
  await writeFile(join(srcRoot, "sub", "leaf.txt"), "leaf");

  const { createZip } = await import("../src/fsapi/archive/zip.ts");
  zipPath = join(realDir, "backup.zip");
  await createZip(zipPath, [srcRoot]);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function openArchive(): Promise<Store> {
  const store = new Store({ cwd: realDir });
  await store.load(realDir);
  const idx = store.visibleEntries().findIndex((e) => e.name === "backup.zip");
  store.setCursorIndex(idx);
  await store.enter();
  return store;
}

describe("entering an archive", () => {
  it("sets state.archive at its root without changing cwd", async () => {
    const store = await openArchive();
    const state = store.getState();
    expect(state.archive).toEqual({ zipPath, innerPath: "" });
    expect(state.cwd).toBe(realDir); // cwd never changes while browsing an archive
  });

  it("lists the archive's own root, not the real directory", async () => {
    const store = await openArchive();
    const names = store
      .visibleEntries()
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(["..", "payload"]);
  });

  it("descends into a nested inner directory on enter()", async () => {
    const store = await openArchive();
    const idx = store.visibleEntries().findIndex((e) => e.name === "payload");
    store.setCursorIndex(idx);
    await store.enter();
    expect(store.getState().archive?.innerPath).toBe("payload");

    const idx2 = store.visibleEntries().findIndex((e) => e.name === "sub");
    store.setCursorIndex(idx2);
    await store.enter();
    expect(store.getState().archive?.innerPath).toBe("payload/sub");
    expect(
      store
        .visibleEntries()
        .map((e) => e.name)
        .sort(),
    ).toEqual(["..", "leaf.txt"]);
  });

  it("entering a leaf file inside the archive is a no-op", async () => {
    const store = await openArchive();
    const idx = store.visibleEntries().findIndex((e) => e.name === "payload");
    store.setCursorIndex(idx);
    await store.enter();
    const fileIdx = store
      .visibleEntries()
      .findIndex((e) => e.name === "top.txt");
    store.setCursorIndex(fileIdx);
    await store.enter();
    expect(store.getState().archive?.innerPath).toBe("payload"); // unchanged
  });
});

describe("leaving an archive", () => {
  it("up() ascends within the archive before leaving it", async () => {
    const store = await openArchive();
    const idx = store.visibleEntries().findIndex((e) => e.name === "payload");
    store.setCursorIndex(idx);
    await store.enter();
    expect(store.getState().archive?.innerPath).toBe("payload");

    await store.up();
    expect(store.getState().archive).not.toBeNull();
    expect(store.getState().archive?.innerPath).toBe("");
    // Cursor lands on the synthetic ".." row, for rapid backtracking.
    const cursorEntry = store.visibleEntries()[store.getState().cursor];
    expect(cursorEntry?.name).toBe("..");
  });

  it("up() at the archive root leaves it and lands the cursor on the '..' row", async () => {
    const store = await openArchive();
    await store.up();
    const state = store.getState();
    expect(state.archive).toBeNull();
    expect(state.cwd).toBe(realDir);
    const cursorEntry = store.visibleEntries()[state.cursor];
    expect(cursorEntry?.name).toBe("..");
  });

  it("leaveArchive() is a no-op outside an archive", async () => {
    const store = new Store({ cwd: realDir });
    await store.load(realDir);
    store.leaveArchive();
    expect(store.getState().archive).toBeNull();
    expect(store.getState().cwd).toBe(realDir);
  });

  it("keymap's Escape resolves to leaveArchive at the archive root (arm 3)", async () => {
    const store = await openArchive();
    expect(resolveEscape(store.getState())).toEqual({ type: "leaveArchive" });
    store.leaveArchive();
    // Outside an archive with no marks/overlay, Escape falls through to "up".
    expect(resolveEscape(store.getState())).toEqual({ type: "up" });
  });

  it("Escape does NOT resolve to leaveArchive when nested inside the archive", async () => {
    const store = await openArchive();
    const idx = store.visibleEntries().findIndex((e) => e.name === "payload");
    store.setCursorIndex(idx);
    await store.enter();
    expect(resolveEscape(store.getState())).toEqual({ type: "up" });
  });
});

describe("write operations refuse inside an archive", () => {
  it("startRename refuses and leaves no overlay open", async () => {
    const store = await openArchive();
    store.startRename();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().message?.kind).toBe("error");
  });

  it("startMkdir refuses", async () => {
    const store = await openArchive();
    store.startMkdir();
    expect(store.getState().overlay).toBeNull();
  });

  it("startDelete refuses", async () => {
    const store = await openArchive();
    await store.startDelete();
    expect(store.getState().overlay).toBeNull();
  });

  it("startPermissions refuses", async () => {
    const store = await openArchive();
    store.startPermissions();
    expect(store.getState().overlay).toBeNull();
  });

  it("paste refuses even with something staged in the clipboard", async () => {
    const outerStore = new Store({ cwd: realDir });
    await outerStore.load(realDir);
    const idx = outerStore
      .visibleEntries()
      .findIndex((e) => e.name === "plain.txt");
    outerStore.setCursorIndex(idx);
    outerStore.copy();
    expect(outerStore.getState().clipboard).not.toBeNull();

    // Now enter the archive with clipboard already staged from outside it.
    const zipIdx = outerStore
      .visibleEntries()
      .findIndex((e) => e.name === "backup.zip");
    outerStore.setCursorIndex(zipIdx);
    await outerStore.enter();
    expect(outerStore.getState().archive).not.toBeNull();

    await outerStore.paste();
    expect(outerStore.getState().overlay).toBeNull(); // no progress overlay ever opened
    expect(outerStore.getState().message?.kind).toBe("error");
  });

  it("copy and cut refuse inside an archive", async () => {
    const store = await openArchive();
    const idx = store.visibleEntries().findIndex((e) => e.name === "payload");
    store.setCursorIndex(idx);
    store.copy();
    expect(store.getState().clipboard).toBeNull();
    store.cut();
    expect(store.getState().clipboard).toBeNull();
    expect(store.getState().message?.kind).toBe("error");
  });

  it("startArchive (z) refuses inside an archive", async () => {
    const store = await openArchive();
    store.startArchive();
    expect(store.getState().overlay).toBeNull();
  });

  it("startExtract (u) refuses inside an archive", async () => {
    const store = await openArchive();
    await store.startExtract();
    expect(store.getState().overlay).toBeNull();
  });
});
