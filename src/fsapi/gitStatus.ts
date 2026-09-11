// fsapi/gitStatus.ts — is a directory a git repo root, and if so is it
// dirty and how many paths does it have changed. Backs the small marker
// ui/listView.ts and ui/gridView.ts draw after a directory's name (see
// term/theme.ts's `gitStatusSuffix`), same two-tier shape as
// fsapi/preview.ts's bat-or-cat probe: a cheap check first, the actual
// subprocess only when that check says it's worth it.
//
// Two things keep this affordable at directory-listing scale, where a
// listing can have dozens of subdirectories and none of this may assume
// `git` is even installed:
//
//   - `isGitRepoRoot()` is a single `lstat` for `<dir>/.git` — a directory
//     for a normal clone, a file (`gitdir: ../.git/worktrees/x`) for a
//     worktree or submodule, either way cheap next to spawning a process.
//     Only directories that pass it ever reach `gitStatusFor()`.
//   - `git` itself is probed for once via `PATH`, mirroring
//     `fsapi/preview.ts`'s `commandExists` (duplicated rather than
//     imported — see that file's header for why: it has to keep working on
//     the plain-Node/npm distribution path, same constraint here). If it's
//     missing, every directory just renders with no marker, same as before
//     this feature existed — never a repeated failed spawn per directory.
//
// `gitStatusFor()` never throws: a timeout, ENOENT, a `.git` file that
// doesn't actually resolve (a submodule gitlink pointing nowhere), or any
// other failure all collapse to `null`, same "no marker" outcome as "not a
// repo" or "git missing" — the caller (state/store.ts) doesn't need to
// distinguish them.

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { lstat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitStatus = { dirty: boolean; changes: number };

let gitAvailable: boolean | null = null;

/** Duplicated from fsapi/preview.ts's `commandExists` — see the file header. */
function commandExists(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      // Not in this directory — keep looking.
    }
  }
  return false;
}

function hasGit(): boolean {
  if (gitAvailable === null) gitAvailable = commandExists("git");
  return gitAvailable;
}

/** Test-only: force the next `gitStatusFor()` call to re-probe PATH for `git`. */
export function resetGitProbeForTests(): void {
  gitAvailable = null;
}

/**
 * Cheap pre-filter: does `dir` look like a git repo root? Only directories
 * that pass this are worth the much more expensive `gitStatusFor()` spawn.
 */
export async function isGitRepoRoot(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

// Generous next to a real `git status`, small enough that one hung
// repository (a stale index lock, an fsmonitor hook that never returns)
// can't tie up a worker indefinitely — see state/store.ts's bounded-
// concurrency scan, which is exactly the shape this mirrors from `dirSize`.
const STATUS_TIMEOUT_MS = 5000;
// A worktree with an enormous number of changed paths (a fresh clone with
// no .gitignore, say) still needs its `git status` output captured in
// full rather than truncated mid-line, but this caps it well short of
// "unbounded."
const MAX_STATUS_BUFFER = 8 * 1024 * 1024;

/**
 * `git status` summary for a repo rooted at `dir`: how many paths are
 * changed (one `--porcelain=v1` line each — a rename is still one line,
 * `"R  old -> new"`, so a plain newline count is correct without needing
 * `-z`'s NUL-separated records) and whether that count is non-zero.
 * `--no-optional-locks` keeps this a read that never contends with (or
 * blocks on) a lock a concurrent real `git` command in the same repo holds;
 * `--ignore-submodules=all` keeps one call from recursing into every
 * submodule's own status. `null` means "no marker" — see the file header
 * for the cases that collapse to it.
 */
export async function gitStatusFor(
  dir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<GitStatus | null> {
  if (!hasGit()) return null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "color.status=false",
        "status",
        "--porcelain=v1",
        "--ignore-submodules=all",
      ],
      {
        cwd: dir,
        signal: opts.signal,
        timeout: STATUS_TIMEOUT_MS,
        maxBuffer: MAX_STATUS_BUFFER,
      },
    );
    const changes = stdout.split("\n").filter((line) => line.length > 0).length;
    return { dirty: changes > 0, changes };
  } catch {
    return null;
  }
}
