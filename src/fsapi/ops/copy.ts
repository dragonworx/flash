// fsapi/ops/copy.ts — recursive copy with byte/file progress and
// cancellation.
//
// Never uses `fs.promises.cp` — see ops/guard.ts's file header for why
// (Bun 1.3.14 segfaults copying a directory into its own descendant). Every
// source tree is walked ONCE (`planOne` below) to total bytes and entry
// count, then a second time to actually copy — so the progress bar's
// denominator is known before the first byte moves rather than growing as
// it goes, per the plan.
//
// Every individual file copies via `copyFile(src, dest, COPYFILE_EXCL)` (or
// the streamed chunk loop for large files, below), which throws rather than
// silently overwriting. `ops/guard.ts` already stops a destination
// directory from being inside its own source tree; `COPYFILE_EXCL` is the
// backstop against clobbering anything else that happens to already be
// there — conflict resolution (ops/conflict.ts) is what's supposed to make
// that never happen, and this is what happens if it's wrong anyway.
//
// This `await`s between every entry (and, for large files, inside the
// streamed copy loop) so the input handler and renderer keep running during
// a long paste — see main.ts's dirty-flag repaint loop and the plan's
// Phase 1 invariant that the loop is async and event-driven, never a
// blocking `while (true)`.
//
// Returns the list of top-level sources that were verifiably copied in
// full. Phase 5b's delete-after-verify will consume exactly this list to
// decide what is safe to remove after a cut: a source with even one failed
// entry anywhere inside it is deliberately left OUT of that list rather
// than partially credited, so an aborted or partially-failed cut can never
// delete more than it actually copied.

import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  copyFile,
  chmod as fsChmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";

// Files at or below this size copy via a single COPYFILE_EXCL call; larger
// files stream in chunks so progress updates during the copy and so Esc can
// cancel mid-file instead of only between files. Both are overridable
// through CopyOptions — production never touches the override, but it lets
// tests exercise the streaming/mid-file-abort path without a multi-megabyte
// fixture.
const DEFAULT_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024; // ~8MB, per the plan
const DEFAULT_STREAM_CHUNK_BYTES = 1024 * 1024; // 1MB

// ── public types ──

export type CopyError = { path: string; message: string };

export type CopyProgress = {
  /** Entries (files + dirs + symlinks) fully processed so far, across every job. */
  done: number;
  /** Total entries planned, across every job — known before copying starts. */
  total: number;
  currentPath: string;
  bytesDone: number;
  bytesTotal: number;
};

export type CopyJob = {
  /** Absolute path to the file/dir/symlink being copied. */
  src: string;
  /** Final basename in the destination directory — already conflict-resolved. */
  destName: string;
};

export type CopyOptions = {
  destDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: CopyProgress) => void;
  /** Test-only override of the streaming threshold; see the file header. */
  streamThresholdBytes?: number;
  /** Test-only override of the stream chunk size; see the file header. */
  streamChunkBytes?: number;
};

export type CopyOutcome = {
  /** `job.src` values whose entire subtree copied with zero errors. */
  copiedSources: string[];
  errors: CopyError[];
  cancelled: boolean;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

class CopyAbortedError extends Error {
  constructor() {
    super("copy aborted");
    this.name = "AbortError";
  }
}

// ── planning: walk each source tree once ──

type PlanEntry = {
  kind: "dir" | "file" | "symlink";
  absSrc: string;
  absDest: string;
  size: number; // 0 for dirs/symlinks
  mode: number;
};

type JobPlan = {
  job: CopyJob;
  entries: PlanEntry[]; // parent directories always precede their contents
  bytes: number;
  walkErrors: CopyError[];
};

async function planOne(job: CopyJob, destDir: string): Promise<JobPlan> {
  const entries: PlanEntry[] = [];
  const walkErrors: CopyError[] = [];
  let bytes = 0;

  async function visit(absSrc: string, relDest: string): Promise<void> {
    const st = await lstat(absSrc).catch((err: unknown) => {
      walkErrors.push({ path: absSrc, message: errorMessage(err) });
      return null;
    });
    if (!st) return;
    const absDest = join(destDir, relDest);

    if (st.isSymbolicLink()) {
      entries.push({
        kind: "symlink",
        absSrc,
        absDest,
        size: 0,
        mode: st.mode,
      });
      return;
    }
    if (st.isDirectory()) {
      entries.push({ kind: "dir", absSrc, absDest, size: 0, mode: st.mode });
      let children: string[];
      try {
        children = await readdir(absSrc);
      } catch (err) {
        walkErrors.push({ path: absSrc, message: errorMessage(err) });
        return;
      }
      for (const child of children) {
        await visit(join(absSrc, child), join(relDest, child));
      }
      return;
    }
    if (st.isFile()) {
      entries.push({
        kind: "file",
        absSrc,
        absDest,
        size: st.size,
        mode: st.mode,
      });
      bytes += st.size;
      return;
    }
    // Sockets, FIFOs, block/char devices: not meaningfully copyable. Record
    // it as an error rather than silently dropping it, so the whole job it
    // belongs to is correctly excluded from `copiedSources`.
    walkErrors.push({
      path: absSrc,
      message: "unsupported file type, skipped",
    });
  }

  await visit(job.src, job.destName);
  return { job, entries, bytes, walkErrors };
}

// ── copying one entry ──

async function applyMode(path: string, mode: number): Promise<void> {
  try {
    await fsChmod(path, mode & 0o7777);
  } catch {
    // Best-effort: preserving permissions is not worth failing an
    // otherwise-successful copy over (e.g. copying onto a filesystem that
    // ignores unix mode bits entirely).
  }
}

async function copySmallFile(entry: PlanEntry, onBytes: (n: number) => void) {
  await copyFile(entry.absSrc, entry.absDest, fsConstants.COPYFILE_EXCL);
  onBytes(entry.size);
  await applyMode(entry.absDest, entry.mode);
}

/**
 * Stream a large file in chunks, checking `signal` between each one so a
 * cancel lands mid-file rather than only between files. On any failure —
 * including abort — the partially-written destination is removed so no
 * half-file is ever left behind; the source file handle is always closed.
 */
async function copyLargeFile(
  entry: PlanEntry,
  signal: AbortSignal | undefined,
  chunkBytes: number,
  onBytes: (n: number) => void,
): Promise<void> {
  const destHandle: FileHandle = await open(
    entry.absDest,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
  );
  try {
    const srcHandle = await open(entry.absSrc, fsConstants.O_RDONLY);
    try {
      const buffer = Buffer.allocUnsafe(chunkBytes);
      let position = 0;
      for (;;) {
        if (signal?.aborted) throw new CopyAbortedError();
        const { bytesRead } = await srcHandle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        await destHandle.write(buffer, 0, bytesRead, null);
        position += bytesRead;
        onBytes(bytesRead);
        await Promise.resolve(); // yield between chunks
      }
    } finally {
      await srcHandle.close();
    }
  } catch (err) {
    await destHandle.close().catch(() => {});
    await rm(entry.absDest, { force: true }).catch(() => {});
    throw err;
  }
  await destHandle.close();
  await applyMode(entry.absDest, entry.mode);
}

async function copyEntry(
  entry: PlanEntry,
  signal: AbortSignal | undefined,
  streamThresholdBytes: number,
  streamChunkBytes: number,
  onBytes: (n: number) => void,
): Promise<void> {
  switch (entry.kind) {
    case "dir":
      await mkdir(entry.absDest, { recursive: true });
      return;
    case "symlink": {
      // Recreate the link itself — never follow it. `readlink` on the
      // source, `symlink` at the destination; the target string is copied
      // verbatim, resolved or not.
      const target = await readlink(entry.absSrc);
      await symlink(target, entry.absDest);
      return;
    }
    case "file":
      if (entry.size <= streamThresholdBytes) {
        await copySmallFile(entry, onBytes);
      } else {
        await copyLargeFile(entry, signal, streamChunkBytes, onBytes);
      }
      return;
  }
}

// ── the whole batch ──

/**
 * Copy every `job` into `opts.destDir`. Walks all of them once to total
 * bytes/entries (so the progress bar's denominator is known up front), then
 * copies. A failure on one entry is recorded and the rest of that job's
 * entries still run — see the file header — but a job with any failure
 * (walk-time or copy-time) is excluded from `copiedSources`. Directory
 * modes are applied only after every entry in the job has been visited, so
 * a restrictively-permissioned source directory doesn't block its own
 * children from being written before its mode is copied over.
 */
export async function copyAll(
  jobs: CopyJob[],
  opts: CopyOptions,
): Promise<CopyOutcome> {
  const { destDir, signal, onProgress } = opts;
  const streamThresholdBytes =
    opts.streamThresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES;
  const streamChunkBytes = opts.streamChunkBytes ?? DEFAULT_STREAM_CHUNK_BYTES;

  const errors: CopyError[] = [];
  const plans: JobPlan[] = [];
  for (const job of jobs) {
    if (signal?.aborted) return { copiedSources: [], errors, cancelled: true };
    const plan = await planOne(job, destDir);
    errors.push(...plan.walkErrors);
    plans.push(plan);
  }

  const bytesTotal = plans.reduce((sum, p) => sum + p.bytes, 0);
  const total = plans.reduce((sum, p) => sum + p.entries.length, 0);

  let bytesDone = 0;
  let done = 0;
  const copiedSources: string[] = [];

  const emit = (currentPath: string): void => {
    onProgress?.({ done, total, currentPath, bytesDone, bytesTotal });
  };

  for (const plan of plans) {
    if (signal?.aborted) return { copiedSources, errors, cancelled: true };
    const dirEntries: PlanEntry[] = [];
    let jobOk = plan.walkErrors.length === 0;

    for (const entry of plan.entries) {
      if (signal?.aborted) return { copiedSources, errors, cancelled: true };
      try {
        await copyEntry(
          entry,
          signal,
          streamThresholdBytes,
          streamChunkBytes,
          (n) => {
            // Emitted on every chunk, not just once per entry, so a large
            // file streams visible progress *during* its own copy — see
            // the file header ("for files over ~8MB, during the copy via
            // a stream"). `done` doesn't advance until the entry as a
            // whole finishes, only `bytesDone`.
            bytesDone += n;
            emit(entry.absSrc);
          },
        );
        if (entry.kind === "dir") dirEntries.push(entry);
      } catch (err) {
        if (isAbortError(err)) {
          return { copiedSources, errors, cancelled: true };
        }
        jobOk = false;
        errors.push({ path: entry.absSrc, message: errorMessage(err) });
      }
      done++;
      emit(entry.absSrc);
      await Promise.resolve(); // yield between entries — see the file header
    }

    // Directory modes last, once every child has actually been written —
    // chmod'ing a restrictive source directory's copy up front would block
    // populating it.
    for (const dirEntry of dirEntries) {
      await applyMode(dirEntry.absDest, dirEntry.mode);
    }

    if (jobOk) copiedSources.push(plan.job.src);
  }

  return { copiedSources, errors, cancelled: false };
}
