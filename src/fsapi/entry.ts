// fsapi/entry.ts — the Entry type every view and scan result hangs off, plus
// pure formatters for the metadata columns the list view renders.
//
// `Entry` mirrors the plan's sketch with two additions `scan.ts` needs:
// `targetKind`, because `lstat` alone cannot tell you what a symlink points
// at (a second guarded `stat()` populates it — see scan.ts), and `width`,
// the entry's display width cached once at scan time so no view ever
// measures a name per row per frame (see term/width.ts and the plan's
// "Risks to watch" / Freezing the UI).
//
// The three formatters below are pure and unit-tested in isolation
// (tests/entry.test.ts) — no filesystem, no clock dependency beyond an
// injectable `now` for formatMtime.

import { constants } from "node:fs";

// ── types ──

export type Kind = "dir" | "file" | "symlink" | "other";

export type Entry = {
  name: string;
  path: string;
  kind: Kind;
  /** Symlinks only: what `stat()` resolves to once the link is followed. */
  targetKind?: Kind;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  linkTarget?: string;
  /** Symlink whose target could not be stat()'d (ENOENT or a loop). */
  broken?: boolean;
  /** Set when this child failed to stat at all; scan.ts never throws instead. */
  error?: string;
  /** Display width of `name`, measured once at scan time (term/width.ts). */
  width: number;
};

// ── formatSize ──

const SIZE_UNITS = ["K", "M", "G", "T", "P"] as const;

/**
 * Binary (1024-based) size formatting: `1.2K`, `340M`. Bytes below 1024 are
 * shown as a plain number with no unit letter, matching `ls -lh`. One
 * decimal place while the value is still single-digit, none once it rounds
 * up to two-plus digits — that keeps the column narrow without losing
 * precision where it matters.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.trunc(bytes)}`;

  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = SIZE_UNITS[Math.max(unitIndex, 0)];
  const formatted = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${formatted}${unit}`;
}

// ── formatMode ──

const TYPE_CHARS: Record<number, string> = {
  [constants.S_IFDIR]: "d",
  [constants.S_IFCHR]: "c",
  [constants.S_IFBLK]: "b",
  [constants.S_IFREG]: "-",
  [constants.S_IFIFO]: "p",
  [constants.S_IFLNK]: "l",
  [constants.S_IFSOCK]: "s",
};

/**
 * rwx triad for one 3-bit permission group, with an optional special bit
 * (setuid/setgid on owner/group, sticky on other) folded into the x slot —
 * lowercase when exec is also set, uppercase when it is not, the usual `ls`
 * convention. `specialChar` distinguishes "s" (setuid/setgid) from "t"
 * (sticky); which one applies depends on which triad this is, so the caller
 * passes it rather than this function guessing from position.
 */
function triad(
  perm3: number,
  specialBit: boolean,
  specialChar: "s" | "t",
): string {
  const r = perm3 & 0o4 ? "r" : "-";
  const w = perm3 & 0o2 ? "w" : "-";
  const exec = (perm3 & 0o1) !== 0;
  const upper = specialChar === "s" ? "S" : "T";
  const x = specialBit ? (exec ? specialChar : upper) : exec ? "x" : "-";
  return r + w + x;
}

/** `drwxr-xr-x` style mode string from a raw `stat().mode`. */
export function formatMode(mode: number): string {
  const typeChar = TYPE_CHARS[mode & constants.S_IFMT] ?? "-";
  const owner = triad((mode >> 6) & 0o7, (mode & 0o4000) !== 0, "s");
  const group = triad((mode >> 3) & 0o7, (mode & 0o2000) !== 0, "s");
  const other = triad(mode & 0o7, (mode & 0o1000) !== 0, "t");
  return typeChar + owner + group + other;
}

// ── formatMtime ──

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Relative under a week ("just now", "5m ago", "3h ago", "2d ago"),
 * `YYYY-MM-DD` beyond that (or for a future timestamp, which relative
 * phrasing does not handle sensibly). `now` is injectable for tests.
 */
export function formatMtime(mtimeMs: number, now: number = Date.now()): string {
  const diffSec = Math.floor((now - mtimeMs) / 1000);
  if (diffSec >= 0 && diffSec < WEEK) {
    if (diffSec < MINUTE) return "just now";
    if (diffSec < HOUR) return `${Math.floor(diffSec / MINUTE)}m ago`;
    if (diffSec < DAY) return `${Math.floor(diffSec / HOUR)}h ago`;
    return `${Math.floor(diffSec / DAY)}d ago`;
  }
  const d = new Date(mtimeMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
