// tests/chmod-fallback.test.ts — the degraded paths of
// fsapi/ops/chmod.ts's chmodPreserving().
//
// Bun 1.3.14's fs.chmod silently masks the mode to its low 9 bits (see
// BUGS.md §2), so chmodPreserving() calls POSIX chmod(2) through bun:ffi.
// The bug this file guards against is the *fallback* quietly reintroducing
// the original defect: if dlopen fails — as it does on musl, where the
// glibc soname does not exist — an earlier version dropped straight back to
// the broken fs.chmod and reported success.
//
// These tests force the degraded paths, which are otherwise unreachable on
// a glibc machine where dlopen succeeds.

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetFfiChmodForTests,
  __setFfiChmodForTests,
  chmodPreserving,
} from "../src/fsapi/ops/chmod.ts";

const dirs: string[] = [];

function tempFile(mode = "0644"): string {
  const dir = mkdtempSync(join(tmpdir(), "flash-chmod-"));
  dirs.push(dir);
  const file = join(dir, "f.txt");
  writeFileSync(file, "x");
  // Seed via the real binary — Bun's own chmod cannot set special bits.
  execFileSync("chmod", [mode, file]);
  return file;
}

const special = (p: string) => statSync(p).mode & 0o7000;
const perms = (p: string) => statSync(p).mode & 0o7777;

afterEach(() => {
  __resetFfiChmodForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("chmodPreserving degraded paths", () => {
  it("still applies special bits when FFI is unavailable (the musl case)", async () => {
    const file = tempFile();
    __setFfiChmodForTests(null); // simulate dlopen failing outright

    await chmodPreserving(file, 0o4755);

    // Without the verify-and-escalate step this is 0o755 under Bun: the
    // exact silent failure the workaround exists to prevent.
    expect(special(file)).toBe(0o4000);
    expect(perms(file)).toBe(0o4755);
  });

  it("escalates when the FFI chmod reports success but does nothing", async () => {
    const file = tempFile();
    __setFfiChmodForTests(() => 0); // claims success, writes nothing

    await chmodPreserving(file, 0o2750);

    expect(perms(file)).toBe(0o2750);
  });

  it("preserves the sticky bit through a degraded write", async () => {
    const file = tempFile();
    __setFfiChmodForTests(null);

    await chmodPreserving(file, 0o1700);

    expect(special(file)).toBe(0o1000);
  });

  it("throws rather than reporting a success that did not happen", async () => {
    const file = tempFile();
    __setFfiChmodForTests(() => 0);
    // Point the escalation at a path that cannot be chmod'ed, by deleting
    // the file out from under it after the seam is installed.
    rmSync(file);

    await expect(chmodPreserving(file, 0o4755)).rejects.toThrow();
  });

  it("does not stat when no special bits were requested", async () => {
    const file = tempFile();
    __setFfiChmodForTests(null);

    // Plain permission changes need no verification — Bun applies the low
    // 9 bits correctly — and must keep working through the fallback.
    await chmodPreserving(file, 0o640);

    expect(perms(file)).toBe(0o640);
  });

  it("works through the normal FFI path with special bits", async () => {
    const file = tempFile();
    __resetFfiChmodForTests(); // real probe

    await chmodPreserving(file, 0o6750);

    expect(perms(file)).toBe(0o6750);
  });
});
