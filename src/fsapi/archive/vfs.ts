// fsapi/archive/vfs.ts — a read-only virtual directory over a zip archive,
// so browsing one feels exactly like browsing a real directory.
//
// zip entries are flat paths ("a/b/c.txt") — there is no directory object
// in the format unless the archiving tool bothered to write one (many
// don't). `buildTree()` below synthesizes every intermediate directory a
// flat member list implies, so `a/` and `a/b/` exist and are navigable even
// when the archive itself never listed them. An explicit directory member
// (a name ending in "/", carrying its own real mode/mtime from the central
// directory) fills in a synthesized directory's metadata if one shows up
// for it; a directory that stays synthesized-only keeps a plain default
// (`DEFAULT_DIR_MODE`).
//
// `loadArchiveTree()` is the cache: state/store.ts calls it once when a
// `.zip` is opened and holds onto the resulting `ArchiveTree`, so navigating
// around inside an already-open archive (`archiveEntriesAt`) never touches
// the filesystem again — the plan's "cache the member list per archive so
// navigating inside it doesn't re-read the file every keystroke." The cache
// itself is keyed by path and invalidated on the zip file's own `mtimeMs`:
// if the file on disk changed since it was last parsed (edited, replaced,
// re-created), the next `loadArchiveTree()` call re-reads it rather than
// serving stale contents forever.
//
// Every synthesized `Entry` is read-only browsing material only: `uid`/
// `gid` are 0 (there's no meaningful owner inside a zip), and `path` is a
// synthetic `zipPath::innerPath` string — never a real filesystem path —
// specifically so it can never collide with (or be mistaken for) one by
// anything that keys off `Entry.path`, like `state.marked`. state/store.ts
// refuses every write operation (rename, delete, chmod, mkdir, paste-into)
// while `state.archive` is set; this file has no enforcement role in that
// at all, it only ever hands back data.

import { stat } from "node:fs/promises";
import { stringWidth } from "../../term/width.ts";
import type { Entry, Kind } from "../entry.ts";
import { type ZipEntryMeta, listZip } from "./zip.ts";

// ── tree ──

type DirNode = {
  kind: "dir";
  name: string;
  mode: number;
  mtimeMs: number;
  children: Map<string, TreeNode>;
};

type FileNode = {
  kind: "file";
  name: string;
  size: number;
  mode: number;
  mtimeMs: number;
};

type TreeNode = DirNode | FileNode;

export type ArchiveTree = {
  zipPath: string;
  /** The zip FILE's own mtime at load time — the cache-invalidation key. */
  mtimeMs: number;
  root: DirNode;
};

const DEFAULT_DIR_MODE = 0o040755;

function newDir(
  name: string,
  mode = DEFAULT_DIR_MODE,
  mtimeMs = Date.now(),
): DirNode {
  return { kind: "dir", name, mode, mtimeMs, children: new Map() };
}

/** Build the synthetic tree from a flat member list — see the file header. */
function buildTree(entries: ZipEntryMeta[]): DirNode {
  const root = newDir("");
  for (const e of entries) {
    const parts = e.name.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;

    let dir = root;
    const dirParts = e.isDir ? parts : parts.slice(0, -1);
    for (const part of dirParts) {
      const existing = dir.children.get(part);
      if (existing && existing.kind === "dir") {
        dir = existing;
        continue;
      }
      // A file happened to occupy this name already (a malformed/pathological
      // archive) — a directory always wins, since something below needs it
      // to exist as one to be reachable at all.
      const created = newDir(part);
      dir.children.set(part, created);
      dir = created;
    }

    if (e.isDir) {
      // `dir` is now the node for this very entry — fold in its real
      // mode/mtime rather than the synthesized default.
      dir.mode = e.mode;
      dir.mtimeMs = e.mtimeMs;
      continue;
    }

    const leaf = parts[parts.length - 1] as string;
    dir.children.set(leaf, {
      kind: "file",
      name: leaf,
      size: e.size,
      mode: e.mode,
      mtimeMs: e.mtimeMs,
    });
  }
  return root;
}

const cache = new Map<string, ArchiveTree>();

/**
 * Load (or reuse the cached) tree for `zipPath`. Invalidated by the zip
 * file's own `mtimeMs` — see the file header.
 */
export async function loadArchiveTree(zipPath: string): Promise<ArchiveTree> {
  const st = await stat(zipPath);
  const cached = cache.get(zipPath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;

  const entries = await listZip(zipPath);
  const tree: ArchiveTree = {
    zipPath,
    mtimeMs: st.mtimeMs,
    root: buildTree(entries),
  };
  cache.set(zipPath, tree);
  return tree;
}

function findDir(tree: ArchiveTree, innerPath: string): DirNode | null {
  if (innerPath === "") return tree.root;
  let dir = tree.root;
  for (const part of innerPath.split("/").filter((p) => p.length > 0)) {
    const next = dir.children.get(part);
    if (!next || next.kind !== "dir") return null;
    dir = next;
  }
  return dir;
}

/** Synthetic `Entry.path` for a member — see the file header on why this is
 * never a real filesystem path. */
export function archiveEntryPath(zipPath: string, innerPath: string): string {
  return `${zipPath}::${innerPath}`;
}

function nodeToEntry(
  zipPath: string,
  innerPath: string,
  node: TreeNode,
): Entry {
  const kind: Kind = node.kind === "dir" ? "dir" : "file";
  return {
    name: node.name,
    path: archiveEntryPath(zipPath, innerPath),
    kind,
    size: node.kind === "file" ? node.size : 0,
    mode: node.mode,
    uid: 0,
    gid: 0,
    mtimeMs: node.mtimeMs,
    width: stringWidth(node.name),
  };
}

/** The children of `innerPath` inside `tree`, as ordinary `Entry` values —
 * `state/store.ts`'s `visibleEntries()` sorts/filters these exactly like a
 * real scan result, since nothing about `Entry` itself is archive-specific.
 * An `innerPath` that doesn't resolve to a directory (shouldn't happen in
 * normal navigation) yields an empty list rather than throwing. */
export function archiveEntriesAt(
  tree: ArchiveTree,
  innerPath: string,
): Entry[] {
  const dir = findDir(tree, innerPath);
  if (!dir) return [];
  const out: Entry[] = [];
  for (const child of dir.children.values()) {
    const childInner = archiveChildInner(innerPath, child.name);
    out.push(nodeToEntry(tree.zipPath, childInner, child));
  }
  return out;
}

// ── inner-path arithmetic (posix-style; zip member paths are always "/") ──

export function archiveChildInner(
  innerPath: string,
  childName: string,
): string {
  return innerPath === "" ? childName : `${innerPath}/${childName}`;
}

export function archiveParentInner(innerPath: string): string {
  const idx = innerPath.lastIndexOf("/");
  return idx === -1 ? "" : innerPath.slice(0, idx);
}

export function archiveBasename(innerPath: string): string {
  const idx = innerPath.lastIndexOf("/");
  return idx === -1 ? innerPath : innerPath.slice(idx + 1);
}

/** Whether `entry` (a real filesystem entry, never one already inside an
 * archive) is a zip file `enter()` should open as one. */
export function isZipFile(entry: Entry): boolean {
  return (
    entry.kind === "file" &&
    !entry.error &&
    entry.name.toLowerCase().endsWith(".zip")
  );
}
