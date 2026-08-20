// fsapi/ops/move.ts — move (cut-paste): try `rename` first, fall back to
// copy-then-delete on `EXDEV`. This is Phase 5b's file, and it is the one
// that can destroy the user's data, so read this comment in full before
// touching it.
//
// ── Hazard 1: `rename` silently overwrites ──
//
// Verified on this machine: `fsp.rename(a, b)` destroys an existing file at
// `b` with no error at all, and only complains (`ENOTEMPTY`) when `b` is a
// non-empty directory. That means `moveAll` below must NEVER be handed a
// `destName` that collides with something already at `destDir` — by the
// time this file sees a job, `ops/queue.ts`'s `runCutJob` has already run
// every source through `uniqueName()` (`ops/conflict.ts`) against a
// `readdir` of the destination, exactly as it does for the copy path in
// `runPasteJob`. This file does not re-derive or re-check that; it trusts
// its caller the same way `ops/copy.ts` trusts `destName` to already be
// conflict-free. (One accepted, undefended gap: `uniqueName` is resolved
// from a single `readdir` snapshot taken before any job runs, so a name
// that lands *after* that snapshot but before this file's `rename` call
// could still collide. `ops/copy.ts` has `COPYFILE_EXCL` as a hard backstop
// against exactly this race; `fs.promises.rename` has no exclusive-rename
// equivalent Node exposes, so there is no analogous backstop here. This is
// a narrow TOCTOU window, not a design accepted casually — see the plan's
// Phase 5b section, which mandates resolving conflicts *before* calling
// `rename` and says nothing about closing this specific race.)
//
// ── Hazard 2: delete-after-copy must be structural, not a comment ──
//
// On `EXDEV` (confirmed as errno -18 when crossing filesystems on this
// machine), `moveAll` falls back to `copyAll` (the same engine
// `ops/copy.ts` uses for paste) followed by `remove()` (`ops/index.ts`).
// The source is deleted ONLY when `copyAll`'s returned `copiedSources`
// includes it — never based on a separately-tracked "did it work?" flag.
// `copyAll` already guarantees a job lands in `copiedSources` only when its
// *entire* subtree copied with zero errors, never partially credited (see
// copy.ts's file header), so a mid-copy failure or an abort produces a
// `copiedSources` that simply omits the affected source, and this file
// deletes nothing for it. That is what makes "a mid-copy failure during a
// cut deletes zero sources" true by construction rather than by discipline.

import { rename as fsRename } from "node:fs/promises";
import { join } from "node:path";
import { type CopyError, type CopyProgress, copyAll } from "./copy.ts";
import { remove } from "./index.ts";

export type MoveJob = {
  /** Absolute path to the file/dir/symlink being moved. */
  src: string;
  /** Final basename in the destination directory — already conflict-resolved. */
  destName: string;
};

/** Signature of `node:fs/promises`'s `rename`. Real code never overrides
 * this; tests inject a stub that always throws `EXDEV` so the copy+delete
 * fallback can be exercised for real, without a second filesystem — see the
 * "Testing EXDEV" note in the plan. */
export type RenameFn = (src: string, dest: string) => Promise<void>;

export type MoveOptions = {
  destDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: CopyProgress) => void;
  /** Test-only injection point — see `RenameFn` above. Defaults to the real
   * `fs.promises.rename`. */
  renameFn?: RenameFn;
  /** Test-only overrides, forwarded to `copyAll`'s EXDEV fallback — see
   * copy.ts's `CopyOptions` for what these do. */
  streamThresholdBytes?: number;
  streamChunkBytes?: number;
};

export type MoveOutcome = {
  /** `job.src` values that ended up fully at `destDir/destName` — whether
   * by a same-device rename or a verified copy-then-delete. A source that
   * copied but whose original could not then be deleted (see below) is
   * deliberately NOT included here: it still exists, so it was not moved. */
  movedSources: string[];
  errors: CopyError[];
  cancelled: boolean;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isExdev(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "EXDEV"
  );
}

/**
 * Move every `job` into `opts.destDir`. Each job is tried as a same-device
 * `rename` first (instant, no progress needed); only on `EXDEV` does it fall
 * back to `copyAll` + `remove()` for that one job. Every job is independent,
 * same as `copyAll`'s batch: one job's `EXDEV`/copy/delete failure does not
 * stop the rest of the batch from being attempted, matching the plan's "one
 * bad target doesn't block the rest of a multi-select paste."
 */
export async function moveAll(
  jobs: MoveJob[],
  opts: MoveOptions,
): Promise<MoveOutcome> {
  const { destDir, signal, onProgress } = opts;
  const renameFn = opts.renameFn ?? fsRename;

  const errors: CopyError[] = [];
  const movedSources: string[] = [];
  let done = 0;

  for (const job of jobs) {
    if (signal?.aborted) return { movedSources, errors, cancelled: true };
    const destPath = join(destDir, job.destName);

    try {
      await renameFn(job.src, destPath);
      movedSources.push(job.src);
      done++;
      onProgress?.({
        done,
        total: jobs.length,
        currentPath: job.src,
        bytesDone: 0,
        bytesTotal: 0,
      });
      continue;
    } catch (err) {
      if (!isExdev(err)) {
        errors.push({ path: job.src, message: errorMessage(err) });
        done++;
        continue;
      }
      // EXDEV: cross-device. Fall through to the copy+delete fallback
      // below — see the file header's "Hazard 2".
    }

    const copyOutcome = await copyAll(
      [{ src: job.src, destName: job.destName }],
      {
        destDir,
        signal,
        onProgress,
        streamThresholdBytes: opts.streamThresholdBytes,
        streamChunkBytes: opts.streamChunkBytes,
      },
    );
    errors.push(...copyOutcome.errors);

    if (copyOutcome.cancelled) {
      return { movedSources, errors, cancelled: true };
    }

    if (copyOutcome.copiedSources.includes(job.src)) {
      // Verified copied in full — now, and only now, remove the source.
      // Deliberately does not pass `signal` through to `remove()`: once the
      // copy is verified, deleting the original is the safe direction to
      // finish in (a cancel landing here would otherwise risk a half-
      // deleted source with a duplicate already sitting at the
      // destination, which is a worse state than "briefly uninterruptible
      // while removing one already-copied tree").
      try {
        await remove(job.src);
        movedSources.push(job.src);
      } catch (err) {
        errors.push({
          path: job.src,
          message: `copied but failed to remove source: ${errorMessage(err)}`,
        });
      }
    }
    done++;
  }

  return { movedSources, errors, cancelled: false };
}
