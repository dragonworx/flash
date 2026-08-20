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
// begin with. Any failure to reach the FFI path (plain Node, an unknown
// platform, `dlopen` failing to find libc) falls back to
// `fs.promises.chmod` — which then still applies at least the low 9 bits
// correctly even under Bun, so a chmod never just fails outright because
// the fast path isn't available.

import { chmod as fspChmod } from "node:fs/promises";

type ChmodSymbol = (path: Buffer, mode: number) => number;

let ffiChmodPromise: Promise<ChmodSymbol | null> | null = null;

function libcNameForPlatform(): string | null {
  if (process.platform === "linux") return "libc.so.6";
  if (process.platform === "darwin") return "libSystem.B.dylib";
  return null; // e.g. win32 — POSIX special bits don't apply there anyway
}

async function loadFfiChmod(): Promise<ChmodSymbol | null> {
  if (ffiChmodPromise) return ffiChmodPromise;
  ffiChmodPromise = (async () => {
    if (typeof Bun === "undefined") return null;
    const libName = libcNameForPlatform();
    if (!libName) return null;
    try {
      const ffi = await import("bun:ffi");
      const lib = ffi.dlopen(libName, {
        chmod: {
          args: [ffi.FFIType.cstring, ffi.FFIType.u32],
          returns: ffi.FFIType.i32,
        },
      });
      return (path: Buffer, mode: number) => lib.symbols.chmod(path, mode);
    } catch {
      return null; // libc not found under this name, FFI unsupported, etc.
    }
  })();
  return ffiChmodPromise;
}

/**
 * Like `fs.promises.chmod`, but actually applies setuid/setgid/sticky under
 * Bun — see the file header. `mode` may safely include any of the low 12
 * bits (`0o7777`); the FFI call masks to that range before the syscall.
 */
export async function chmodPreserving(
  path: string,
  mode: number,
): Promise<void> {
  const symbol = await loadFfiChmod();
  if (!symbol) {
    await fspChmod(path, mode);
    return;
  }
  const buf = Buffer.from(`${path}\0`, "utf8");
  const rc = symbol(buf, mode & 0o7777);
  if (rc !== 0) {
    // bun:ffi does not expose errno directly here, so re-run through
    // node:fs/promises purely to surface a real, code-bearing Error
    // (EPERM, ENOENT, ...) to the caller instead of a bare "chmod failed."
    // If the FFI call failed for a real reason (e.g. permission denied),
    // this call fails the same way and throws that real error.
    await fspChmod(path, mode);
  }
}
