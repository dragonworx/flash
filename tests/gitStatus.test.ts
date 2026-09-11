// tests/gitStatus.test.ts — fsapi/gitStatus.ts: real `git` subprocesses
// against real temp repos, same "actually run it, no mocking" philosophy
// tests/preview.test.ts uses for its own subprocess wrapper.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitStatusFor,
  isGitRepoRoot,
  resetGitProbeForTests,
} from "../src/fsapi/gitStatus.ts";

function run(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "flash-gitstatus-test-"));
  run(dir, ["init", "--quiet"]);
  run(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["config", "user.name", "Test"]);
  return dir;
}

afterEach(() => {
  resetGitProbeForTests();
});

describe("isGitRepoRoot", () => {
  it("is true for a directory with a .git entry", async () => {
    const dir = makeRepo();
    try {
      expect(await isGitRepoRoot(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is false for a plain directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-gitstatus-test-"));
    try {
      expect(await isGitRepoRoot(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is false for a directory that doesn't exist", async () => {
    expect(await isGitRepoRoot("/nonexistent/path/for/flash/tests")).toBe(
      false,
    );
  });
});

describe("gitStatusFor", () => {
  it("reports clean with zero changes for a fresh repo with everything committed", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      run(dir, ["add", "."]);
      run(dir, ["commit", "--quiet", "-m", "initial"]);
      const status = await gitStatusFor(dir);
      expect(status).toEqual({ dirty: false, changes: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports dirty with a count for untracked and modified files", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      run(dir, ["add", "."]);
      run(dir, ["commit", "--quiet", "-m", "initial"]);

      writeFileSync(join(dir, "a.txt"), "changed"); // modified
      writeFileSync(join(dir, "b.txt"), "new"); // untracked

      const status = await gitStatusFor(dir);
      expect(status).toEqual({ dirty: true, changes: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a directory that isn't a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-gitstatus-test-"));
    try {
      expect(await gitStatusFor(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null (never throws) when git is missing from PATH", async () => {
    const dir = makeRepo();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      resetGitProbeForTests();
      expect(await gitStatusFor(dir)).toBeNull();
    } finally {
      process.env.PATH = originalPath;
      resetGitProbeForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
