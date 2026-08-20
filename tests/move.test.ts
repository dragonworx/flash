// tests/move.test.ts — fsapi/ops/move.ts: cut/move, rename with an EXDEV
// fallback to copy-then-delete.
//
// EXDEV can't be produced for real without a second mounted filesystem, so
// every EXDEV test here injects a `renameFn` that always throws it — see
// move.ts's `RenameFn` type, added specifically so this is possible. That
// forces `moveAll` down the real `copyAll` + `remove()` fallback path
// against a real temp directory, so everything downstream of the injection
// point (the copy, the mode/symlink preservation, the delete) is exercised
// for real, not mocked.
//
// Three of these are the plan's named, non-negotiable tests:
//   - "a mid-copy failure during a cut deletes zero sources"
//   - "a cut onto an existing filename preserves the existing file" (the
//     `rename`-overwrites case) — the same-device half lives here; the
//     full guard -> uniqueName -> move pipeline is covered again at the
//     queue.ts level in tests/queue.test.ts, since `moveAll` itself trusts
//     its caller to have already resolved `destName` (see move.ts's file
//     header) and does not re-derive uniqueness itself.
//   - cancel mid-cut leaves all sources intact

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
import { type MoveJob, moveAll } from "../src/fsapi/ops/move.ts";

let root: string;
let srcDir: string;
let destDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flash-move-test-"));
  srcDir = join(root, "src");
  destDir = join(root, "dest");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });
});

afterEach(() => {
  chmodSync(join(srcDir), 0o755);
  rmSync(root, { recursive: true, force: true });
});

/** Always throws EXDEV, forcing moveAll's copy+delete fallback without a
 * second real filesystem — see the file header. */
async function alwaysExdev(): Promise<never> {
  const err = new Error("cross-device link") as NodeJS.ErrnoException;
  err.code = "EXDEV";
  throw err;
}

describe("moveAll — same-device rename path", () => {
  it("moves a file via a single rename call, removing the source", async () => {
    const file = join(srcDir, "a.txt");
    writeFileSync(file, "hello");

    const jobs: MoveJob[] = [{ src: file, destName: "a.txt" }];
    const outcome = await moveAll(jobs, { destDir });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.errors).toEqual([]);
    expect(outcome.movedSources).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(destDir, "a.txt"), "utf8")).toBe("hello");
  });

  it("moves a directory tree via rename, removing the source", async () => {
    mkdirSync(join(srcDir, "a", "nested"), { recursive: true });
    writeFileSync(join(srcDir, "a", "file.txt"), "hi");
    writeFileSync(join(srcDir, "a", "nested", "leaf.txt"), "leaf");

    const jobs: MoveJob[] = [{ src: join(srcDir, "a"), destName: "a" }];
    const outcome = await moveAll(jobs, { destDir });

    expect(outcome.movedSources).toEqual([join(srcDir, "a")]);
    expect(existsSync(join(srcDir, "a"))).toBe(false);
    expect(existsSync(join(destDir, "a", "nested", "leaf.txt"))).toBe(true);
  });

  it("preserves the existing file at the destination when destName is already conflict-resolved by the caller", async () => {
    // moveAll trusts destName (see the file header) — this proves that as
    // long as the caller (ops/queue.ts's uniqueName resolution) hands it a
    // non-colliding name, nothing at the destination is ever touched,
    // despite `rename`'s silent-overwrite behavior on a raw collision.
    writeFileSync(join(srcDir, "same.txt"), "new contents");
    writeFileSync(join(destDir, "same.txt"), "original contents");

    const jobs: MoveJob[] = [
      { src: join(srcDir, "same.txt"), destName: "same 2.txt" },
    ];
    const outcome = await moveAll(jobs, { destDir });

    expect(outcome.movedSources).toEqual([join(srcDir, "same.txt")]);
    expect(readFileSync(join(destDir, "same.txt"), "utf8")).toBe(
      "original contents",
    );
    expect(readFileSync(join(destDir, "same 2.txt"), "utf8")).toBe(
      "new contents",
    );
  });
});

describe("moveAll — forced EXDEV path", () => {
  it("round-trips a directory via copy+delete, preserving content, mode bits, and symlinks", async () => {
    const dir = join(srcDir, "tree");
    mkdirSync(dir);
    const file = join(dir, "exec.sh");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o741);
    const target = join(dir, "real.txt");
    writeFileSync(target, "real contents");
    symlinkSync("real.txt", join(dir, "rel-link.txt"));

    const jobs: MoveJob[] = [{ src: dir, destName: "tree" }];
    const outcome = await moveAll(jobs, {
      destDir,
      renameFn: alwaysExdev,
    });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.errors).toEqual([]);
    expect(outcome.movedSources).toEqual([dir]);

    // Source is gone entirely.
    expect(existsSync(dir)).toBe(false);

    // Destination has everything, correctly.
    const destExec = join(destDir, "tree", "exec.sh");
    expect(readFileSync(destExec, "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(lstatSync(destExec).mode & 0o777).toBe(0o741);
    const destLink = join(destDir, "tree", "rel-link.txt");
    const linkSt = lstatSync(destLink);
    expect(linkSt.isSymbolicLink()).toBe(true);
    expect(readlinkSync(destLink)).toBe("real.txt");
  });

  it("moves a file across the forced boundary, removing the source only after the copy verified", async () => {
    const file = join(srcDir, "a.txt");
    writeFileSync(file, "hello");

    const jobs: MoveJob[] = [{ src: file, destName: "a.txt" }];
    const outcome = await moveAll(jobs, { destDir, renameFn: alwaysExdev });

    expect(outcome.movedSources).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(destDir, "a.txt"), "utf8")).toBe("hello");
  });

  it("preserves the existing file at the destination on the forced-EXDEV path too", async () => {
    writeFileSync(join(srcDir, "same.txt"), "new contents");
    writeFileSync(join(destDir, "same.txt"), "original contents");

    const jobs: MoveJob[] = [
      { src: join(srcDir, "same.txt"), destName: "same 2.txt" },
    ];
    const outcome = await moveAll(jobs, { destDir, renameFn: alwaysExdev });

    expect(outcome.movedSources).toEqual([join(srcDir, "same.txt")]);
    expect(readFileSync(join(destDir, "same.txt"), "utf8")).toBe(
      "original contents",
    );
    expect(readFileSync(join(destDir, "same 2.txt"), "utf8")).toBe(
      "new contents",
    );
  });

  it("a mid-copy failure deletes ZERO sources (the plan's named test)", async () => {
    mkdirSync(join(srcDir, "tree"));
    writeFileSync(join(srcDir, "tree", "ok.txt"), "fine");
    const unreadable = join(srcDir, "tree", "unreadable.txt");
    writeFileSync(unreadable, "secret");
    chmodSync(unreadable, 0o000); // induces EACCES mid-copy

    const jobs: MoveJob[] = [{ src: join(srcDir, "tree"), destName: "tree" }];
    const outcome = await moveAll(jobs, { destDir, renameFn: alwaysExdev });

    expect(outcome.movedSources).toEqual([]);
    expect(outcome.errors.length).toBeGreaterThan(0);
    // The whole source tree is untouched — including the file that DID
    // copy successfully before the failure, per copyAll's "never partially
    // credited" contract (copy.ts's file header) flowing through to here:
    // the job as a whole is excluded from copiedSources, so nothing about
    // it is ever handed to remove().
    expect(existsSync(join(srcDir, "tree"))).toBe(true);
    expect(existsSync(join(srcDir, "tree", "ok.txt"))).toBe(true);
    expect(existsSync(unreadable)).toBe(true);

    chmodSync(unreadable, 0o644); // let afterEach's rmSync clean up freely
  });

  it("a mid-copy failure on one job does not block a sibling job from moving", async () => {
    mkdirSync(join(srcDir, "good"));
    writeFileSync(join(srcDir, "good", "ok.txt"), "fine");
    mkdirSync(join(srcDir, "bad"));
    const unreadable = join(srcDir, "bad", "unreadable.txt");
    writeFileSync(unreadable, "secret");
    chmodSync(unreadable, 0o000);

    const jobs: MoveJob[] = [
      { src: join(srcDir, "good"), destName: "good" },
      { src: join(srcDir, "bad"), destName: "bad" },
    ];
    const outcome = await moveAll(jobs, { destDir, renameFn: alwaysExdev });

    expect(outcome.movedSources).toEqual([join(srcDir, "good")]);
    expect(existsSync(join(srcDir, "good"))).toBe(false);
    expect(existsSync(join(destDir, "good", "ok.txt"))).toBe(true);
    expect(existsSync(join(srcDir, "bad"))).toBe(true); // untouched

    chmodSync(unreadable, 0o644);
  });

  it("cancel mid-cut leaves the source intact (the plan's named test)", async () => {
    const big = join(srcDir, "big.bin");
    writeFileSync(big, Buffer.alloc(1000, 7));

    const controller = new AbortController();
    let chunkCount = 0;
    const jobs: MoveJob[] = [{ src: big, destName: "big.bin" }];
    const outcome = await moveAll(jobs, {
      destDir,
      renameFn: alwaysExdev,
      signal: controller.signal,
      streamThresholdBytes: 0, // force the streaming path — see copy.ts
      streamChunkBytes: 100,
      onProgress: () => {
        chunkCount++;
        if (chunkCount === 2) controller.abort();
      },
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.movedSources).toEqual([]);
    expect(existsSync(big)).toBe(true);
    expect(existsSync(join(destDir, "big.bin"))).toBe(false);
  });

  it("stops the whole batch, leaving every source untouched, when the signal is already aborted going into a job's copy fallback", async () => {
    const a = join(srcDir, "a.txt");
    const b = join(srcDir, "b.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");

    const controller = new AbortController();
    const jobs: MoveJob[] = [
      { src: a, destName: "a.txt" },
      { src: b, destName: "b.txt" },
    ];
    const outcome = await moveAll(jobs, {
      destDir,
      renameFn: async () => {
        // Aborting from inside the very first rename attempt simulates a
        // cancel landing right as job 1 discovers it needs the EXDEV
        // fallback: copyAll's own abort check (its first line) then
        // refuses to copy anything for job 1, so moveAll never even
        // reaches job 2.
        controller.abort();
        await alwaysExdev();
      },
      signal: controller.signal,
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.movedSources).toEqual([]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(join(destDir, "a.txt"))).toBe(false);
    expect(existsSync(join(destDir, "b.txt"))).toBe(false);
  });
});

describe("moveAll — non-EXDEV rename errors", () => {
  it("records the error and leaves the source intact, without attempting a copy fallback", async () => {
    const file = join(srcDir, "a.txt");
    writeFileSync(file, "hello");

    const jobs: MoveJob[] = [{ src: file, destName: "a.txt" }];
    const outcome = await moveAll(jobs, {
      destDir,
      renameFn: async () => {
        throw new Error("permission denied");
      },
    });

    expect(outcome.movedSources).toEqual([]);
    expect(outcome.errors).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(destDir, "a.txt"))).toBe(false);
  });
});
