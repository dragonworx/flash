// tests/scan.test.ts — fsapi/scan.ts against the committed fixture (plus a
// broken symlink created here, not committed — see tests/helpers.ts) and
// against a throwaway temp directory for the collator ordering case.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, sortEntries } from "../src/fsapi/scan.ts";
import { FIXTURE_DIR, ensureBrokenSymlink } from "./helpers.ts";

beforeAll(() => {
  ensureBrokenSymlink();
});

describe("scan", () => {
  it("classifies a subdirectory, a normal file, a dotfile, and a broken symlink", async () => {
    const result = await scan(FIXTURE_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.entries.map((e) => [e.name, e]));

    expect(byName.get("subdir")?.kind).toBe("dir");

    const normal = byName.get("normal.txt");
    expect(normal?.kind).toBe("file");
    expect(normal?.size).toBe(6); // "hello\n"

    // Dotfiles are not filtered here — that is Store's job, not scan's.
    expect(byName.has(".hidden")).toBe(true);

    const link = byName.get("broken-link");
    expect(link?.kind).toBe("symlink");
    expect(link?.broken).toBe(true);
    expect(link?.targetKind).toBeUndefined();
  });

  it("sorts directories before files", async () => {
    const result = await scan(FIXTURE_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dirIndex = result.entries.findIndex((e) => e.kind === "dir");
    const fileIndex = result.entries.findIndex((e) => e.kind === "file");
    expect(dirIndex).toBeGreaterThanOrEqual(0);
    expect(fileIndex).toBeGreaterThan(dirIndex);
  });

  it("caches a display width on every entry", async () => {
    const result = await scan(FIXTURE_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const entry of result.entries) {
      expect(entry.width).toBeGreaterThan(0);
    }
  });

  it("returns an error state instead of throwing when readdir fails", async () => {
    const result = await scan(join(FIXTURE_DIR, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toContain("ENOENT");
  });
});

describe("collator sort order", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "flash-scan-test-"));
    for (const name of ["file10", "file1", "file2"]) {
      writeFileSync(join(dir, name), "");
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders file2 before file10 (numeric collation, not lexical)", async () => {
    const result = await scan(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toEqual([
      "file1",
      "file2",
      "file10",
    ]);
  });
});

describe("sortEntries", () => {
  it("keeps dirsFirst pinned to the top even when reversed", async () => {
    const result = await scan(FIXTURE_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sorted = sortEntries(result.entries, {
      key: "name",
      dirsFirst: true,
      reverse: true,
    });
    expect(sorted[0]?.kind).toBe("dir");
  });
});
