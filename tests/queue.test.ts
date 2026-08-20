// tests/queue.test.ts — fsapi/ops/queue.ts: the orchestration layer that
// wires guard.ts (containment) and conflict.ts (uniqueName) around
// copy.ts's (`runPasteJob`) and move.ts's (`runCutJob`) engines for one
// whole paste/cut operation.
//
// "Pasting twice into the same directory yields x, x 2, x 3" (the plan's
// named Verification check) lives here, not in copy.test.ts, because
// conflict resolution against the destination's actual directory listing
// is queue.ts's job, not copy.ts's.
//
// The `runCutJob` describe block below is where Phase 5b's "cut onto an
// existing filename preserves the existing file" test actually lives at
// full integration depth: `ops/move.ts`'s `moveAll` trusts its caller to
// have already resolved `destName` via `uniqueName` (see move.ts's file
// header), so proving the collision is handled correctly end-to-end means
// going through `runCutJob`, exactly as a real cut-paste would — guard,
// then `uniqueName`, then `moveAll`, not `moveAll` in isolation.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusy, runCutJob, runPasteJob } from "../src/fsapi/ops/queue.ts";

let root: string;
let destDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flash-queue-test-"));
  destDir = join(root, "dest");
  mkdirSync(destDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runPasteJob", () => {
  it("pasting the same directory twice yields x, x 2, x 3", async () => {
    const x = join(root, "x");
    mkdirSync(x);
    writeFileSync(join(x, "inside.txt"), "hi");

    const first = await runPasteJob({ destDir, sources: [x] });
    expect(first.copiedSources).toEqual([x]);

    const second = await runPasteJob({ destDir, sources: [x] });
    expect(second.copiedSources).toEqual([x]);

    const third = await runPasteJob({ destDir, sources: [x] });
    expect(third.copiedSources).toEqual([x]);

    expect(readdirSync(destDir).sort()).toEqual(["x", "x 2", "x 3"]);
  });

  it("rejects a source via the guard without touching sibling sources", async () => {
    const a = join(root, "a");
    mkdirSync(join(a, "b"), { recursive: true });
    const good = join(root, "good.txt");
    writeFileSync(good, "fine");

    // Paste "a" into its own descendant "a/b", alongside an unrelated,
    // perfectly pasteable file.
    const outcome = await runPasteJob({
      destDir: join(a, "b"),
      sources: [a, good],
    });

    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]?.src).toBe(a);
    expect(outcome.copiedSources).toEqual([good]);
  });

  it("resolves a collision between two sources pasted in the same operation", async () => {
    const dirA = join(root, "dirA");
    const dirB = join(root, "dirB");
    mkdirSync(dirA);
    mkdirSync(dirB);
    writeFileSync(join(dirA, "same.txt"), "from A");
    writeFileSync(join(dirB, "same.txt"), "from B");

    const outcome = await runPasteJob({
      destDir,
      sources: [join(dirA, "same.txt"), join(dirB, "same.txt")],
    });

    expect(outcome.copiedSources).toHaveLength(2);
    expect(readdirSync(destDir).sort()).toEqual(["same 2.txt", "same.txt"]);
  });

  it("reports isBusy() false before and after a completed job", async () => {
    expect(isBusy()).toBe(false);
    const f = join(root, "f.txt");
    writeFileSync(f, "x");
    await runPasteJob({ destDir, sources: [f] });
    expect(isBusy()).toBe(false);
  });

  it("refuses a second concurrent job rather than interleaving progress", async () => {
    const big = join(root, "big.txt");
    writeFileSync(big, "x".repeat(10_000));

    const first = runPasteJob({ destDir, sources: [big] });
    const second = await runPasteJob({ destDir, sources: [big] });

    expect(second.copiedSources).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.message).toContain("already in progress");

    await first; // let the real job finish before the temp dir is removed
  });
});

// ── runCutJob (Phase 5b) ──

/** Always throws EXDEV — see tests/move.test.ts's file header. */
async function alwaysExdev(): Promise<never> {
  const err = new Error("cross-device link") as NodeJS.ErrnoException;
  err.code = "EXDEV";
  throw err;
}

describe("runCutJob", () => {
  it("moves a source into the destination via rename, removing it from the origin", async () => {
    const file = join(root, "movme.txt");
    writeFileSync(file, "hi");

    const outcome = await runCutJob({ destDir, sources: [file] });

    expect(outcome.movedSources).toEqual([file]);
    expect(outcome.errors).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(destDir, "movme.txt"), "utf8")).toBe("hi");
  });

  it("a cut onto an existing filename preserves the existing file under a new name — same-device rename path (the plan's named test)", async () => {
    const file = join(root, "report.txt");
    writeFileSync(file, "new contents");
    writeFileSync(join(destDir, "report.txt"), "original contents");

    const outcome = await runCutJob({ destDir, sources: [file] });

    expect(outcome.movedSources).toEqual([file]);
    expect(existsSync(file)).toBe(false); // the cut source is gone
    // The pre-existing destination file was NEVER touched — uniqueName ran
    // before rename, exactly as the plan requires.
    expect(readFileSync(join(destDir, "report.txt"), "utf8")).toBe(
      "original contents",
    );
    expect(readFileSync(join(destDir, "report 2.txt"), "utf8")).toBe(
      "new contents",
    );
    expect(readdirSync(destDir).sort()).toEqual(["report 2.txt", "report.txt"]);
  });

  it("a cut onto an existing filename preserves the existing file under a new name — forced-EXDEV path", async () => {
    const file = join(root, "report.txt");
    writeFileSync(file, "new contents");
    writeFileSync(join(destDir, "report.txt"), "original contents");

    const outcome = await runCutJob({
      destDir,
      sources: [file],
      renameFn: alwaysExdev,
    });

    expect(outcome.movedSources).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(destDir, "report.txt"), "utf8")).toBe(
      "original contents",
    );
    expect(readFileSync(join(destDir, "report 2.txt"), "utf8")).toBe(
      "new contents",
    );
  });

  it("rejects a source via the guard without touching sibling sources", async () => {
    const a = join(root, "a");
    mkdirSync(join(a, "b"), { recursive: true });
    const good = join(root, "good.txt");
    writeFileSync(good, "fine");

    const outcome = await runCutJob({
      destDir: join(a, "b"),
      sources: [a, good],
    });

    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]?.src).toBe(a);
    expect(outcome.movedSources).toEqual([good]);
    expect(existsSync(a)).toBe(true); // rejected source untouched
  });

  it("moving a directory whose destination name collides resolves it, preserving the existing directory", async () => {
    const dir = join(root, "build");
    mkdirSync(dir);
    writeFileSync(join(dir, "new.txt"), "new build");
    const existingDir = join(destDir, "build");
    mkdirSync(existingDir);
    writeFileSync(join(existingDir, "old.txt"), "old build");

    const outcome = await runCutJob({ destDir, sources: [dir] });

    expect(outcome.movedSources).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    // The pre-existing directory at the destination is untouched...
    expect(existsSync(join(destDir, "build", "old.txt"))).toBe(true);
    // ...and the moved directory landed under the resolved name instead.
    expect(existsSync(join(destDir, "build 2", "new.txt"))).toBe(true);
  });

  it("refuses a second concurrent job, sharing the in-flight flag with paste", async () => {
    const big = join(root, "big2.txt");
    writeFileSync(big, "x".repeat(10_000));

    const first = runCutJob({ destDir, sources: [big] });
    const second = await runPasteJob({ destDir, sources: [big] });

    expect(second.copiedSources).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.message).toContain("already in progress");

    await first;
  });
});
