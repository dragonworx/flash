// tests/queue.test.ts — fsapi/ops/queue.ts: the orchestration layer that
// wires guard.ts (containment) and conflict.ts (uniqueName) around
// copy.ts's engine for one whole paste operation.
//
// "Pasting twice into the same directory yields x, x 2, x 3" (the plan's
// named Verification check) lives here, not in copy.test.ts, because
// conflict resolution against the destination's actual directory listing
// is queue.ts's job, not copy.ts's.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusy, runPasteJob } from "../src/fsapi/ops/queue.ts";

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
