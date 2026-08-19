// tests/dump-frame.test.ts — `--dump-frame` end to end: spawn the real CLI
// against tests/fixtures/sample and check the rendered plain-text frame.
// This is the fastest way to catch a layout regression (see the plan's
// Verification section) — no PTY, no interactivity, just stdout.

import { beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { FIXTURE_DIR, ensureBrokenSymlink } from "./helpers.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const MAIN = join(REPO_ROOT, "src", "main.ts");

beforeAll(() => {
  ensureBrokenSymlink();
});

function runDumpFrame(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(
    ["bun", "run", MAIN, "--dump-frame", "--no-color", ...args],
    {
      cwd: REPO_ROOT,
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

describe("--dump-frame", () => {
  it("exits 0 and renders the fixture directory with no TTY", () => {
    const { exitCode, stdout } = runDumpFrame([
      "--size",
      "80x24",
      "-d",
      FIXTURE_DIR,
    ]);
    expect(exitCode).toBe(0);

    // Breadcrumb.
    expect(stdout).toContain("sample");
    // The three committed fixture entries, plus the broken symlink created
    // in beforeAll — dotfiles are hidden by default so ".hidden" must not
    // appear.
    expect(stdout).toContain("subdir");
    expect(stdout).toContain("normal.txt");
    expect(stdout).toContain("broken-link");
    expect(stdout).not.toContain(".hidden");
    // Status bar: 3 real entries (subdir, normal.txt, broken-link).
    expect(stdout).toContain("3 items");
  });

  it("shows dotfiles with --hidden", () => {
    const { stdout } = runDumpFrame([
      "--size",
      "80x24",
      "-d",
      FIXTURE_DIR,
      "--hidden",
    ]);
    expect(stdout).toContain(".hidden");
    expect(stdout).toContain("4 items");
  });

  it("marks the broken symlink distinctly in the size column", () => {
    const { stdout } = runDumpFrame(["--size", "80x24", "-d", FIXTURE_DIR]);
    const line = stdout.split("\n").find((l) => l.includes("broken-link"));
    expect(line).toBeDefined();
    expect(line).toContain("brkn");
  });

  it("fails clearly without --size", () => {
    const result = Bun.spawnSync(
      ["bun", "run", MAIN, "--dump-frame", "-d", FIXTURE_DIR],
      {
        cwd: REPO_ROOT,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString("utf8")).toContain("--size");
  });

  it("fails clearly on a directory it cannot read", () => {
    const result = Bun.spawnSync(
      ["bun", "run", MAIN, "--dump-frame", "--size", "80x24", "-d", "/root"],
      {
        cwd: REPO_ROOT,
      },
    );
    expect(result.exitCode).not.toBe(0);
  });
});
