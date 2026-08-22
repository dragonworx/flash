// fsapi/ops/index.ts — the small primitives the plan groups here: a
// recursive `remove()` and a single-directory `mkdir()`.
//
// `remove()` exists now because Phase 5b's move needs it: the EXDEV
// fallback in `ops/move.ts` deletes a source only after `copyAll` has
// verified it copied in full (see move.ts's file header), and this is what
// actually does that deletion. Phase 7's delete command will call it again
// later through the confirm overlay and the same job queue, which is why it
// is cancellable and yielding rather than a bare `rm(..., {recursive:
// true})` — a delete of a large tree must not freeze the renderer any more
// than a copy does, per the plan's Phase 1 invariant.
//
// Deliberately hand-rolled rather than `fs.promises.rm(path, {recursive:
// true})`: Node's recursive `rm` is a single call with no yield points and
// no `AbortSignal` support, so a delete of a big tree would block the event
// loop for its entire duration — the same "obvious API is the trap" shape
// the plan calls out for `fs.promises.cp` in guard.ts, just without the
// segfault. Walking the tree ourselves, one entry at a time with an
// `await Promise.resolve()` between them, keeps input and rendering alive
// exactly like `ops/copy.ts` does.
//
// `mkdir()` is the one-liner Phase 7's `n` (new directory) prompt calls. It
// is intentionally not recursive: flash only ever creates one directory at a
// time, inside the directory currently being browsed, so a multi-segment
// recursive mkdir is not a feature this app exposes.
//
// `countTree()` is Phase 7's delete confirm's blast-radius counter — "Delete
// 3 items, including directory 'build/' (412 files)?" needs a number from
// somewhere. Capped and yielding for the same reason `remove()` is: an
// uncapped recursive count over a huge tree would freeze the confirm
// overlay before it even has a chance to show "cancel this," which defeats
// the point of asking first.

import { mkdir as fsMkdir, lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

export type RemoveOptions = {
  signal?: AbortSignal;
  /** Called once per entry (file, symlink, or now-empty directory) removed. */
  onProgress?: (path: string) => void;
};

export class RemoveAbortedError extends Error {
  constructor() {
    super("remove aborted");
    this.name = "AbortError";
  }
}

/**
 * Recursively remove `target`. Files and symlinks are unlinked directly
 * (`lstat`, not `stat`, so a symlink is removed itself and never followed
 * into whatever it points at); directories are emptied child-by-child,
 * depth-first, before the now-empty directory itself is removed. Checked
 * and yielded between every child so a large delete keeps the input handler
 * and renderer running and can be cancelled mid-tree via `opts.signal`.
 */
export async function remove(
  target: string,
  opts: RemoveOptions = {},
): Promise<void> {
  const { signal, onProgress } = opts;
  if (signal?.aborted) throw new RemoveAbortedError();

  const st = await lstat(target);
  if (st.isDirectory()) {
    const children = await readdir(target);
    for (const child of children) {
      if (signal?.aborted) throw new RemoveAbortedError();
      await remove(join(target, child), opts);
      await Promise.resolve(); // yield between entries — see the file header
    }
    await rmdir(target);
  } else {
    await rm(target, { force: true });
  }
  onProgress?.(target);
}

/** Create exactly one new directory. Fails if it already exists — the
 * caller (Phase 7's mkdir prompt) validates the name against the current
 * listing first, so `EEXIST` here means a race, not a normal path. */
export async function mkdir(path: string): Promise<void> {
  await fsMkdir(path);
}

export type CountResult = { count: number; capped: boolean };

/**
 * Count descendants of `target` (files, symlinks, and directories — the
 * confirm overlay's "N files" is deliberately an item count, not a
 * byte-weighted one) recursively, depth-first, stopping the instant `count`
 * reaches `cap` so a huge tree can't stall the caller. `target` itself is
 * never counted, only its contents, matching "directory 'build/' (412
 * files)" — 412 things *inside* build/, not build/ plus 412. An unreadable
 * subdirectory (permission denied partway down) just stops descending
 * there rather than throwing and losing the count gathered so far — the
 * confirm overlay would rather show an undercount than no count at all.
 */
export async function countTree(
  target: string,
  cap: number,
): Promise<CountResult> {
  let count = 0;
  let capped = false;

  async function walk(dir: string): Promise<void> {
    if (capped) return;
    let children: string[];
    try {
      children = await readdir(dir);
    } catch {
      return;
    }
    for (const child of children) {
      if (capped) return;
      count++;
      if (count >= cap) {
        capped = true;
        return;
      }
      const full = join(dir, child);
      let isDir = false;
      try {
        isDir = (await lstat(full)).isDirectory();
      } catch {
        continue; // counted above; just can't tell if it had children of its own
      }
      if (isDir) {
        await Promise.resolve(); // yield between directories — see the file header
        await walk(full);
      }
    }
  }

  await walk(target);
  return { count, capped };
}

/**
 * Total bytes of everything under `target` (not `target` itself), recursed
 * depth-first — the number the footer needs for a selected directory, since
 * `Entry.size` there is just the raw inode size (see fsapi/entry.ts and
 * ui/listView.ts's `sizeText`). Symlinks contribute their own link size and
 * are never followed, matching how a symlink-to-a-directory is already
 * excluded from the file total in state/store.ts's `selectedSize`. An
 * unreadable subdirectory just stops descending there, same as `countTree`
 * above, so one permission error partway down doesn't discard every byte
 * counted before it. Cancellable via `opts.signal` for the same reason
 * `remove`/`countTree` are — the caller aborts as soon as the selection
 * moves on, so a huge tree doesn't keep churning after it's no longer
 * wanted.
 */
export async function dirSize(
  target: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  const { signal } = opts;
  let total = 0;

  async function walk(dir: string): Promise<void> {
    if (signal?.aborted) return;
    let children: string[];
    try {
      children = await readdir(dir);
    } catch {
      return;
    }
    for (const child of children) {
      if (signal?.aborted) return;
      const full = join(dir, child);
      let isDir = false;
      try {
        const st = await lstat(full);
        isDir = st.isDirectory();
        if (!isDir) total += st.size;
      } catch {
        continue;
      }
      if (isDir) {
        await Promise.resolve(); // yield between directories — see the file header
        await walk(full);
      }
    }
  }

  await walk(target);
  return total;
}
