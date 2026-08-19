// tests/helpers.ts — shared fixture setup, not itself a test file.
//
// `tests/fixtures/sample/` is committed with a subdirectory, a normal file,
// and a dotfile; the broken symlink is deliberately *not* committed (a
// broken symlink checked into git is a portability footgun whose target
// means nothing on a fresh clone), so any test that needs it creates it
// here, idempotently, at setup time instead.

import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dir, "fixtures", "sample");
export const BROKEN_LINK_PATH = join(FIXTURE_DIR, "broken-link");

/**
 * Create `broken-link -> does-not-exist` in the fixture dir if missing.
 * Deliberately does not check existence first with `existsSync` — it
 * follows symlinks, so it reports `false` for an already-broken link and
 * would make this function try (and fail) to recreate it every call.
 * Catching `EEXIST` from `symlinkSync` directly is the correct check.
 */
export function ensureBrokenSymlink(): void {
  try {
    symlinkSync("does-not-exist", BROKEN_LINK_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** Test-only cleanup, in case a run wants a pristine fixture afterward. */
export function removeBrokenSymlink(): void {
  try {
    unlinkSync(BROKEN_LINK_PATH);
  } catch {
    // Already gone — fine.
  }
}
