// fsapi/ops/queue.ts — runs one paste (copy) or cut (move) job at a time
// and emits progress.
//
// A "job" here is one whole paste/cut operation: potentially many clipboard
// sources landing in one destination directory, sharing a single progress
// bar — per the plan's "queue.ts runs one job at a time, emits {done,
// total, currentPath, bytesDone, bytesTotal}." Only one job runs at a time,
// copy or cut, sharing the same `jobInFlight` flag — a cut and a paste
// racing each other would interleave two trees' progress into the same bar
// exactly as two pastes would, so both `runPasteJob` and `runCutJob` refuse
// a second call while either kind is in flight (state/store.ts's `paste()`
// also checks this before ever calling in, so the refusal here is a
// backstop, not the primary guard).
//
// `planJobs` below is the one piece both entry points share, and it is the
// piece Phase 5b's hard requirement runs through: every source is checked
// by `ops/guard.ts`'s containment check BEFORE it is ever handed to
// `ops/copy.ts` or `ops/move.ts` (a source that fails is recorded as
// "skipped" and excluded from the batch, so one bad target doesn't block
// the rest of a multi-select operation), and THEN conflict resolution
// (`ops/conflict.ts`'s `uniqueName`) runs once per source, against a
// running set of names seeded from a single `readdir(destDir)` and updated
// as each source is assigned a destination name. For the cut path this is
// not optional the way it's a nice-to-have for copy: `ops/move.ts`'s
// `rename` call silently overwrites an existing destination, so a
// `destName` reaching it un-resolved is exactly the data-loss shape the
// plan calls out. Both `runPasteJob` and `runCutJob` call this same
// function, not two copies of the same logic, so there is exactly one place
// that decides a destination name is safe to write to.

import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import {
  type ArchiveError,
  type ArchiveProgress,
  createZip,
  extractZip,
} from "../archive/zip.ts";
import { uniqueName } from "./conflict.ts";
import { type CopyError, type CopyProgress, copyAll } from "./copy.ts";
import { checkContainment } from "./guard.ts";
import { RemoveAbortedError, remove } from "./index.ts";
import { type MoveOutcome, type RenameFn, moveAll } from "./move.ts";

export type SkippedSource = { src: string; message: string };

type PlannedJob = { src: string; destName: string };

/**
 * Shared by `runPasteJob` and `runCutJob`: reject anything the containment
 * guard rejects, then resolve every accepted source's destination name
 * against the destination's actual listing (plus whatever earlier sources
 * in this same batch already claimed), exactly once. See the file header
 * for why this one function is what makes conflict resolution "before
 * `rename`" true for the cut path.
 */
async function planJobs(
  sources: string[],
  destDir: string,
): Promise<{ jobs: PlannedJob[]; skipped: SkippedSource[] }> {
  const skipped: SkippedSource[] = [];
  const accepted: string[] = [];
  for (const src of sources) {
    const result = await checkContainment(src, destDir);
    if (result.ok) accepted.push(src);
    else skipped.push({ src, message: result.message });
  }

  // A destDir that fails to read here degrades conflict resolution to "no
  // known collisions" rather than failing the whole operation —
  // COPYFILE_EXCL in copy.ts is still the real backstop on the copy path;
  // there is no equivalent backstop on the move/rename path (see
  // move.ts's file header), so this readdir failing is a real, if rare,
  // gap there.
  let existing = new Set<string>();
  try {
    existing = new Set(await readdir(destDir));
  } catch {
    // see comment above
  }

  const jobs = accepted.map((src) => {
    const name = uniqueName(basename(src), existing);
    existing.add(name);
    return { src, destName: name };
  });

  return { jobs, skipped };
}

let jobInFlight = false;

/** True while a paste or cut job is running. Exposed for tests and belt-and-braces UI checks. */
export function isBusy(): boolean {
  return jobInFlight;
}

// ── paste (copy) ──

export type PasteOutcome = {
  copiedSources: string[];
  errors: CopyError[];
  cancelled: boolean;
  /** Sources rejected by the containment guard before copying ever started. */
  skipped: SkippedSource[];
};

export type PasteOptions = {
  destDir: string;
  sources: string[];
  signal?: AbortSignal;
  onProgress?: (progress: CopyProgress) => void;
};

export async function runPasteJob(opts: PasteOptions): Promise<PasteOutcome> {
  if (jobInFlight) {
    return {
      copiedSources: [],
      errors: [],
      cancelled: false,
      skipped: opts.sources.map((src) => ({
        src,
        message: "a copy is already in progress",
      })),
    };
  }

  jobInFlight = true;
  try {
    const { jobs, skipped } = await planJobs(opts.sources, opts.destDir);
    if (jobs.length === 0) {
      return { copiedSources: [], errors: [], cancelled: false, skipped };
    }

    const outcome = await copyAll(jobs, {
      destDir: opts.destDir,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });

    return { ...outcome, skipped };
  } finally {
    jobInFlight = false;
  }
}

// ── cut (move) ──

export type CutOutcome = {
  movedSources: string[];
  errors: CopyError[];
  cancelled: boolean;
  /** Sources rejected by the containment guard before moving ever started. */
  skipped: SkippedSource[];
};

export type CutOptions = {
  destDir: string;
  sources: string[];
  signal?: AbortSignal;
  onProgress?: (progress: CopyProgress) => void;
  /** Test-only injection point, forwarded to `ops/move.ts`'s `moveAll` —
   * see move.ts's `RenameFn` for why this exists. */
  renameFn?: RenameFn;
  streamThresholdBytes?: number;
  streamChunkBytes?: number;
};

export async function runCutJob(opts: CutOptions): Promise<CutOutcome> {
  if (jobInFlight) {
    return {
      movedSources: [],
      errors: [],
      cancelled: false,
      skipped: opts.sources.map((src) => ({
        src,
        message: "an operation is already in progress",
      })),
    };
  }

  jobInFlight = true;
  try {
    const { jobs, skipped } = await planJobs(opts.sources, opts.destDir);
    if (jobs.length === 0) {
      return { movedSources: [], errors: [], cancelled: false, skipped };
    }

    const outcome: MoveOutcome = await moveAll(jobs, {
      destDir: opts.destDir,
      signal: opts.signal,
      onProgress: opts.onProgress,
      renameFn: opts.renameFn,
      streamThresholdBytes: opts.streamThresholdBytes,
      streamChunkBytes: opts.streamChunkBytes,
    });

    return { ...outcome, skipped };
  } finally {
    jobInFlight = false;
  }
}

// ── delete (Phase 7) ──

export type DeleteError = { src: string; message: string };

export type DeleteOutcome = {
  deletedSources: string[];
  errors: DeleteError[];
  cancelled: boolean;
};

export type DeleteProgress = {
  done: number;
  total: number;
  currentPath: string;
};

export type DeleteOptions = {
  sources: string[];
  signal?: AbortSignal;
  onProgress?: (progress: DeleteProgress) => void;
};

/**
 * Delete every source in turn through `ops/index.ts`'s `remove()` — one job
 * at a time, sharing `jobInFlight` with paste/cut, so a delete suppresses
 * the watcher's rescan (`main.ts`'s `isBusy()` check) exactly like they do,
 * and a delete can never interleave with a paste or another delete.
 *
 * There is no `planJobs` step here: delete has no destination, so neither
 * the containment guard nor conflict-name resolution applies — every
 * source the caller hands in is attempted.
 *
 * Progress is per top-level source (`done`/`total` count sources, not
 * descendant files or bytes) — coarser than copy's, an accepted
 * simplification: `remove()` has no upfront total to report, and
 * `state/store.ts`'s confirm overlay already did a separate, capped count
 * for the blast-radius message before this job ever starts, which is not
 * the same number and is not threaded through here.
 */
export async function runDeleteJob(
  opts: DeleteOptions,
): Promise<DeleteOutcome> {
  if (jobInFlight) {
    return {
      deletedSources: [],
      errors: opts.sources.map((src) => ({
        src,
        message: "an operation is already in progress",
      })),
      cancelled: false,
    };
  }

  jobInFlight = true;
  try {
    const total = opts.sources.length;
    const deleted: string[] = [];
    const errors: DeleteError[] = [];

    for (let i = 0; i < opts.sources.length; i++) {
      const src = opts.sources[i];
      if (src === undefined) continue;
      if (opts.signal?.aborted) {
        return { deletedSources: deleted, errors, cancelled: true };
      }
      try {
        await remove(src, {
          signal: opts.signal,
          onProgress: (path) =>
            opts.onProgress?.({ done: i, total, currentPath: path }),
        });
        deleted.push(src);
      } catch (err) {
        if (err instanceof RemoveAbortedError) {
          return { deletedSources: deleted, errors, cancelled: true };
        }
        errors.push({
          src,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      opts.onProgress?.({ done: i + 1, total, currentPath: src });
    }

    return { deletedSources: deleted, errors, cancelled: false };
  } finally {
    jobInFlight = false;
  }
}

// ── archives (Phase 8) ──
//
// Both jobs below share `jobInFlight` with paste/cut/delete above — a `z`
// or `u` racing a paste (or each other) would interleave two operations'
// progress into the same overlay exactly like a cut racing a paste would,
// so both refuse a second call while anything is already running
// (state/store.ts's `startArchive()`/`startExtract()` also check
// `state.overlay` before ever calling in, so this is a backstop, not the
// primary guard — same relationship `runPasteJob` has to `paste()`).
// Neither needs its own `planJobs`-style conflict resolution: `createZip`'s
// destination name and `extractZip`'s destination directory are both
// already conflict-resolved by the caller before the job is ever queued
// (see `submitPrompt`'s `archive` branch and `startExtract()`).

export type CreateArchiveOutcome = {
  addedCount: number;
  errors: ArchiveError[];
  cancelled: boolean;
};

export type CreateArchiveOptions = {
  zipPath: string;
  sources: string[];
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
};

export async function runCreateArchiveJob(
  opts: CreateArchiveOptions,
): Promise<CreateArchiveOutcome> {
  if (jobInFlight) {
    return {
      addedCount: 0,
      errors: opts.sources.map((path) => ({
        path,
        message: "an operation is already in progress",
      })),
      cancelled: false,
    };
  }
  jobInFlight = true;
  try {
    return await createZip(opts.zipPath, opts.sources, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  } finally {
    jobInFlight = false;
  }
}

export type ExtractArchiveOutcome = {
  extractedCount: number;
  errors: ArchiveError[];
  cancelled: boolean;
};

export type ExtractArchiveOptions = {
  zipPath: string;
  destDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
};

export async function runExtractArchiveJob(
  opts: ExtractArchiveOptions,
): Promise<ExtractArchiveOutcome> {
  if (jobInFlight) {
    return {
      extractedCount: 0,
      errors: [
        { path: opts.zipPath, message: "an operation is already in progress" },
      ],
      cancelled: false,
    };
  }
  jobInFlight = true;
  try {
    return await extractZip(opts.zipPath, opts.destDir, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  } finally {
    jobInFlight = false;
  }
}
