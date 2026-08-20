// fsapi/ops/guard.ts — containment check for copy (and, in Phase 5b, move)
// jobs. This file exists first, before any copy code, because of what it
// prevents.
//
// `fs.promises.cp` is BANNED in this codebase — never call it, anywhere,
// including from fsapi/ops/copy.ts's own tree-walking implementation.
// Verified on this machine: Bun 1.3.14 segfaults on
// `fsp.cp(src, dest, { recursive: true })` when `dest` is inside `src` — it
// recurses forever creating `a/b/a/b/a/b/…` until it fills the disk and
// dies with SIGSEGV. A segfault bypasses every JavaScript handler (no
// try/catch, no `unhandledRejection`, no `uncaughtException` fires), so it
// also strands the user's terminal in the alternate screen buffer with raw
// mode still on — the crash takes the terminal down with it. Node returns a
// clean `ERR_FS_CP_EINVAL` for the identical call; Bun does not. There is no
// version of "just be careful with fs.promises.cp" that is safe on this
// runtime, so it is never called anywhere in this codebase. Grep for
// `\.cp(` before adding any future file operation.
//
// Every copy job runs through `checkContainment()` here BEFORE it is ever
// queued (see ops/queue.ts). `realpath` is resolved on both the source and
// the destination directory, so a symlink cannot launder a rejected path
// past the check — e.g. pasting into a symlink that resolves to somewhere
// inside the source tree looks fine as a raw string but is exactly the
// copy-into-self case once resolved.
//
// `destDir` here is the directory an item is being pasted INTO (e.g. the
// current directory), not the final path of the copy itself — the final
// path (`destDir/name`) does not exist yet, so it cannot be realpath'd. The
// directory that will contain it must already exist, though, so that side
// resolves cleanly.
//
// This never throws into the render loop: every failure mode — a vanished
// source, an unreadable destination, a `realpath` that throws on a broken
// symlink — comes back as a typed, renderable result.

import { realpath } from "node:fs/promises";
import { sep } from "node:path";

export type GuardRejectionReason =
  | "same-path"
  | "dest-inside-src"
  | "src-vanished"
  | "dest-vanished";

export type GuardResult =
  | { ok: true; realSrc: string; realDestDir: string }
  | { ok: false; reason: GuardRejectionReason; message: string };

/**
 * `realSrc` is an ancestor of (or equal to) `realDestDir` — the
 * copy-into-self / infinite-recursion shape. Handles the filesystem root
 * (`realSrc === "/"`) specially: `"/" + sep` is `"//"`, which would not
 * prefix-match `"/etc"`, so the root case is checked by prefix alone.
 */
function isAncestorOrSame(realSrc: string, realDestDir: string): boolean {
  if (realDestDir === realSrc) return true;
  if (realSrc === sep) return realDestDir.startsWith(sep);
  return realDestDir.startsWith(realSrc + sep);
}

/**
 * Reject a copy/move whose destination directory is the source itself, or
 * lives inside it. Every path is `realpath`'d first so a symlink cannot
 * launder a rejected path past the check. Never throws — a `realpath`
 * failure (vanished source, dangling symlink, unreadable destination) comes
 * back as `{ ok: false, reason: "src-vanished" | "dest-vanished", message }`
 * for the UI to render directly.
 */
export async function checkContainment(
  src: string,
  destDir: string,
): Promise<GuardResult> {
  let realSrc: string;
  try {
    realSrc = await realpath(src);
  } catch {
    return {
      ok: false,
      reason: "src-vanished",
      message: `source no longer exists: ${src}`,
    };
  }

  let realDestDir: string;
  try {
    realDestDir = await realpath(destDir);
  } catch {
    return {
      ok: false,
      reason: "dest-vanished",
      message: `destination no longer exists: ${destDir}`,
    };
  }

  if (isAncestorOrSame(realSrc, realDestDir)) {
    const reason: GuardRejectionReason =
      realDestDir === realSrc ? "same-path" : "dest-inside-src";
    const message =
      reason === "same-path"
        ? `cannot copy '${src}' into itself`
        : `cannot copy '${src}' into its own descendant ('${destDir}')`;
    return { ok: false, reason, message };
  }

  return { ok: true, realSrc, realDestDir };
}
