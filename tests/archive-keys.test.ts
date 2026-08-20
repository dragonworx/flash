// tests/archive-keys.test.ts — the `z` (zip) and `u` (extract) keys end to
// end through state/store.ts: the prompt overlay, conflict resolution via
// uniqueName(), the shared job queue/progress overlay, and cancellation.
// Fixtures live under the system temp dir and are cleaned up.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listZip } from "../src/fsapi/archive/zip.ts";
import { isBusy } from "../src/fsapi/ops/queue.ts";
import { Store } from "../src/state/store.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "flash-archive-keys-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeLoadedStore(): Promise<Store> {
  await writeFile(join(workDir, "one.txt"), "one");
  await writeFile(join(workDir, "two.txt"), "two");
  const store = new Store({ cwd: workDir });
  await store.load(workDir);
  return store;
}

describe("z — startArchive + submitPrompt(mode: archive)", () => {
  it("zips the marked entries into the current directory under the typed name", async () => {
    const store = await makeLoadedStore();
    const names = store.visibleEntries().map((e) => e.name);
    for (const name of ["one.txt", "two.txt"]) {
      store.setCursorIndex(names.indexOf(name));
      store.toggleMarkAtCursor();
    }
    // toggleMarkAtCursor advances the cursor — re-derive marks directly
    // rather than depending on where the cursor landed.
    expect(store.getState().marked.size).toBe(2);

    store.startArchive();
    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("expected prompt overlay");
    expect(overlay.mode).toBe("archive");
    expect(overlay.value).toBe("archive.zip"); // 2 targets -> generic suggested name

    await store.submitPrompt();
    expect(store.getState().overlay).toBeNull();

    const zipPath = join(workDir, "archive.zip");
    const entries = await listZip(zipPath);
    const names2 = entries.map((e) => e.name).sort();
    expect(names2).toEqual(["one.txt", "two.txt"]);
  });

  it("suggests <name>.zip for a single target", async () => {
    const store = await makeLoadedStore();
    const idx = store.visibleEntries().findIndex((e) => e.name === "one.txt");
    store.setCursorIndex(idx);
    store.startArchive();
    const overlay = store.getState().overlay;
    if (overlay?.kind !== "prompt") throw new Error("expected prompt overlay");
    expect(overlay.value).toBe("one.txt.zip");
  });

  it("resolves a name collision via uniqueName() instead of refusing", async () => {
    const store = await makeLoadedStore();
    await writeFile(join(workDir, "existing.zip"), "not really a zip");
    const idx = store.visibleEntries().findIndex((e) => e.name === "one.txt");
    store.setCursorIndex(idx);
    store.startArchive();
    // Overwrite the suggested value with a name that collides.
    const overlay = store.getState().overlay;
    if (overlay?.kind !== "prompt") throw new Error("expected prompt overlay");
    overlay.value = "existing.zip";
    overlay.cursor = overlay.value.length;

    await store.submitPrompt();
    expect(store.getState().overlay).toBeNull();
    // The collision was resolved, not refused: the original file is
    // untouched and a new "existing 2.zip" was created alongside it.
    const originalContent = await readFile(
      join(workDir, "existing.zip"),
      "utf8",
    );
    expect(originalContent).toBe("not really a zip");
    const entries = await listZip(join(workDir, "existing 2.zip"));
    expect(entries.map((e) => e.name)).toEqual(["one.txt"]);
  });

  it("refuses (nothing to zip) when nothing is marked and the cursor is on '..'", async () => {
    const store = await makeLoadedStore();
    store.moveCursorTo("home"); // the ".." row
    store.startArchive();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().message?.text).toBe("nothing to zip");
  });
});

describe("u — startExtract", () => {
  async function makeStoreWithArchive(): Promise<{
    store: Store;
    zipName: string;
  }> {
    const srcRoot = join(workDir, "payload");
    await mkdir(srcRoot);
    await writeFile(join(srcRoot, "inside.txt"), "inside");
    const { createZip } = await import("../src/fsapi/archive/zip.ts");
    await createZip(join(workDir, "bundle.zip"), [srcRoot]);
    await rm(srcRoot, { recursive: true, force: true }); // isolate: only the zip remains

    const store = new Store({ cwd: workDir });
    await store.load(workDir);
    return { store, zipName: "bundle.zip" };
  }

  it("extracts into a new subdirectory named after the archive", async () => {
    const { store, zipName } = await makeStoreWithArchive();
    const idx = store.visibleEntries().findIndex((e) => e.name === zipName);
    store.setCursorIndex(idx);
    await store.startExtract();

    expect(store.getState().overlay).toBeNull();
    const content = await readFile(
      join(workDir, "bundle", "payload", "inside.txt"),
      "utf8",
    );
    expect(content).toBe("inside");
  });

  it("conflict-resolves the destination subdirectory name", async () => {
    const { store, zipName } = await makeStoreWithArchive();
    await mkdir(join(workDir, "bundle")); // pre-occupy the natural name
    const idx = store.visibleEntries().findIndex((e) => e.name === zipName);
    store.setCursorIndex(idx);
    await store.startExtract();

    const content = await readFile(
      join(workDir, "bundle 2", "payload", "inside.txt"),
      "utf8",
    );
    expect(content).toBe("inside");
  });

  it("refuses with a clear message when the cursor is not on a zip file", async () => {
    await writeFile(join(workDir, "plain.txt"), "x");
    const store = new Store({ cwd: workDir });
    await store.load(workDir);
    const idx = store.visibleEntries().findIndex((e) => e.name === "plain.txt");
    store.setCursorIndex(idx);
    await store.startExtract();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().message?.text).toBe("not a zip archive");
  });

  it("is cancellable via cancelOperation(), same abort wiring as paste/delete", async () => {
    const srcRoot = join(workDir, "big-payload");
    await mkdir(srcRoot);
    // Large + incompressible so the streaming extraction spans multiple
    // chunks — same reasoning as tests/zip.test.ts's cancellation test.
    const { randomFillSync } = await import("node:crypto");
    const big = Buffer.allocUnsafe(6 * 1024 * 1024);
    for (let off = 0; off < big.length; off += 65536) {
      randomFillSync(big, off, Math.min(65536, big.length - off));
    }
    await writeFile(join(srcRoot, "big.bin"), big);
    const { createZip } = await import("../src/fsapi/archive/zip.ts");
    await createZip(join(workDir, "heavy.zip"), [srcRoot]);
    await rm(srcRoot, { recursive: true, force: true });

    const store = new Store({ cwd: workDir });
    await store.load(workDir);
    const idx = store.visibleEntries().findIndex((e) => e.name === "heavy.zip");
    store.setCursorIndex(idx);

    const extractPromise = store.startExtract();
    // Cancel as soon as the progress overlay actually appears with any
    // bytes moved.
    await new Promise<void>((resolvePromise) => {
      const unsubscribe = store.subscribe(() => {
        const overlay = store.getState().overlay;
        if (overlay?.kind === "progress" && overlay.bytesDone > 0) {
          unsubscribe();
          store.cancelOperation();
          resolvePromise();
        }
      });
    });
    await extractPromise;

    expect(store.getState().overlay).toBeNull();
    expect(store.getState().message?.text).toContain("cancelled");
    expect(isBusy()).toBe(false);
  });
});
