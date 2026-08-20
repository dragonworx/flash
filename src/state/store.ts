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
//
// Phase 4 (selection and clipboard) changes no file on disk — `marked` and
// `clipboard` are pure in-memory bookkeeping. `marked` is keyed by absolute
// path, never by index: indices break the instant Phase 6's watcher
// re-sorts the list out from under a stale index. The Shift+↑/↓ range
// anchor is *not* on `AppState` — like `history` above, it is private
// bookkeeping the renderers never need (see `rangeAnchor`/`rangeLastBounds`
// below and `extendSelection()`).
//
// Phase 5a (paste) is the first thing in this file that touches disk.
// `paste()` is deliberately the only place `fsapi/ops/queue.ts` is called
// from — same shape as `load()`/`enter()`/`up()` above: an async Store
// method that awaits the fs work itself and calls `notify()` when state
// changes, rather than main.ts reaching into fsapi directly. `pasteAbort`
// is bookkeeping in the same spirit as `history`/`rangeAnchor`: not part of
// `AppState`, because the renderer only ever needs the plain progress
// numbers on `state.overlay`, never the controller that produced them.
//
// Clipboard staleness (a path that vanished between copy/cut and paste) is
// handled here, not in ops/queue.ts: vanished paths are filtered out before
// the job is ever queued, and the count of how many were skipped is folded
// into the summary message — the plan leaves this open and recommends
// exactly this over failing the whole paste.
//
// Phase 5b (cut/move) reuses every bit of that machinery: `paste()` now
// branches on `clipboard.mode` and, for a cut, calls `runCut()` instead of
// `runCopy()`. Both go through the same `pasteAbort`/progress-overlay
// bookkeeping, so Esc cancels a cut exactly like it cancels a copy. The one
// real difference: a successful cut clears not just the clipboard but also
// any marks pointing at the sources that actually moved — a cut source no
// longer exists, so a mark left on it would point at nothing (the same
// failure mode Phase 6's `pruneMarks` exists to fix after a rescan, applied
// here eagerly because `runCutJob`'s outcome already tells us exactly which
// paths disappeared). Marks on sources that did NOT move — skipped by the
// guard, or copied-but-failed-to-delete on the EXDEV fallback, see
// ops/move.ts — are deliberately left alone, because those sources still
// exist.
//
// Phase 6 (live updates) adds `refresh()`, the watcher's entry point,
// deliberately separate from `load()` even though both scan a directory:
// `load()` is a navigation — it consults/records per-directory history and
// resets the cursor to "the first real entry" when it has nothing better to
// go on, which is exactly right when you just walked into a directory but
// wrong when the directory under you changed out from under you. `refresh()`
// instead preserves the cursor by path (falling back to its old numeric
// index, clamped, rather than jumping to the top) and prunes only the marks
// that live in the rescanned directory — marks are deliberately allowed to
// persist across navigation (see `clipboardCandidatePaths` below), so a mark
// on a file in some other directory must survive a rescan of whatever
// directory happens to be on screen right now.

import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Entry } from "../fsapi/entry.ts";
import type { CutOutcome, PasteOutcome } from "../fsapi/ops/queue.ts";
import { runCutJob, runPasteJob } from "../fsapi/ops/queue.ts";
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
 * `"help"` is still a stub (Phase 7) — `store.setMessage` covers the `?`
 * key for now, nothing ever sets `overlay` to it. `"progress"` is real as
 * of Phase 5a: `paste()` below sets it for the duration of a copy and the
 * render loop (main.ts's `draw()`) paints it via
 * `ui/overlay/progress.ts`. Its shape matches `CopyProgress` from
 * `fsapi/ops/copy.ts` field-for-field (plus `label`) so `paste()` can
 * spread a progress event straight onto it with no translation layer.
 */
export type Overlay =
  | { kind: "help" }
  | {
      kind: "progress";
      label: string;
      done: number;
      total: number;
      currentPath: string;
      bytesDone: number;
      bytesTotal: number;
    };

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

// How far the cursor advances after `Tab` toggles a mark — a named constant
// per the plan, not inlined, specifically so it stays easy to change.
// Marking a run of files is `Tab`, `Tab`, `Tab`... this is what makes each
// tap land on the next untouched entry instead of re-toggling the same one.
const MARK_ADVANCE = 1;

// ── Store ──

export class Store {
  private state: AppState;
  private listeners = new Set<() => void>();
  private history = new Map<string, string>(); // dir path -> selected child name
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  // Shift+↑/↓ range-select bookkeeping (Phase 4). Not part of `AppState`,
  // same as `history` above — renderers never need to know about the
  // anchor, only the `marked` set it writes into. `rangeAnchor` is the
  // fixed end of the range; `rangeLastBounds` is the [lo, hi] the previous
  // extendSelection() call actually applied, so the next call can un-mark
  // whatever fell out of range without touching marks Tab put there.
  private rangeAnchor: number | null = null;
  private rangeLastBounds: [number, number] | null = null;
  // The in-flight paste's AbortController, if any (Phase 5a). `cancelPaste`
  // aborts it; `paste` clears it in a `finally` so a signal from a
  // superseded call can never be mistaken for the current one — see the
  // `pasteAbort !== abort` check in `paste()`'s onProgress callback.
  private pasteAbort: AbortController | null = null;

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

  /**
   * Re-scan `dir` in place — the watcher's entry point (Phase 6), called
   * after every debounced `fs.watch` burst settles. Not a navigation: it
   * never touches per-directory cursor history, and it preserves the
   * cursor **by path** rather than resetting to the first real entry — the
   * entry under the cursor keeps the cursor if it still exists anywhere in
   * the refreshed listing, and when it's gone the cursor falls back to its
   * previous numeric index, clamped into the new (possibly shorter) list,
   * so a file deleted elsewhere in a large directory doesn't yank the
   * cursor back to the top.
   *
   * Marks are pruned too, but only the ones that live *in* `dir` — a mark
   * on a file in some other directory (marks persist across navigation, see
   * `clipboardCandidatePaths`) says nothing about this rescan and must
   * survive it untouched. When marks actually get dropped, a status message
   * says so, so the user's next paste/cut doesn't silently act on fewer
   * items than they think are selected.
   */
  async refresh(dir: string): Promise<void> {
    const prevList = this.visibleEntries();
    const prevCursorEntry = prevList[this.state.cursor];
    const prevCursor = this.state.cursor;

    const result = await scan(dir);
    this.state.cwd = dir;
    if (result.ok) {
      this.state.entries = result.entries;
      this.state.scanError = null;
    } else {
      this.state.entries = [];
      this.state.scanError = result.error;
    }

    this.resetRangeAnchor();
    const list = this.visibleEntries();
    if (list.length === 0) {
      this.state.cursor = 0;
    } else {
      const idx = prevCursorEntry
        ? list.findIndex((e) => e.path === prevCursorEntry.path)
        : -1;
      this.state.cursor =
        idx >= 0 ? idx : Math.min(prevCursor, list.length - 1);
    }

    const newPaths = new Set(this.state.entries.map((e) => e.path));
    const keep = new Set<string>();
    for (const p of this.state.marked) {
      if (dirname(p) !== dir || newPaths.has(p)) keep.add(p);
    }
    const before = this.state.marked.size;
    this.pruneMarks(keep);
    const dropped = before - this.state.marked.size;
    if (dropped > 0) {
      this.setMessage(
        `${dropped} mark${dropped === 1 ? "" : "s"} dropped — file${dropped === 1 ? "" : "s"} no longer here`,
      );
    }
    this.notify();
  }

  /**
   * Drop the Shift+↑/↓ range anchor. Called from every cursor-moving method
   * except `extendSelection` itself, so a stale anchor from a previous
   * shift-drag never resurfaces after an unrelated move (a plain arrow key,
   * a directory change, a sort/hidden-file toggle that repositions the
   * cursor) — the next Shift+↑/↓ always starts a fresh range from wherever
   * the cursor actually is.
   */
  private resetRangeAnchor(): void {
    this.rangeAnchor = null;
    this.rangeLastBounds = null;
  }

  private setCursorByName(name: string | undefined): void {
    this.resetRangeAnchor();
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
    this.resetRangeAnchor();
    const next = this.state.cursor + delta;
    this.state.cursor = Math.max(0, Math.min(list.length - 1, next));
    this.notify();
  }

  moveCursorTo(pos: "home" | "end"): void {
    const list = this.visibleEntries();
    if (list.length === 0) return;
    this.resetRangeAnchor();
    this.state.cursor = pos === "home" ? 0 : list.length - 1;
    this.notify();
  }

  /**
   * Jump the cursor directly to `index`, clamped into range. Used by grid
   * navigation (`ui/gridView.ts`'s `moveGridCursor`), which computes the
   * destination index itself from 2D geometry rather than a simple delta.
   */
  setCursorIndex(index: number): void {
    const list = this.visibleEntries();
    if (list.length === 0) return;
    this.resetRangeAnchor();
    this.state.cursor = Math.max(
      0,
      Math.min(list.length - 1, Math.trunc(index)),
    );
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

  /** Toggle list/grid, per the visual-design pass's `v` binding. */
  toggleView(): void {
    this.state.view = this.state.view === "list" ? "grid" : "list";
    this.notify();
  }

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

  // ── selection / marks ──

  /**
   * Toggle the mark on the entry under the cursor, then advance the cursor
   * by `MARK_ADVANCE` — the convention that lets a run of files get marked
   * with repeated taps of `Tab`. The synthetic ".." row is never markable.
   */
  toggleMarkAtCursor(): void {
    const list = this.visibleEntries();
    const entry = list[this.state.cursor];
    if (!entry || entry.name === "..") return;
    if (this.state.marked.has(entry.path)) this.state.marked.delete(entry.path);
    else this.state.marked.add(entry.path);
    this.moveCursor(MARK_ADVANCE); // also notifies
  }

  /**
   * Extend the mark range from an anchor (fixed to the cursor's position on
   * the first call after any other cursor movement — see
   * `resetRangeAnchor`) one step toward `direction`. Recomputes the whole
   * `[anchor, cursor]` range on every call: newly-included entries get
   * marked, and whatever fell *out* of the range since the previous call is
   * un-marked — so reversing direction back past the anchor un-marks the
   * far side cleanly instead of leaving a trail, while a mark `Tab` placed
   * outside any extend range is left untouched.
   */
  extendSelection(direction: "up" | "down"): void {
    const list = this.visibleEntries();
    if (list.length === 0) return;
    if (this.rangeAnchor === null) this.rangeAnchor = this.state.cursor;

    const delta = direction === "up" ? -1 : 1;
    const nextCursor = Math.max(
      0,
      Math.min(list.length - 1, this.state.cursor + delta),
    );
    const lo = Math.min(this.rangeAnchor, nextCursor);
    const hi = Math.max(this.rangeAnchor, nextCursor);

    if (this.rangeLastBounds) {
      const [prevLo, prevHi] = this.rangeLastBounds;
      for (let i = prevLo; i <= prevHi; i++) {
        if (i < lo || i > hi) {
          const stale = list[i];
          if (stale) this.state.marked.delete(stale.path);
        }
      }
    }
    for (let i = lo; i <= hi; i++) {
      const e = list[i];
      if (e && e.name !== "..") this.state.marked.add(e.path);
    }
    this.rangeLastBounds = [lo, hi];
    this.state.cursor = nextCursor;
    this.notify();
  }

  /** Mark every real entry in view (never the synthetic ".." row). */
  markAll(): void {
    const list = this.visibleEntries();
    for (const e of list) {
      if (e.name !== "..") this.state.marked.add(e.path);
    }
    this.notify();
  }

  /** Clear every mark — Escape's second-precedence arm when marks exist. */
  clearMarks(): void {
    if (this.state.marked.size === 0) return;
    this.state.marked.clear();
    this.resetRangeAnchor();
    this.notify();
  }

  /**
   * Drop marks for paths no longer present. Marks are keyed by absolute
   * path specifically so this is possible without guessing at index
   * correspondence — Phase 6's watcher calls this after every rescan.
   */
  pruneMarks(existingPaths: Iterable<string>): void {
    const keep = new Set(existingPaths);
    let changed = false;
    for (const p of this.state.marked) {
      if (!keep.has(p)) {
        this.state.marked.delete(p);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  // ── clipboard ──

  /**
   * Stage the marked set — or, when nothing is marked, the entry under the
   * cursor, the fallback that makes a single-file copy/cut fast — into the
   * clipboard register. Nothing here touches disk: per the plan, a cut is
   * non-destructive until Phase 5a's paste actually runs.
   */
  copy(): void {
    this.stageClipboard("copy");
  }

  cut(): void {
    this.stageClipboard("cut");
  }

  private stageClipboard(mode: "copy" | "cut"): void {
    const paths = this.clipboardCandidatePaths();
    if (paths.length === 0) {
      this.setMessage(`nothing to ${mode}`);
      return;
    }
    this.state.clipboard = { mode, paths };
    const label = paths.length === 1 ? "1 item" : `${paths.length} items`;
    this.setMessage(`${label} ${mode === "cut" ? "cut" : "copied"}`);
  }

  private clipboardCandidatePaths(): string[] {
    if (this.state.marked.size > 0) return [...this.state.marked];
    const list = this.visibleEntries();
    const entry = list[this.state.cursor];
    if (!entry || entry.name === "..") return [];
    return [entry.path];
  }

  // ── paste (Phase 5a copy, Phase 5b cut) ──

  /**
   * Consume `state.clipboard` against the current directory: copies it for
   * `mode: "copy"`, moves it for `mode: "cut"`. Both branches share the
   * abort/progress-overlay bookkeeping below; only what happens to the
   * sources afterward (and the job each queues into) differs — see
   * `runCopy`/`runCut`.
   */
  async paste(): Promise<void> {
    const clipboard = this.state.clipboard;
    if (!clipboard) {
      this.setMessage("clipboard is empty");
      return;
    }
    if (this.state.overlay?.kind === "progress") {
      this.setMessage("an operation is already in progress");
      return;
    }
    if (clipboard.mode === "cut") {
      await this.runCut(clipboard.paths);
    } else {
      await this.runCopy(clipboard.paths);
    }
  }

  /**
   * `mode: "copy"` side of `paste()`. Vanished clipboard paths are filtered
   * out before queueing and reported by count rather than failing the
   * whole paste (see the file header). Clears the clipboard only once at
   * least one source actually landed and the job was not cancelled — a
   * fully-rejected or fully-cancelled paste leaves the clipboard staged so
   * the user can fix whatever was wrong and retry.
   */
  private async runCopy(paths: string[]): Promise<void> {
    const destDir = this.state.cwd;
    const { present, missing } = await partitionExisting(paths);
    if (present.length === 0) {
      this.state.clipboard = null;
      this.setMessage(
        missing.length > 0
          ? `nothing to paste — ${missing.length} item${missing.length === 1 ? "" : "s"} no longer exist`
          : "nothing to paste",
        "error",
      );
      return;
    }

    const abort = new AbortController();
    this.pasteAbort = abort;
    this.state.overlay = {
      kind: "progress",
      label: "Copying",
      done: 0,
      total: 0,
      currentPath: "",
      bytesDone: 0,
      bytesTotal: 0,
    };
    this.notify();

    let outcome: PasteOutcome;
    try {
      outcome = await runPasteJob({
        destDir,
        sources: present,
        signal: abort.signal,
        onProgress: (p) => {
          // A stale callback from a paste that already finished (or was
          // superseded) must never resurrect the overlay — see the
          // `pasteAbort` field comment.
          if (this.pasteAbort !== abort) return;
          this.state.overlay = { kind: "progress", label: "Copying", ...p };
          this.notify();
        },
      });
    } finally {
      if (this.pasteAbort === abort) this.pasteAbort = null;
    }

    this.state.overlay = null;
    if (outcome.copiedSources.length > 0 && !outcome.cancelled) {
      this.state.clipboard = null;
    }
    this.reportPasteOutcome(outcome, missing.length);
    // Refresh so newly-pasted entries show up; load() notifies on its own.
    await this.load(this.state.cwd);
  }

  /**
   * `mode: "cut"` side of `paste()` — Phase 5b. Structurally identical to
   * `runCopy` above (same abort controller field, same progress-overlay
   * shape, same vanished-path handling), but queues through
   * `ops/queue.ts`'s `runCutJob` (guard -> conflict resolution -> `moveAll`,
   * see queue.ts and move.ts) instead of `runPasteJob`, and only clears
   * marks/clipboard for sources `runCutJob` actually reports as moved — see
   * the file header. A same-device cut resolves via a single `rename` call
   * per source and never yields to the event loop, so the progress overlay
   * set up below never actually gets painted for it (the overlay is
   * cleared again before the scheduled repaint runs); a cross-device cut is
   * a real copy underneath and yields exactly like `runCopy`, so the
   * overlay shows for that case for free. No branching on distance is
   * needed here — it falls out of how the two paths yield.
   */
  private async runCut(paths: string[]): Promise<void> {
    const destDir = this.state.cwd;
    const { present, missing } = await partitionExisting(paths);
    if (present.length === 0) {
      this.state.clipboard = null;
      this.setMessage(
        missing.length > 0
          ? `nothing to paste — ${missing.length} item${missing.length === 1 ? "" : "s"} no longer exist`
          : "nothing to paste",
        "error",
      );
      return;
    }

    const abort = new AbortController();
    this.pasteAbort = abort;
    this.state.overlay = {
      kind: "progress",
      label: "Moving",
      done: 0,
      total: 0,
      currentPath: "",
      bytesDone: 0,
      bytesTotal: 0,
    };
    this.notify();

    let outcome: CutOutcome;
    try {
      outcome = await runCutJob({
        destDir,
        sources: present,
        signal: abort.signal,
        onProgress: (p) => {
          if (this.pasteAbort !== abort) return;
          this.state.overlay = { kind: "progress", label: "Moving", ...p };
          this.notify();
        },
      });
    } finally {
      if (this.pasteAbort === abort) this.pasteAbort = null;
    }

    this.state.overlay = null;
    if (outcome.movedSources.length > 0 && !outcome.cancelled) {
      // The sources are gone — see the file header on why only the ones
      // that actually moved get their marks dropped.
      this.state.clipboard = null;
      for (const src of outcome.movedSources) this.state.marked.delete(src);
    }
    this.reportCutOutcome(outcome, missing.length);
    await this.load(this.state.cwd);
  }

  /** Esc while the progress overlay is open (see keymap.ts's Escape precedence). */
  cancelPaste(): void {
    this.pasteAbort?.abort();
  }

  private reportPasteOutcome(
    outcome: PasteOutcome,
    vanishedCount: number,
  ): void {
    const parts: string[] = [];
    if (outcome.cancelled) {
      parts.push("copy cancelled");
    } else if (outcome.copiedSources.length > 0) {
      const n = outcome.copiedSources.length;
      parts.push(`copied ${n} item${n === 1 ? "" : "s"}`);
    }
    if (outcome.skipped.length > 0) {
      parts.push(`${outcome.skipped.length} rejected`);
    }
    if (outcome.errors.length > 0) {
      parts.push(
        `${outcome.errors.length} error${outcome.errors.length === 1 ? "" : "s"}`,
      );
    }
    if (vanishedCount > 0) {
      parts.push(`${vanishedCount} vanished`);
    }
    const kind: Message["kind"] =
      outcome.errors.length > 0 || outcome.skipped.length > 0
        ? "error"
        : "info";
    this.setMessage(
      parts.length > 0 ? parts.join(", ") : "nothing copied",
      kind,
    );
  }

  private reportCutOutcome(outcome: CutOutcome, vanishedCount: number): void {
    const parts: string[] = [];
    if (outcome.cancelled) {
      parts.push("move cancelled");
    } else if (outcome.movedSources.length > 0) {
      const n = outcome.movedSources.length;
      parts.push(`moved ${n} item${n === 1 ? "" : "s"}`);
    }
    if (outcome.skipped.length > 0) {
      parts.push(`${outcome.skipped.length} rejected`);
    }
    if (outcome.errors.length > 0) {
      parts.push(
        `${outcome.errors.length} error${outcome.errors.length === 1 ? "" : "s"}`,
      );
    }
    if (vanishedCount > 0) {
      parts.push(`${vanishedCount} vanished`);
    }
    const kind: Message["kind"] =
      outcome.errors.length > 0 || outcome.skipped.length > 0
        ? "error"
        : "info";
    this.setMessage(
      parts.length > 0 ? parts.join(", ") : "nothing moved",
      kind,
    );
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

// ── helpers ──

/**
 * Split `paths` into those that still `lstat` successfully and those that
 * don't — the clipboard-staleness check `paste()` runs before ever queueing
 * a job. Checked concurrently (`Promise.all`, same reasoning as
 * `fsapi/scan.ts`'s stat fan-out) but the two output arrays preserve the
 * original order of `paths`, not resolution order, so which name wins a
 * same-basename conflict in `ops/queue.ts` stays deterministic given the
 * same marks.
 */
async function partitionExisting(
  paths: string[],
): Promise<{ present: string[]; missing: string[] }> {
  const stillExists = await Promise.all(
    paths.map(async (p) => {
      try {
        await lstat(p);
        return true;
      } catch {
        return false;
      }
    }),
  );
  const present: string[] = [];
  const missing: string[] = [];
  paths.forEach((p, i) => (stillExists[i] ? present.push(p) : missing.push(p)));
  return { present, missing };
}
