// tests/zip.test.ts — fsapi/archive/zip.ts: list/create/extract, and the
// traversal guard. Every fixture lives under the system temp dir (never the
// repo or the user's home) and is cleaned up in `afterEach`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zip, ZipDeflate } from "fflate";
import {
  createZip,
  ensureSafeDir,
  extractZip,
  listZip,
  safeMemberParts,
} from "../src/fsapi/archive/zip.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "flash-zip-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Build a zip directly with fflate (bypassing createZip) so tests that
 * poison the archive aren't limited by createZip's own safety checks. */
async function buildRawZip(
  outPath: string,
  members: { name: string; content: string; mode?: number }[],
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const ws = createWriteStream(outPath);
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      ws.write(chunk);
      if (final) ws.end(() => resolvePromise());
    });
    for (const m of members) {
      const f = new ZipDeflate(m.name);
      f.os = 3;
      f.attrs = (m.mode ?? 0o100644) << 16;
      zip.add(f);
      f.push(new TextEncoder().encode(m.content), true);
    }
    zip.end();
  });
}

describe("safeMemberParts", () => {
  it("accepts a plain relative member", () => {
    expect(safeMemberParts("a/b/c.txt")).toEqual(["a", "b", "c.txt"]);
  });

  it("rejects an absolute member", () => {
    expect(safeMemberParts("/etc/passwd")).toBeNull();
  });

  it("rejects a member with a literal .. component", () => {
    expect(safeMemberParts("../evil.txt")).toBeNull();
    expect(safeMemberParts("a/../../evil.txt")).toBeNull();
    expect(safeMemberParts("a/../evil.txt")).toBeNull();
  });

  it("rejects an empty member name", () => {
    expect(safeMemberParts("")).toBeNull();
  });

  it("rejects a Windows drive-absolute member defensively", () => {
    expect(safeMemberParts("C:\\evil.txt")).toBeNull();
  });
});

describe("listZip", () => {
  it("returns correct uncompressed sizes, not compressed ones", async () => {
    const zipPath = join(workDir, "sizes.zip");
    // Highly compressible content so compressed and uncompressed sizes are
    // guaranteed to differ — the trap the plan calls out (f.size in
    // fflate's filter callback is compressed; listZip must not get this
    // backwards).
    const content = "a".repeat(10_000);
    await buildRawZip(zipPath, [{ name: "big.txt", content }]);

    const entries = await listZip(zipPath);
    const entry = entries.find((e) => e.name === "big.txt");
    expect(entry).toBeDefined();
    expect(entry?.size).toBe(10_000); // uncompressed
    expect(entry?.compressedSize).toBeLessThan(10_000); // compressed, much smaller
    expect(entry?.compressedSize).toBeGreaterThan(0);
  });

  it("recovers unix mode bits from the central directory", async () => {
    const zipPath = join(workDir, "modes.zip");
    await buildRawZip(zipPath, [
      { name: "exec.sh", content: "#!/bin/sh\n", mode: 0o100755 },
      { name: "plain.txt", content: "hi", mode: 0o100600 },
    ]);
    const entries = await listZip(zipPath);
    expect(entries.find((e) => e.name === "exec.sh")?.mode).toBe(0o100755);
    expect(entries.find((e) => e.name === "plain.txt")?.mode).toBe(0o100600);
  });

  it("marks directory members by their trailing slash", async () => {
    const zipPath = join(workDir, "dirs.zip");
    await buildRawZip(zipPath, [
      { name: "sub/", content: "", mode: 0o040755 },
      { name: "sub/file.txt", content: "x" },
    ]);
    const entries = await listZip(zipPath);
    expect(entries.find((e) => e.name === "sub/")?.isDir).toBe(true);
    expect(entries.find((e) => e.name === "sub/file.txt")?.isDir).toBe(false);
  });
});

describe("createZip + extractZip round trip", () => {
  it("preserves contents and mode bits across varied permissions, including a nested empty directory", async () => {
    const srcRoot = join(workDir, "src");
    await mkdir(join(srcRoot, "sub", "empty"), { recursive: true });
    await writeFile(join(srcRoot, "a.txt"), "hello");
    await chmod(join(srcRoot, "a.txt"), 0o644);
    await writeFile(join(srcRoot, "sub", "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(srcRoot, "sub", "run.sh"), 0o755);
    await chmod(join(srcRoot, "sub"), 0o750);

    const zipPath = join(workDir, "archive.zip");
    const createOutcome = await createZip(zipPath, [srcRoot]);
    expect(createOutcome.cancelled).toBe(false);
    expect(createOutcome.errors).toEqual([]);
    expect(createOutcome.addedCount).toBeGreaterThan(0);

    const destDir = join(workDir, "extracted");
    await mkdir(destDir);
    const extractOutcome = await extractZip(zipPath, destDir);
    expect(extractOutcome.cancelled).toBe(false);
    expect(extractOutcome.errors).toEqual([]);

    const aContent = await readFile(join(destDir, "src", "a.txt"), "utf8");
    expect(aContent).toBe("hello");
    const runContent = await readFile(
      join(destDir, "src", "sub", "run.sh"),
      "utf8",
    );
    expect(runContent).toBe("#!/bin/sh\necho hi\n");

    const aStat = await stat(join(destDir, "src", "a.txt"));
    expect(aStat.mode & 0o777).toBe(0o644);
    const runStat = await stat(join(destDir, "src", "sub", "run.sh"));
    expect(runStat.mode & 0o777).toBe(0o755);
    const subStat = await stat(join(destDir, "src", "sub"));
    expect(subStat.mode & 0o777).toBe(0o750);

    // The empty nested directory survived the round trip.
    const emptyStat = await stat(join(destDir, "src", "sub", "empty"));
    expect(emptyStat.isDirectory()).toBe(true);
  });
});

describe("path traversal guard", () => {
  it("extracts nothing outside the destination for a poisoned ../evil.txt member", async () => {
    const zipPath = join(workDir, "poison.zip");
    await buildRawZip(zipPath, [
      { name: "../evil.txt", content: "pwned" },
      { name: "good.txt", content: "fine" },
    ]);

    const destDir = join(workDir, "dest");
    await mkdir(destDir);
    const outcome = await extractZip(zipPath, destDir);

    // The good member still extracts...
    expect(await readFile(join(destDir, "good.txt"), "utf8")).toBe("fine");
    // ...but nothing escaped destDir: no evil.txt anywhere outside it.
    const escapedPath = join(workDir, "evil.txt");
    await expect(lstat(escapedPath)).rejects.toThrow();
    // And the outcome records the rejection rather than silently dropping it.
    expect(outcome.errors.some((e) => e.path === "../evil.txt")).toBe(true);
  });

  it("rejects an absolute member the same way", async () => {
    const zipPath = join(workDir, "poison-abs.zip");
    const absoluteTarget = join(workDir, "outside-abs.txt");
    await buildRawZip(zipPath, [{ name: absoluteTarget, content: "pwned" }]);

    const destDir = join(workDir, "dest2");
    await mkdir(destDir);
    await extractZip(zipPath, destDir);

    await expect(lstat(absoluteTarget)).rejects.toThrow();
  });

  it("ensureSafeDir refuses to create through an existing symlink", async () => {
    const destRoot = join(workDir, "guarded-root");
    await mkdir(destRoot);
    const outsideDir = join(workDir, "outside-target");
    await mkdir(outsideDir);
    const { symlink } = await import("node:fs/promises");
    await symlink(outsideDir, join(destRoot, "linked"));

    const result = await ensureSafeDir(destRoot, ["linked", "nested"]);
    expect(result).toBeNull();
    // Nothing was created inside the symlink target.
    await expect(lstat(join(outsideDir, "nested"))).rejects.toThrow();
  });
});

describe("extraction cancellation", () => {
  it("is cancellable and leaves no partial file for the file in flight", async () => {
    const srcRoot = join(workDir, "big-src");
    await mkdir(srcRoot);
    // Large AND genuinely incompressible (real random bytes, not a
    // predictable byte pattern — deflate finds patterns in even a simple
    // arithmetic sequence) so the *compressed* zip content — what
    // extractZip actually streams in fixed-size chunks off disk, and what
    // fflate's `Unzip` emits `ondata` per — spans many chunks instead of
    // decompressing entirely within a single `Unzip.push()` call. A
    // compressible payload collapses to a few KB, fits one
    // `createReadStream` read, and would defeat this test by delivering
    // the whole file in one `ondata` call.
    const big = Buffer.allocUnsafe(6 * 1024 * 1024);
    const { randomFillSync } = await import("node:crypto");
    for (let off = 0; off < big.length; off += 65536) {
      randomFillSync(big, off, Math.min(65536, big.length - off));
    }
    await writeFile(join(srcRoot, "big.bin"), big);

    const zipPath = join(workDir, "big.zip");
    const createOutcome = await createZip(zipPath, [join(srcRoot, "big.bin")]);
    expect(createOutcome.cancelled).toBe(false);

    const destDir = join(workDir, "cancel-dest");
    await mkdir(destDir);

    const controller = new AbortController();
    let sawProgress = false;
    const outcome = await extractZip(zipPath, destDir, {
      signal: controller.signal,
      onProgress: (p) => {
        if (!sawProgress && p.bytesDone > 0) {
          sawProgress = true;
          controller.abort();
        }
      },
    });

    expect(sawProgress).toBe(true);
    expect(outcome.cancelled).toBe(true);
    // No half-written file left behind at the destination.
    await expect(lstat(join(destDir, "big.bin"))).rejects.toThrow();
  });
});

describe("create() reports unsupported members instead of crashing", () => {
  it("skips a symlink source and reports it, without throwing", async () => {
    const srcRoot = join(workDir, "symlink-src");
    await mkdir(srcRoot);
    await writeFile(join(srcRoot, "real.txt"), "hi");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(srcRoot, "real.txt"), join(srcRoot, "link.txt"));

    const zipPath = join(workDir, "symlink-out.zip");
    const outcome = await createZip(zipPath, [srcRoot]);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.errors.some((e) => e.path.endsWith("link.txt"))).toBe(true);

    const entries = await listZip(zipPath);
    expect(entries.some((e) => e.name.endsWith("real.txt"))).toBe(true);
    expect(entries.some((e) => e.name.endsWith("link.txt"))).toBe(false);
  });
});
