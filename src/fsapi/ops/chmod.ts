// fsapi/ops/chmod.ts — chmod that actually preserves setuid/setgid/sticky,
// working around a verified Bun 1.3.14 bug.
//
// Verified on this machine: both `fs.promises.chmod` and `fs.chmodSync`
// silently mask the mode to its low 9 bits before the syscall —
// `chmod(path, 0o4755)` writes `0o755` to disk, dropping setuid every
// single time. Confirmed by reading the result back with the real `stat`
// command (bypassing any Bun-side caching), not just Bun's own `lstatSync`
// — though `lstatSync` DOES read special bits back correctly when they are
// actually on disk (set some other way), so only the *write* path is
// broken, not the read path. This means `state/store.ts`'s
// `applyPermissions()` can compute `(st.mode & ~0o777) | rwxBits` exactly
// right and still silently fail to persist a file's sgid/sticky bit under
// Bun — the plan's "3x3 grid silently destroys setuid/setgid/sticky" risk,
// one layer below the grid itself, in the runtime `chmod()` is built on.
//
// The fix: call the real POSIX `chmod(2)` directly via `bun:ffi`, bypassing
// Bun's broken `node:fs` shim entirely. `bun:ffi` is imported dynamically
// (never at module top level) specifically so this file still loads under
// plain Node — the npm/Node distribution path this app also targets, where
// `bun:ffi` does not exist as a module at all, but `chmod` is not broken to
// begin with.
//
// Failing to reach the FFI path must never silently reintroduce the bug.
// An earlier version of this file fell straight back to `fs.promises.chmod`
// whenever `dlopen` failed, which under Bun means the special bits are
// dropped again with no error — the user sets setgid, sees success, and the
// bit is gone. That is not hypothetical: the libc soname is guessed, and on
// a musl system (Alpine) `libc.so.6` does not exist at all, so every Bun
// build running there would have taken the silent path.
//
// So this file does not rely on predicting *why* the fast path might be
// unavailable. When special bits are actually requested it verifies the
// result by reading the mode back, and escalates to `/bin/chmod` if they
// did not stick. If even that fails it throws, because reporting success
// for a permission change that did not happen is the worst outcome
// available. See ../../../BUGS.md §2.

import { execFile } from "node:child_process";
import { chmod as fspChmod, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** setuid, setgid, sticky — the bits Bun's `chmod` silently discards. */
const SPECIAL_BITS = 0o7000;
const PERM_BITS = 0o7777;

type ChmodSymbol = (path: Buffer, mode: number) => number;

let ffiChmodPromise: Promise<ChmodSymbol | null> | null = null;

/**
 * Candidate libc sonames, tried in order. `libc.so.6` is glibc; the musl
 * names cover Alpine, where the glibc soname is simply absent.
 */
function libcNamesForPlatform(): string[] {
  if (process.platform === "linux") {
    return [
      "libc.so.6",
      `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
      "libc.so",
    ];
  }
  if (process.platform === "darwin") return ["libSystem.B.dylib"];
  return []; // e.g. win32 — POSIX special bits don't apply there anyway
}

async function loadFfiChmod(): Promise<ChmodSymbol | null> {
  if (ffiChmodPromise) return ffiChmodPromise;
  ffiChmodPromise = (async () => {
    if (typeof Bun === "undefined") return null;
    let ffi: typeof import("bun:ffi");
    try {
      ffi = await import("bun:ffi");
    } catch {
      return null; // FFI unavailable in this runtime
    }
    for (const libName of libcNamesForPlatform()) {
      try {
        const lib = ffi.dlopen(libName, {
          chmod: {
            args: [ffi.FFIType.cstring, ffi.FFIType.u32],
            returns: ffi.FFIType.i32,
          },
        });
        return (path: Buffer, mode: number) => lib.symbols.chmod(path, mode);
      } catch {
        // Not this soname — try the next candidate.
      }
    }
    return null;
  })();
  return ffiChmodPromise;
}

// ── test seam ──
//
// The degraded paths (no FFI, or an FFI `chmod` that reports success without
// doing anything) are the ones that used to fail silently, so they have to be
// reachable from a test. There is no other way to reach them on a glibc box
// where `dlopen` succeeds.

/** Force the FFI probe's result. `null` simulates dlopen failing entirely. */
export function __setFfiChmodForTests(fn: ChmodSymbol | null): void {
  ffiChmodPromise = Promise.resolve(fn);
}

/** Restore normal probing. */
export function __resetFfiChmodForTests(): void {
  ffiChmodPromise = null;
}

// ── verification ──

/**
 * Read back the special bits actually on disk. Uses `stat`, not `lstat`,
 * because `chmod(2)` follows symlinks and we must check what it changed.
 */
async function specialBitsOnDisk(path: string): Promise<number> {
  const st = await stat(path);
  return st.mode & SPECIAL_BITS;
}

/** Last resort: the system `chmod`, which is correct everywhere POSIX. */
async function chmodViaBinary(path: string, mode: number): Promise<void> {
  const octal = (mode & PERM_BITS).toString(8).padStart(4, "0");
  await execFileAsync("chmod", [octal, path]);
}

/**
 * Like `fs.promises.chmod`, but actually applies setuid/setgid/sticky under
 * Bun — see the file header. `mode` may safely include any of the low 12
 * bits (`0o7777`).
 *
 * Throws if the requested special bits could not be persisted, rather than
 * reporting a success that did not happen.
 */
export async function chmodPreserving(
  path: string,
  mode: number,
): Promise<void> {
  const wanted = mode & PERM_BITS;
  const symbol = await loadFfiChmod();

  if (symbol) {
    const rc = symbol(Buffer.from(`${path}\0`, "utf8"), wanted);
    if (rc !== 0) {
      // bun:ffi does not expose errno here, so re-run through node:fs purely
      // to surface a real, code-bearing Error (EPERM, ENOENT, ...) rather
      // than a bare "chmod failed". A genuine failure throws identically.
      await fspChmod(path, wanted);
    }
  } else {
    await fspChmod(path, wanted);
  }

  // Only the special bits can be silently dropped; the low 9 are applied
  // correctly by every path above, so skip the extra stat in the common case.
  const wantedSpecial = wanted & SPECIAL_BITS;
  if (wantedSpecial === 0) return;

  if ((await specialBitsOnDisk(path)) === wantedSpecial) return;

  // The write path lied. Escalate to the system binary, which is correct
  // regardless of why the fast path failed — musl soname, an FFI-less
  // runtime, or a Bun regression we have not seen yet.
  await chmodViaBinary(path, wanted);

  const after = await specialBitsOnDisk(path);
  if (after !== wantedSpecial) {
    throw new Error(
      `chmod could not apply special bits to '${path}': ` +
        `requested ${wanted.toString(8).padStart(4, "0")}, ` +
        `on disk ${after.toString(8)}`,
    );
  }
}
