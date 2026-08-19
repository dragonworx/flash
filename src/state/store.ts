// state/store.ts — AppState + actions + subscribe.
//
// One object, per the plan: cursor, sort spec, hidden-file toggle, marks,
// clipboard, overlay, and the per-directory cursor history all live as
// fields here (or as private fields on this class) rather than split across
// modules — splitting them invites circular imports between fsapi, ui, and
// state that the plan explicitly warns against.
//
// `Store` never touches the screen or stdout. Every action ends by calling
// `notify()`, which is the one hook `main.ts` wires to its own dirty-flag
// repaint scheduler (see main.ts's `requestRepaint`) — this file only sets
// the flag main.ts already has, it does not invent a second render loop.
//
// Per-directory cursor history: a single `Map<dir, childName>` does double
// duty. Descending into a directory (`enter()`) records, against the
// directory being *left*, the name of the entry the cursor was on — which
// is exactly the child being entered. Ascending (`up()`) looks that same
// map up for the *destination* directory, falling back to "the directory
// I'm leaving" when there is no recorded history (e.g. flash was launched
// directly into a deep path via `-d`). That fallback is what makes "go up"
// land on the directory you came from even on the very first move.

import { lstatSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Entry } from "../fsapi/entry.ts";
import {
  DEFAULT_SORT,
  SORT_KEYS,
  type SortKey,
  type SortSpec,
  scan,
  sortEntries,
} from "../fsapi/scan.ts";
import { stringWidth } from "../term/width.ts";

// ── types ──

export type ViewMode = "list" | "grid";

export type Message = { text: string; kind: "info" | "error" };

/**
 * No overlay exists yet in Phase 2 — this is a stub so `AppState.overlay`
 * has a real (if empty) type, and so Phase 4/7's confirm/prompt/permissions
 * overlays and the Escape precedence table in keymap.ts have somewhere to
 * slot in without changing this file's shape.
 */
export type Overlay = { kind: "help" };

export type AppState = {
  cwd: string;
  entries: Entry[]; // raw scan results for cwd, unfiltered, baseline-sorted
  scanError: string | null;
  cursor: number; // index into visibleEntries()
  scrollTop: number;
  marked: Set<string>;
  view: ViewMode;
  showHidden: boolean;
  sort: SortSpec;
  clipboard: { mode: "copy" | "cut"; paths: string[] } | null;
  overlay: Overlay | null;
  message: Message | null;
  archive: { zipPath: string; innerPath: string } | null;
};

export type StoreInit = {
  cwd: string;
  showHidden?: boolean;
  sort?: SortSpec;
  view?: ViewMode;
};

const MESSAGE_TTL_MS = 4000;

// ── Store ──

export class Store {
  private state: AppState;
  private listeners = new Set<() => void>();
  private history = new Map<string, string>(); // dir path -> selected child name
  private messageTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(init: StoreInit) {
    this.state = {
      cwd: init.cwd,
      entries: [],
      scanError: null,
      cursor: 0,
      scrollTop: 0,
      marked: new Set(),
      view: init.view ?? "list",
      showHidden: init.showHidden ?? false,
      sort: init.sort ?? DEFAULT_SORT,
      clipboard: null,
      overlay: null,
      message: null,
      archive: null,
    };
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  // ── derived view ──

  /**
   * Real scanned children, hidden-filtered and sorted per `state.sort`, with
   * a synthetic ".." row prepended (unless `cwd` is the filesystem root).
   * The ".." row is real metadata — `lstatSync` on the parent — not zeros,
   * so it renders through the same formatters as everything else; it is
   * never affected by hidden-filtering or sorting.
   */
  visibleEntries(): Entry[] {
    const filtered = this.state.showHidden
      ? this.state.entries
      : this.state.entries.filter((e) => !e.name.startsWith("."));
    const sorted = sortEntries(filtered, this.state.sort);
    const parent = this.parentEntry();
    return parent ? [parent, ...sorted] : sorted;
  }

  /** Count of real entries only (never counts the synthetic ".." row). */
  itemCount(): number {
    return this.state.showHidden
      ? this.state.entries.length
      : this.state.entries.filter((e) => !e.name.startsWith(".")).length;
  }

  private parentEntry(): Entry | null {
    const parent = dirname(this.state.cwd);
    if (parent === this.state.cwd) return null; // already at the filesystem root
    try {
      const st = lstatSync(parent);
      return {
        name: "..",
        path: parent,
        kind: "dir",
        size: st.size,
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        mtimeMs: st.mtimeMs,
        width: stringWidth(".."),
      };
    } catch {
      return {
        name: "..",
        path: parent,
        kind: "dir",
        size: 0,
        mode: 0,
        uid: 0,
        gid: 0,
        mtimeMs: 0,
        width: stringWidth(".."),
      };
    }
  }

  // ── loading ──

  /**
   * Scan `dir` and replace state with the result. `preferredName`, when
   * given, wins over recorded history for where the cursor lands (used by
   * `up()`, which always wants to land on the directory it just left).
   */
  async load(dir: string, preferredName?: string): Promise<void> {
    const result = await scan(dir);
    this.state.cwd = dir;
    if (result.ok) {
      this.state.entries = result.entries;
      this.state.scanError = null;
    } else {
      this.state.entries = [];
      this.state.scanError = result.error;
    }
    this.state.scrollTop = 0;
    this.setCursorByName(preferredName ?? this.history.get(dir));
    this.notify();
  }

  private setCursorByName(name: string | undefined): void {
    const list = this.visibleEntries();
    if (list.length === 0) {
      this.state.cursor = 0;
      return;
    }
    if (name !== undefined) {
      const idx = list.findIndex((e) => e.name === name);
      if (idx >= 0) {
        this.state.cursor = idx;
        return;
      }
    }
    // No history, or the remembered entry is gone: land on the first real
    // entry (skip the synthetic ".." row) when there is one.
    this.state.cursor = list.length > 1 ? 1 : 0;
  }

  private recordHistory(): void {
    const list = this.visibleEntries();
    const current = list[this.state.cursor];
    if (current) this.history.set(this.state.cwd, current.name);
  }

  // ── navigation ──

  moveCursor(delta: number): void {
    const list = this.visibleEntries();
    if (list.length === 0) return;
    const next = this.state.cursor + delta;
    this.state.cursor = Math.max(0, Math.min(list.length - 1, next));
    this.notify();
  }

  moveCursorTo(pos: "home" | "end"): void {
    const list = this.visibleEntries();
    if (list.length === 0) return;
    this.state.cursor = pos === "home" ? 0 : list.length - 1;
    this.notify();
  }

  pageMove(direction: "up" | "down", pageSize: number): void {
    this.moveCursor(direction === "up" ? -pageSize : pageSize);
  }

  /** Keep `cursor` inside `[scrollTop, scrollTop + height)`, adjusting scrollTop minimally. */
  ensureVisible(height: number): void {
    if (height <= 0) return;
    if (this.state.cursor < this.state.scrollTop) {
      this.state.scrollTop = this.state.cursor;
    } else if (this.state.cursor >= this.state.scrollTop + height) {
      this.state.scrollTop = this.state.cursor - height + 1;
    }
    const list = this.visibleEntries();
    const maxTop = Math.max(0, list.length - height);
    this.state.scrollTop = Math.max(0, Math.min(this.state.scrollTop, maxTop));
  }

  /**
   * Enter the entry under the cursor if it is a directory, or a symlink
   * resolving to one (`targetKind === "dir"`) — Phase 2 is read-only
   * browsing, so anything else is a no-op. Selecting the ".." row goes up.
   */
  async enter(): Promise<void> {
    const list = this.visibleEntries();
    const entry = list[this.state.cursor];
    if (!entry) return;
    if (entry.name === "..") {
      await this.up();
      return;
    }
    const isDirLike =
      entry.kind === "dir" ||
      (entry.kind === "symlink" && entry.targetKind === "dir");
    if (!isDirLike) return;
    this.recordHistory();
    await this.load(entry.path);
  }

  /** Go up one directory. A no-op at the filesystem root. */
  async up(): Promise<void> {
    const parent = dirname(this.state.cwd);
    if (parent === this.state.cwd) return;
    const childName = basename(this.state.cwd);
    this.recordHistory();
    // Prefer the directory just left over any older recorded history for
    // the parent — that is the whole point of this method.
    await this.load(parent, childName || undefined);
  }

  // ── toggles ──

  toggleHidden(): void {
    const list = this.visibleEntries();
    const currentName = list[this.state.cursor]?.name;
    this.state.showHidden = !this.state.showHidden;
    this.setCursorByName(currentName);
    this.notify();
  }

  cycleSort(): void {
    const idx = SORT_KEYS.indexOf(this.state.sort.key);
    const next: SortKey = SORT_KEYS[(idx + 1) % SORT_KEYS.length] ?? "name";
    this.setSort({ ...this.state.sort, key: next });
  }

  toggleSortReverse(): void {
    this.setSort({ ...this.state.sort, reverse: !this.state.sort.reverse });
  }

  private setSort(sort: SortSpec): void {
    const list = this.visibleEntries();
    const currentName = list[this.state.cursor]?.name;
    this.state.sort = sort;
    this.setCursorByName(currentName);
    this.notify();
  }

  // ── messages ──

  setMessage(text: string, kind: Message["kind"] = "info"): void {
    if (this.messageTimer !== null) clearTimeout(this.messageTimer);
    this.state.message = { text, kind };
    this.messageTimer = setTimeout(() => {
      this.messageTimer = null;
      this.state.message = null;
      this.notify();
    }, MESSAGE_TTL_MS);
    this.notify();
  }
}
