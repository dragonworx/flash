// fsapi/ops/queue.ts — runs one paste job at a time and emits progress.
//
// A "job" here is one whole paste operation: potentially many clipboard
// sources copied into one destination directory, sharing a single progress
// bar — per the plan's "queue.ts runs one job at a time, emits {done,
// total, currentPath, bytesDone, bytesTotal}." Only one job runs at a time;
// `runPasteJob` refuses a second call while one is in flight rather than
// interleaving two trees' progress into the same bar (state/store.ts's
// `paste()` also checks this before ever calling in, so the refusal here is
// a backstop, not the primary guard).
//
// Every source is checked through `ops/guard.ts`'s containment check BEFORE
// it is ever handed to `ops/copy.ts` — a source that fails the guard is
// recorded as "skipped" and simply excluded from the batch, so one bad
// paste target (e.g. a folder dragged into its own descendant) doesn't
// block the rest of a multi-select paste.
//
// Conflict resolution (`ops/conflict.ts`) runs once per source, against a
// running set of names seeded from `readdir(destDir)` and updated as each
// source is assigned a destination name — so pasting two same-named items
// in one paste operation resolves both, not just collisions against what
// was already on disk.

import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import { uniqueName } from "./conflict.ts";
import { type CopyError, type CopyProgress, copyAll } from "./copy.ts";
import { checkContainment } from "./guard.ts";

export type SkippedSource = { src: string; message: string };

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

let jobInFlight = false;

/** True while a paste job is running. Exposed for tests and belt-and-braces UI checks. */
export function isBusy(): boolean {
  return jobInFlight;
}

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
    const skipped: SkippedSource[] = [];
    const accepted: string[] = [];
    for (const src of opts.sources) {
      const result = await checkContainment(src, opts.destDir);
      if (result.ok) accepted.push(src);
      else skipped.push({ src, message: result.message });
    }

    // A destDir that fails to read here degrades conflict resolution to
    // "no known collisions" rather than failing the whole paste —
    // COPYFILE_EXCL in copy.ts is still the real backstop against
    // clobbering anything that does turn out to be there.
    let existing = new Set<string>();
    try {
      existing = new Set(await readdir(opts.destDir));
    } catch {
      // see comment above
    }

    const jobs = accepted.map((src) => {
      const name = uniqueName(basename(src), existing);
      existing.add(name);
      return { src, destName: name };
    });

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
