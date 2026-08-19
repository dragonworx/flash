// tests/store.test.ts — state/store.ts: navigation, the per-directory
// cursor history that makes "up" land back on the directory you came from,
// hidden-file toggling, and sort cycling. Runs against a throwaway temp
// tree rather than tests/fixtures/sample, since it needs nested
// directories the committed fixture deliberately keeps shallow.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  it("lands the cursor on the first real entry, not the synthetic '..' row", async () => {
    const store = await makeLoadedStore();
    const list = store.visibleEntries();
    expect(list[0]?.name).toBe(".."); // parent row always first
    expect(store.getState().cursor).toBe(1);
  });

  it("excludes dotfiles from itemCount and visibleEntries by default", async () => {
    const store = await makeLoadedStore();
    expect(store.itemCount()).toBe(3); // alpha, beta, top.txt — not .dotfile
    expect(store.visibleEntries().some((e) => e.name === ".dotfile")).toBe(
      false,
    );
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

  it("up() lands the cursor back on the directory just left", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "beta");
    store.moveCursorTo("home");
    store.moveCursor(idx);
    await store.enter();
    expect(store.getState().cwd).toBe(join(root, "beta"));

    await store.up();
    expect(store.getState().cwd).toBe(root);
    const current = store.visibleEntries()[store.getState().cursor];
    expect(current?.name).toBe("beta");
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
