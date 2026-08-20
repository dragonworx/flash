// fsapi/ops/conflict.ts — pure conflict resolution: turn a name that
// collides with something already at the destination into one that
// doesn't, by inserting an incrementing suffix before the extension.
//
// Pure function, no filesystem access — callers pass in the set of names
// already present in the destination directory (ops/queue.ts reads that set
// with `readdir` once per paste). Heavily tested (tests/conflict.test.ts)
// because Phase 5b's move path depends on this running before every
// `rename()` call: `fsp.rename` silently overwrites an existing
// destination, so this file is the only thing standing between a
// paste-onto-an-existing-name and data loss on the cut/move path. Phase 5a
// only needs the copy side, where `COPYFILE_EXCL` is a second backstop, but
// the function itself does not know or care which caller it's serving.

// Suffixes land before these, as a single unit, so `report.tar.gz` becomes
// `report 2.tar.gz` rather than the wrong `report.tar 2.gz`. Longest first
// is not required for correctness here (none is a suffix of another), but
// keeps the list self-evidently exhaustive rather than order-dependent.
const DOUBLE_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz"];

/**
 * Split `name` into `[base, ext]` so a suffix can be inserted between them.
 * Known double extensions are treated as one unit first. Otherwise, the
 * last dot splits base from extension — except when that dot is the first
 * character (a dotfile like `.bashrc`, which has no extension at all: the
 * leading dot is part of the name) or the last character (a trailing dot
 * with nothing after it, e.g. `weird.`, which is likewise not a real
 * extension to split off). Both of those fall back to "no extension".
 */
function splitExtension(name: string): [base: string, ext: string] {
  for (const double of DOUBLE_EXTENSIONS) {
    if (name.length > double.length && name.endsWith(double)) {
      return [name.slice(0, -double.length), double];
    }
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * `report.txt` -> `report 2.txt` -> `report 3.txt` against a destination
 * that already holds both, per the plan. Returns `name` unchanged when it
 * does not collide. Otherwise always returns a name absent from
 * `existingNames`, incrementing past however many numbered collisions
 * already exist (including a destination deliberately pre-seeded with
 * `report 2.txt` .. `report 50.txt`) — the loop terminates because
 * `existingNames` is finite while the candidate suffix keeps growing.
 */
export function uniqueName(
  name: string,
  existingNames: Iterable<string>,
): string {
  const existing =
    existingNames instanceof Set ? existingNames : new Set(existingNames);
  if (!existing.has(name)) return name;

  const [base, ext] = splitExtension(name);
  let n = 2;
  let candidate = `${base} ${n}${ext}`;
  while (existing.has(candidate)) {
    n++;
    candidate = `${base} ${n}${ext}`;
  }
  return candidate;
}
