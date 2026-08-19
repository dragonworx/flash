// fsapi/scan.ts — readdir + lstat -> Entry[], error tolerant.
//
// Three requirements here are measured, not stylistic (see the plan's Phase
// 2 section, tested against a real 5,200-entry directory):
//
//   - Never `await lstat` in a sequential loop (247ms). Children are stat'd
//     concurrently via `Promise.all` in chunks of ~256 (9.2ms).
//   - Sort with a module-level `Intl.Collator({numeric: true})` (1.9ms for
//     the whole directory), which also gives natural `file2` before
//     `file10` ordering that `localeCompare` per comparison does not.
//   - `lstat` alone cannot classify a symlink: `dirent.isDirectory()` is
//     false for a symlink to a directory, and `stat()` on a broken link
//     throws ENOENT. Symlinks get a second, guarded `stat()` to populate
//     `targetKind`; a throw there sets `broken: true` instead of failing
//     the whole entry.
//
// Nothing here ever throws past its own boundary. A child that fails to
// stat becomes an `Entry` with `error` set rather than being dropped or
// crashing the scan. `readdir` itself can throw (`EACCES` on `/root`) —
// that comes back as `{ ok: false, error }` for the caller to render as an
// in-pane message, never as an uncaught rejection.

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { stringWidth } from "../term/width.ts";
import type { Entry, Kind } from "./entry.ts";

// A module-level instance: constructing an Intl.Collator is not free, and
// this file's whole point is to sort a possibly-large directory without
// re-paying that cost per call.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const CHUNK_SIZE = 256;

export type ScanResult =
  | { ok: true; entries: Entry[] }
  | { ok: false; error: string };

// ── scan ──

export async function scan(dir: string): Promise<ScanResult> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  const entries: Entry[] = [];
  for (let i = 0; i < dirents.length; i += CHUNK_SIZE) {
    const chunk = dirents.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(chunk.map((d) => statOne(dir, d.name)));
    entries.push(...results);
  }

  return { ok: true, entries: sortEntries(entries, DEFAULT_SORT) };
}

async function statOne(dir: string, name: string): Promise<Entry> {
  const path = join(dir, name);
  const width = stringWidth(name);

  let st: Stats;
  try {
    st = await lstat(path);
  } catch (err) {
    return {
      name,
      path,
      kind: "other",
      size: 0,
      mode: 0,
      uid: 0,
      gid: 0,
      mtimeMs: 0,
      width,
      error: describeError(err),
    };
  }

  const kind = classify(st);
  const entry: Entry = {
    name,
    path,
    kind,
    size: st.size,
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    mtimeMs: st.mtimeMs,
    width,
  };

  if (kind === "symlink") {
    try {
      entry.linkTarget = await readlink(path);
    } catch {
      // Cosmetic only (shown in a future detail view) — never fails the entry.
    }
    try {
      const target = await stat(path); // follows the link fully
      entry.targetKind = classify(target);
    } catch {
      // ENOENT (broken target) or ELOOP (a cycle) — either way, not "other".
      entry.broken = true;
    }
  }

  return entry;
}

function classify(st: Stats): Kind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    if (typeof code === "string" && typeof message === "string")
      return `${code}: ${message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ── sort ──

export type SortKey = "name" | "size" | "mtime" | "extension";
export type SortSpec = { key: SortKey; dirsFirst: boolean; reverse: boolean };

export const DEFAULT_SORT: SortSpec = {
  key: "name",
  dirsFirst: true,
  reverse: false,
};

export const SORT_KEYS: SortKey[] = ["name", "size", "mtime", "extension"];

/** Directories (and symlinks-to-directories) sort ahead of everything else. */
function isDirLike(e: Entry): boolean {
  return e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function compareByKey(a: Entry, b: Entry, key: SortKey): number {
  switch (key) {
    case "name":
      return collator.compare(a.name, b.name);
    case "size":
      return a.size - b.size || collator.compare(a.name, b.name);
    case "mtime":
      return a.mtimeMs - b.mtimeMs || collator.compare(a.name, b.name);
    case "extension":
      return (
        collator.compare(extensionOf(a.name), extensionOf(b.name)) ||
        collator.compare(a.name, b.name)
      );
  }
}

/**
 * Sort a copy of `entries` per `spec`. `dirsFirst` always wins ties ahead of
 * the sort key and is never itself reversed — directories staying pinned to
 * the top regardless of reverse is the convention every file manager this
 * plan is modeled on (ranger, nnn) follows.
 */
export function sortEntries(entries: Entry[], spec: SortSpec): Entry[] {
  const factor = spec.reverse ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (spec.dirsFirst) {
      const aDir = isDirLike(a) ? 0 : 1;
      const bDir = isDirLike(b) ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
    }
    return factor * compareByKey(a, b, spec.key);
  });
}
