// tests/preview.test.ts — fsapi/preview.ts: the subprocess wrapper around
// `bat`/`cat`. Real subprocesses, real fixture files — no mocking — the
// same "actually run it" philosophy tests/chmod-fallback.test.ts uses for
// its own subprocess fallback.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile, resetBatProbeForTests } from "../src/fsapi/preview.ts";

const hasBat = Bun.spawnSync(["bash", "-lc", "command -v bat"]).exitCode === 0;

describe("previewFile", () => {
  it("returns the file's contents (via bat or cat) for a plain text file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-preview-test-"));
    try {
      const path = join(dir, "hello.txt");
      writeFileSync(path, "hello\nworld\n");
      const result = await previewFile(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.raw).toContain("hello");
        expect(result.raw).toContain("world");
        expect(result.truncated).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an error for a path that doesn't exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-preview-test-"));
    try {
      const result = await previewFile(join(dir, "does-not-exist.txt"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels via AbortSignal without hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-preview-test-"));
    try {
      const path = join(dir, "hello.txt");
      writeFileSync(path, "hello\n");
      const controller = new AbortController();
      const promise = previewFile(path, { signal: controller.signal });
      controller.abort();
      const result = await promise;
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates output past the byte cap and reports it, without hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-preview-test-"));
    try {
      const path = join(dir, "big.txt");
      // One line repeated well past MAX_PREVIEW_BYTES (2MB) — cheap to
      // generate, cheap for bat/cat to stream.
      writeFileSync(path, `${"x".repeat(1024)}\n`.repeat(3000)); // ~3MB
      const result = await previewFile(path);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (hasBat) {
    it("colors output with bat when it's on PATH (real environment)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "flash-preview-test-"));
      try {
        const path = join(dir, "hello.js");
        writeFileSync(path, "const x = 1;\n");
        const result = await previewFile(path);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.colored).toBe(true);
          expect(result.raw).toContain("\x1b["); // real SGR escapes present
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("falls back to cat (plain, uncolored) when bat is not on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-preview-test-"));
    const originalPath = process.env.PATH;
    try {
      const path = join(dir, "hello.txt");
      writeFileSync(path, "hello\n");
      // A PATH with only the directory `cat` actually lives in (usually
      // /bin or /usr/bin) — no `bat` reachable from here.
      process.env.PATH = "/usr/bin:/bin";
      resetBatProbeForTests();
      const result = await previewFile(path);
      resetBatProbeForTests();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.colored).toBe(false);
        expect(result.raw).toBe("hello\n");
      }
    } finally {
      process.env.PATH = originalPath;
      resetBatProbeForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
