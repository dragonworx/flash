// tests/vfs.test.ts — fsapi/archive/vfs.ts: synthesizing directories from a
// flat zip member list, navigating nested inner paths, and the per-archive
// cache (and its mtime-based invalidation). Fixtures live under the system
// temp dir and are cleaned up in `afterEach`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveBasename,
  archiveChildInner,
  archiveEntriesAt,
  archiveEntryPath,
  archiveParentInner,
  isZipFile,
  loadArchiveTree,
} from "../src/fsapi/archive/vfs.ts";
import { createZip } from "../src/fsapi/archive/zip.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "flash-vfs-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function buildFixtureZip(): Promise<string> {
  const srcRoot = join(workDir, "src");
  // Deliberately flat: only files, no explicit directory members anywhere —
  // "a/b/c.txt" with nothing else describing "a/" or "a/b/" — since most
  // zip-creating tools skip directory entries. createZip() itself always
  // writes explicit dir members (see zip.test.ts's round-trip test), so to
  // exercise the *synthesis* path this fixture is built directly rather
  // than through createZip.
  await mkdir(join(srcRoot, "a", "b"), { recursive: true });
  await writeFile(join(srcRoot, "a", "b", "c.txt"), "deep");
  await writeFile(join(srcRoot, "a", "top.txt"), "shallow");
  await writeFile(join(srcRoot, "root.txt"), "root");

  // Build via fflate directly with no directory members at all, bypassing
  // createZip's own dir-entry writing.
  const { Zip, ZipDeflate } = await import("fflate");
  const { createWriteStream } = await import("node:fs");
  const zipPath = join(workDir, "flat.zip");
  await new Promise<void>((resolvePromise, reject) => {
    const ws = createWriteStream(zipPath);
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      ws.write(chunk);
      if (final) ws.end(() => resolvePromise());
    });
    for (const [name, content] of [
      ["root.txt", "root"],
      ["a/top.txt", "shallow"],
      ["a/b/c.txt", "deep"],
    ] as const) {
      const f = new ZipDeflate(name);
      f.os = 3;
      f.attrs = 0o100644 << 16;
      zip.add(f);
      f.push(new TextEncoder().encode(content), true);
    }
    zip.end();
  });
  return zipPath;
}

describe("archive inner-path arithmetic", () => {
  it("archiveChildInner joins a name onto an inner path", () => {
    expect(archiveChildInner("", "a")).toBe("a");
    expect(archiveChildInner("a", "b")).toBe("a/b");
  });

  it("archiveParentInner and archiveBasename are inverses of archiveChildInner", () => {
    expect(archiveParentInner("a/b/c")).toBe("a/b");
    expect(archiveParentInner("a")).toBe("");
    expect(archiveBasename("a/b/c")).toBe("c");
    expect(archiveBasename("a")).toBe("a");
  });

  it("archiveEntryPath is stable and distinct from any real filesystem path", () => {
    const path = archiveEntryPath("/home/dev/backup.zip", "a/b");
    expect(path).toBe("/home/dev/backup.zip::a/b");
  });
});

describe("isZipFile", () => {
  it("matches a .zip file case-insensitively", () => {
    const base = {
      path: "/x",
      size: 0,
      mode: 0,
      uid: 0,
      gid: 0,
      mtimeMs: 0,
      width: 0,
    };
    expect(isZipFile({ ...base, name: "a.zip", kind: "file" })).toBe(true);
    expect(isZipFile({ ...base, name: "A.ZIP", kind: "file" })).toBe(true);
    expect(isZipFile({ ...base, name: "a.tar.gz", kind: "file" })).toBe(false);
    expect(isZipFile({ ...base, name: "a.zip", kind: "dir" })).toBe(false);
    expect(
      isZipFile({ ...base, name: "a.zip", kind: "file", error: "boom" }),
    ).toBe(false);
  });
});

describe("buildTree / archiveEntriesAt", () => {
  it("synthesizes intermediate directories from a flat member list with no explicit dir entries", async () => {
    const zipPath = await buildFixtureZip();
    const tree = await loadArchiveTree(zipPath);

    const root = archiveEntriesAt(tree, "");
    const rootNames = root.map((e) => e.name).sort();
    expect(rootNames).toEqual(["a", "root.txt"]);
    expect(root.find((e) => e.name === "a")?.kind).toBe("dir");
    expect(root.find((e) => e.name === "root.txt")?.kind).toBe("file");
  });

  it("navigates a nested inner path down to the deepest file", async () => {
    const zipPath = await buildFixtureZip();
    const tree = await loadArchiveTree(zipPath);

    const level1 = archiveEntriesAt(tree, "a");
    const level1Names = level1.map((e) => e.name).sort();
    expect(level1Names).toEqual(["b", "top.txt"]);
    expect(level1.find((e) => e.name === "b")?.kind).toBe("dir");

    const level2 = archiveEntriesAt(tree, "a/b");
    expect(level2.map((e) => e.name)).toEqual(["c.txt"]);
    expect(level2[0]?.kind).toBe("file");
    expect(level2[0]?.size).toBe(4); // "deep"
  });

  it("returns an empty list for an inner path that isn't a directory", async () => {
    const zipPath = await buildFixtureZip();
    const tree = await loadArchiveTree(zipPath);
    expect(archiveEntriesAt(tree, "root.txt")).toEqual([]);
    expect(archiveEntriesAt(tree, "does/not/exist")).toEqual([]);
  });

  it("every synthesized entry carries a synthetic, non-real Entry.path", async () => {
    const zipPath = await buildFixtureZip();
    const tree = await loadArchiveTree(zipPath);
    const root = archiveEntriesAt(tree, "");
    for (const e of root) {
      expect(e.path).toBe(archiveEntryPath(zipPath, e.name));
      expect(e.path.startsWith(zipPath)).toBe(true);
    }
  });

  it("preserves explicit real mode/mtime for a directory member that IS listed", async () => {
    const srcRoot = join(workDir, "modesrc");
    await mkdir(join(srcRoot, "sub"), { recursive: true });
    await writeFile(join(srcRoot, "sub", "f.txt"), "x");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(srcRoot, "sub"), 0o700);

    const zipPath = join(workDir, "withdirs.zip");
    await createZip(zipPath, [srcRoot]);

    const tree = await loadArchiveTree(zipPath);
    const inner = archiveEntriesAt(tree, "modesrc");
    const sub = inner.find((e) => e.name === "sub");
    expect(sub).toBeDefined();
    expect(sub?.mode && sub.mode & 0o777).toBe(0o700);
  });
});

describe("loadArchiveTree caching", () => {
  it("returns the same cached tree on a second call when the file hasn't changed", async () => {
    const zipPath = await buildFixtureZip();
    const first = await loadArchiveTree(zipPath);
    const second = await loadArchiveTree(zipPath);
    // Same object identity — a re-parse would build a brand new tree, so
    // this is the observable proxy for "didn't re-read the file."
    expect(second).toBe(first);
    expect(second.root).toBe(first.root);
  });

  it("invalidates the cache when the zip file's mtime changes", async () => {
    const zipPath = await buildFixtureZip();
    const first = await loadArchiveTree(zipPath);

    // Bump mtime into the future so it's unambiguously different regardless
    // of filesystem mtime resolution.
    const future = new Date(Date.now() + 60_000);
    await utimes(zipPath, future, future);
    // Also actually change the contents, so a stale cache would be
    // observably wrong, not just staler.
    const { Zip, ZipDeflate } = await import("fflate");
    const { createWriteStream } = await import("node:fs");
    await new Promise<void>((resolvePromise, reject) => {
      const ws = createWriteStream(zipPath);
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          reject(err);
          return;
        }
        ws.write(chunk);
        if (final) ws.end(() => resolvePromise());
      });
      const f = new ZipDeflate("brand-new.txt");
      f.os = 3;
      f.attrs = 0o100644 << 16;
      zip.add(f);
      f.push(new TextEncoder().encode("new content"), true);
      zip.end();
    });
    await utimes(zipPath, future, future);

    const second = await loadArchiveTree(zipPath);
    expect(second).not.toBe(first);
    const names = archiveEntriesAt(second, "").map((e) => e.name);
    expect(names).toContain("brand-new.txt");
    expect(names).not.toContain("root.txt");
  });
});
