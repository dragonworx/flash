// tests/goto.test.ts — fsapi/goto.ts's read-only integration with the
// `goto` directory-jump tool. Every test points `GOTO_HOME` at a throwaway
// temp directory so this never touches the real machine's goto config, same
// pattern as tests/config.test.ts's `XDG_CONFIG_HOME` override.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGotoBookmarks,
  orderByLastUsed,
  resolveGotoHome,
} from "../src/fsapi/goto.ts";

let tempDir: string;
let originalGotoHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "flash-goto-test-"));
  originalGotoHome = process.env.GOTO_HOME;
  process.env.GOTO_HOME = tempDir;
});

afterEach(() => {
  if (originalGotoHome === undefined) {
    // biome-ignore lint/performance/noDelete: see tests/config.test.ts
    delete process.env.GOTO_HOME;
  } else {
    process.env.GOTO_HOME = originalGotoHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, string>): void {
  writeFileSync(join(tempDir, "config.json"), JSON.stringify(config));
}

function writeUsage(usage: Record<string, number>): void {
  writeFileSync(join(tempDir, ".usage.json"), JSON.stringify(usage));
}

describe("resolveGotoHome", () => {
  it("follows GOTO_HOME when set", () => {
    expect(resolveGotoHome()).toBe(tempDir);
  });

  it("falls back to ~/.goto when unset", () => {
    // biome-ignore lint/performance/noDelete: matches afterEach's own reset
    delete process.env.GOTO_HOME;
    expect(resolveGotoHome().endsWith("/.goto")).toBe(true);
  });
});

describe("orderByLastUsed", () => {
  it("sorts most-recently-used first", () => {
    const out = orderByLastUsed(["a", "b", "c"], { a: 100, b: 300, c: 200 });
    expect(out).toEqual(["b", "c", "a"]);
  });

  it("keeps never-used names in their original order, sorted after used ones", () => {
    const out = orderByLastUsed(["a", "b", "c", "d"], { b: 50 });
    expect(out).toEqual(["b", "a", "c", "d"]);
  });
});

describe("loadGotoBookmarks", () => {
  it("returns an empty list when config.json is missing", () => {
    expect(loadGotoBookmarks()).toEqual([]);
  });

  it("returns an empty list when config.json is malformed", () => {
    writeFileSync(join(tempDir, "config.json"), "{not json");
    expect(loadGotoBookmarks()).toEqual([]);
  });

  it("orders bookmarks most-recently-used first, per .usage.json", () => {
    writeConfig({ flash: "/a/flash", kb: "/a/kb", portal: "/a/portal" });
    writeUsage({ portal: 200, kb: 100 });
    expect(loadGotoBookmarks()).toEqual([
      { name: "portal", path: "/a/portal" },
      { name: "kb", path: "/a/kb" },
      { name: "flash", path: "/a/flash" },
    ]);
  });

  it("tolerates a missing .usage.json (config insertion order)", () => {
    writeConfig({ flash: "/a/flash", kb: "/a/kb" });
    expect(loadGotoBookmarks()).toEqual([
      { name: "flash", path: "/a/flash" },
      { name: "kb", path: "/a/kb" },
    ]);
  });
});
