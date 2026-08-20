// tests/guard.test.ts — fsapi/ops/guard.ts: the containment check that
// stands between a paste and the fs.promises.cp copy-into-self segfault
// (see guard.ts's file header). Deliberately never calls `fsp.cp` itself —
// the whole point of this file is to prove the guard rejects the dangerous
// shape *before* anything resembling that call would ever run.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContainment } from "../src/fsapi/ops/guard.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "flash-guard-test-"));
  mkdirSync(join(root, "a", "b", "c"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkContainment", () => {
  it("rejects dest === src", async () => {
    const a = join(root, "a");
    const result = await checkContainment(a, a);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("same-path");
  });

  it("rejects copying a directory into its own descendant (the segfault case)", async () => {
    const a = join(root, "a");
    const bc = join(root, "a", "b", "c");
    const result = await checkContainment(a, bc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dest-inside-src");
  });

  it("rejects a direct child destination the same way as a deeper descendant", async () => {
    const a = join(root, "a");
    const b = join(root, "a", "b");
    const result = await checkContainment(a, b);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dest-inside-src");
  });

  it("allows a destination that merely shares a name prefix with the source", async () => {
    // "a" vs "ab" must not false-positive on a naive string startsWith.
    mkdirSync(join(root, "ab"), { recursive: true });
    const result = await checkContainment(join(root, "a"), join(root, "ab"));
    expect(result.ok).toBe(true);
  });

  it("allows an unrelated destination", async () => {
    const result = await checkContainment(
      join(root, "a"),
      join(root, "outside"),
    );
    expect(result.ok).toBe(true);
  });

  it("allows pasting a directory back into its own parent (the duplicate-in-place case)", async () => {
    // This is exactly the "paste twice in the same directory" shape —
    // dest is an ancestor of src, not the reverse, so it must be allowed.
    const b = join(root, "a", "b");
    const result = await checkContainment(b, join(root, "a"));
    expect(result.ok).toBe(true);
  });

  it("rejects via realpath when a symlink launders the destination into the source (symlink laundering)", async () => {
    const src = join(root, "a");
    const link = join(root, "link-into-a-b");
    symlinkSync(join(root, "a", "b"), link);
    const result = await checkContainment(src, link);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dest-inside-src");
  });

  it("rejects when the source no longer exists", async () => {
    const result = await checkContainment(
      join(root, "does-not-exist"),
      join(root, "outside"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("src-vanished");
  });

  it("rejects when the destination directory no longer exists", async () => {
    const result = await checkContainment(
      join(root, "a"),
      join(root, "also-does-not-exist"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("dest-vanished");
  });

  it("rejects when the source is a dangling symlink", async () => {
    const dangling = join(root, "dangling-link");
    symlinkSync(join(root, "nowhere"), dangling);
    const result = await checkContainment(dangling, join(root, "outside"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("src-vanished");
  });
});
