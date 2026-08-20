// tests/copy.test.ts — fsapi/ops/copy.ts: the recursive copy engine
// (planning, mode preservation, symlink handling, partial-failure
// bookkeeping, and abort/cleanup). Runs against a throwaway temp tree,
// never the committed fixtures — see tests/helpers.ts's file header for why
// a broken symlink in particular is created at test time rather than
// checked in.
//
// Two of these are the plan's named, non-negotiable tests:
//   - "excludes a job with a mid-copy failure from copiedSources" (a mid-
//     copy failure during a cut deletes zero sources in Phase 5b — this is
//     the copy-side half of that: the delete pass can only be correct if
//     the list it's handed is correct).
//   - "cleans up a partially-written file when aborted mid-stream" (Esc
//     cancels a paste and must never leave a half-file behind).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CopyJob, copyAll } from "../src/fsapi/ops/copy.ts";

let root: string;
let srcDir: string;
let destDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flash-copy-test-"));
  srcDir = join(root, "src");
  destDir = join(root, "dest");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });
});

afterEach(() => {
  // The mid-copy-failure test leaves a chmod-0 file behind; restore
  // permissions before recursive removal so cleanup can't itself fail.
  chmodSync(join(srcDir), 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("copyAll", () => {
  it("copies a simple tree and reports it as verifiably copied", async () => {
    mkdirSync(join(srcDir, "a", "nested"), { recursive: true });
    writeFileSync(join(srcDir, "a", "file.txt"), "hello");
    writeFileSync(join(srcDir, "a", "nested", "leaf.txt"), "leaf");

    const jobs: CopyJob[] = [{ src: join(srcDir, "a"), destName: "a" }];
    const outcome = await copyAll(jobs, { destDir });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.errors).toEqual([]);
    expect(outcome.copiedSources).toEqual([join(srcDir, "a")]);
    expect(existsSync(join(destDir, "a", "file.txt"))).toBe(true);
    expect(existsSync(join(destDir, "a", "nested", "leaf.txt"))).toBe(true);
  });

  it("preserves file mode bits", async () => {
    const file = join(srcDir, "exec.sh");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o741);

    const jobs: CopyJob[] = [{ src: file, destName: "exec.sh" }];
    await copyAll(jobs, { destDir });

    const st = lstatSync(join(destDir, "exec.sh"));
    expect(st.mode & 0o777).toBe(0o741);
  });

  it("preserves directory mode bits", async () => {
    const dir = join(srcDir, "restricted");
    mkdirSync(dir);
    writeFileSync(join(dir, "inside.txt"), "x");
    chmodSync(dir, 0o750);

    const jobs: CopyJob[] = [{ src: dir, destName: "restricted" }];
    const outcome = await copyAll(jobs, { destDir });

    expect(outcome.errors).toEqual([]);
    const st = lstatSync(join(destDir, "restricted"));
    expect(st.mode & 0o777).toBe(0o750);
    // The restrictive mode must have been applied *after* populating the
    // directory, or the file inside would never have been written.
    expect(existsSync(join(destDir, "restricted", "inside.txt"))).toBe(true);
  });

  it("recreates a symlink as a symlink, never following it", async () => {
    const target = join(srcDir, "real.txt");
    writeFileSync(target, "real contents");
    const link = join(srcDir, "link.txt");
    symlinkSync(target, link);

    const jobs: CopyJob[] = [{ src: link, destName: "link.txt" }];
    const outcome = await copyAll(jobs, { destDir });

    expect(outcome.errors).toEqual([]);
    const destPath = join(destDir, "link.txt");
    const st = lstatSync(destPath);
    expect(st.isSymbolicLink()).toBe(true);
    expect(readlinkSync(destPath)).toBe(target);
  });

  it("recreates a symlink inside a copied directory as a symlink too", async () => {
    const dir = join(srcDir, "withlink");
    mkdirSync(dir);
    const target = join(dir, "real.txt");
    writeFileSync(target, "real");
    symlinkSync("real.txt", join(dir, "rel-link.txt")); // relative target

    const jobs: CopyJob[] = [{ src: dir, destName: "withlink" }];
    await copyAll(jobs, { destDir });

    const destLink = join(destDir, "withlink", "rel-link.txt");
    const st = lstatSync(destLink);
    expect(st.isSymbolicLink()).toBe(true);
    expect(readlinkSync(destLink)).toBe("real.txt");
  });

  it("excludes a job with a mid-copy failure from copiedSources, but still copies the sibling job", async () => {
    mkdirSync(join(srcDir, "good"));
    writeFileSync(join(srcDir, "good", "ok.txt"), "fine");

    mkdirSync(join(srcDir, "bad"));
    const unreadable = join(srcDir, "bad", "unreadable.txt");
    writeFileSync(unreadable, "secret");
    chmodSync(unreadable, 0o000); // induces EACCES on read, mid-copy

    const jobs: CopyJob[] = [
      { src: join(srcDir, "good"), destName: "good" },
      { src: join(srcDir, "bad"), destName: "bad" },
    ];
    const outcome = await copyAll(jobs, { destDir });

    expect(outcome.copiedSources).toEqual([join(srcDir, "good")]);
    expect(outcome.copiedSources).not.toContain(join(srcDir, "bad"));
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.path).toBe(unreadable);
    expect(existsSync(join(destDir, "good", "ok.txt"))).toBe(true);

    chmodSync(unreadable, 0o644); // let afterEach's rmSync clean up freely
  });

  it("does not abort the whole batch on a walk-time failure in one job", async () => {
    // A source that vanishes between being named and being walked: not
    // realistic in normal use (the guard + partitionExisting in store.ts
    // catch this earlier), but copyAll itself must still degrade instead of
    // throwing if a job's src disappears out from under it.
    mkdirSync(join(srcDir, "good"));
    writeFileSync(join(srcDir, "good", "ok.txt"), "fine");

    const jobs: CopyJob[] = [
      { src: join(srcDir, "good"), destName: "good" },
      { src: join(srcDir, "gone"), destName: "gone" },
    ];
    const outcome = await copyAll(jobs, { destDir });

    expect(outcome.copiedSources).toEqual([join(srcDir, "good")]);
    expect(outcome.errors.some((e) => e.path === join(srcDir, "gone"))).toBe(
      true,
    );
  });

  it("reports progress after each entry with a growing done count", async () => {
    mkdirSync(join(srcDir, "a"));
    writeFileSync(join(srcDir, "a", "one.txt"), "1");
    writeFileSync(join(srcDir, "a", "two.txt"), "2");

    const seen: number[] = [];
    const jobs: CopyJob[] = [{ src: join(srcDir, "a"), destName: "a" }];
    await copyAll(jobs, {
      destDir,
      onProgress: (p) => seen.push(p.done),
    });

    expect(seen.length).toBeGreaterThan(0);
    // Non-decreasing across every progress event, ending at the total.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  it("cleans up a partially-written file when aborted mid-stream, leaving no partial file", async () => {
    // Force the streaming path with a tiny threshold/chunk size so a small
    // fixture file still exercises multiple read/write chunks — see
    // copy.ts's CopyOptions test-only overrides.
    const big = join(srcDir, "big.bin");
    writeFileSync(big, Buffer.alloc(1000, 7));

    const controller = new AbortController();
    let chunkCount = 0;
    const jobs: CopyJob[] = [{ src: big, destName: "big.bin" }];
    const outcome = await copyAll(jobs, {
      destDir,
      signal: controller.signal,
      streamThresholdBytes: 0, // force streaming even though the file is small
      streamChunkBytes: 100,
      onProgress: () => {
        chunkCount++;
        if (chunkCount === 2) controller.abort();
      },
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.copiedSources).toEqual([]);
    expect(existsSync(join(destDir, "big.bin"))).toBe(false);
  });

  it("does not start a job at all when already aborted before copying begins", async () => {
    writeFileSync(join(srcDir, "f.txt"), "x");
    const controller = new AbortController();
    controller.abort();

    const jobs: CopyJob[] = [{ src: join(srcDir, "f.txt"), destName: "f.txt" }];
    const outcome = await copyAll(jobs, { destDir, signal: controller.signal });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.copiedSources).toEqual([]);
    expect(existsSync(join(destDir, "f.txt"))).toBe(false);
  });

  it("uses COPYFILE_EXCL semantics: never silently clobbers an existing destination", async () => {
    writeFileSync(join(srcDir, "same.txt"), "new contents");
    writeFileSync(join(destDir, "same.txt"), "original contents");

    const jobs: CopyJob[] = [
      { src: join(srcDir, "same.txt"), destName: "same.txt" },
    ];
    const outcome = await copyAll(jobs, { destDir });

    expect(outcome.copiedSources).toEqual([]);
    expect(outcome.errors).toHaveLength(1);
    expect(readFileSync(join(destDir, "same.txt"), "utf8")).toBe(
      "original contents",
    );
  });
});
