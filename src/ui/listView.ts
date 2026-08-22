// ui/listView.ts — the detailed row list: icon, name, size, mode, owner,
// group, mtime, plus the dimmed column-header row drawn above it.
//
// This file never branches on `--icons` itself: `term/theme.ts` owns the
// icon table and the entry->color mapping, this file only calls
// `iconFor()`/`colorFor()`. It never measures width outside `term/width.ts`
// either — every glyph and name here was already measured once, either at
// scan time (`entry.width`) or through `pad()`/`truncate()` below.
//
// `computeListLayout()` is the one place that decides where each column
// starts. `main.ts` calls it exactly once per frame and passes the *same*
// `ListLayout` value into both `renderListHeader()` and `renderListView()`
// — neither function recomputes its own layout, so the header labels and
// the data beneath them are structurally incapable of drifting apart.
//
// The name column is deliberately uncapped: it claims every column left
// over after the marker, icon, and whichever trailing columns survive
// `chooseColumns()`, so a short name is followed by plain blank space (the
// row still spans the full frame width, trailing columns flush right) and
// a long one is truncated with `…` rather than the row stopping partway
// across a wide terminal. Narrow terminals are protected the other way:
// `MIN_NAME_WIDTH` (~24 columns — generous, since the name is the single
// most important thing on the row) drives `chooseColumns()` to drop
// metadata columns, least essential first (`DROP_ORDER`: Modified, Group,
// Owner, Mode — `size` is never dropped), before the name is ever
// squeezed below it.
//
// The cursor row has no reliable color-only indicator: `Screen.flush()`
// gates *all* SGR — including a background fill — behind the same
// `--no-color`/non-TTY switch that disables color, so a `--dump-frame
// --no-color` snapshot would show no cursor at all if a background were the
// only cue. The leading marker column (`›` vs a space) is the
// color-independent cue; `colors.cursorBg` on top of it is a bonus in a
// real terminal, not the mechanism — and using a background highlight
// instead of full reverse-video (Phase 2's approach) means a row's
// file-type color stays visible while it is selected, rather than being
// swapped away by SGR 7.
//
// Phase 4 (selection/clipboard) reuses exactly that reasoning for marks: the
// column right after the cursor marker — previously always blank, just the
// marker's trailing gap — now carries `theme.ts`'s `MARK_GLYPH`, a plain
// character (`*`/`x`/`+`) that is its own color-independent, icon-set-
// independent cue. Cursor and mark glyphs sit in adjacent columns, so a row
// that is both the cursor and marked shows both at once with no special
// casing. Cut/copied rows additionally get `ATTR_DIM`(`|ATTR_ITALIC` for
// cut) on their icon/name/columns — a bonus for a real terminal, same as
// `cursorBg`, never the only signal.

import { formatMode, formatMtime, formatSize } from "../fsapi/entry.ts";
import type { Entry } from "../fsapi/entry.ts";
import { groupName, userName } from "../fsapi/users.ts";
import {
  ATTR_DIM,
  ATTR_ITALIC,
  type Screen,
  type Style,
} from "../term/screen.ts";
import {
  BOOKMARK_GLYPH,
  type IconSet,
  MARK_GLYPH,
  colorFor,
  colors,
  iconFor,
  markColor,
  rowMarkState,
} from "../term/theme.ts";
import { pad, truncate } from "../term/width.ts";

/** Structural, not imported from state/store.ts — see the file header. */
type ClipboardLike = { mode: "copy" | "cut"; paths: string[] } | null;

// ── column layout ──

export type ColumnKey = "size" | "mode" | "owner" | "group" | "mtime";

/** Exported for tests — the width of each trailing column's field. */
export const COLUMN_WIDTH: Record<ColumnKey, number> = {
  size: 6,
  mode: 10,
  owner: 8,
  group: 8,
  mtime: 10,
};

const COLUMN_LABEL: Record<ColumnKey, string> = {
  size: "Size",
  mode: "Mode",
  owner: "Owner",
  group: "Group",
  mtime: "Modified",
};

const ALL_COLUMNS: ColumnKey[] = ["size", "mode", "owner", "group", "mtime"];

// Drop order when the terminal narrows, least essential first. `size` is
// deliberately absent — it never drops, so there is always at least one
// piece of metadata visible alongside the name.
const DROP_ORDER: ColumnKey[] = ["mtime", "group", "owner", "mode"];

const MARKER_WIDTH = 2; // cursor marker glyph + gap
const ICON_WIDTH = 3; // icon glyph (possibly 2-wide) + gap
const GAP = 1;
// The name is the single most important thing on the row, so its minimum
// is generous — wide enough that a typical filename isn't immediately
// truncated — and every optional column drops before the name is ever
// squeezed below it. See `chooseColumns()`.
const MIN_NAME_WIDTH = 24;

// Shared, never mutated — just the default for callers (existing tests,
// mostly) that don't care about marks, so they don't need to pass one.
const EMPTY_MARKED: ReadonlySet<string> = new Set();
// Same reasoning, for callers that don't care about folder sizes — see
// `sizeText` below.
const EMPTY_DIR_SIZES: ReadonlyMap<string, number> = new Map();
// Same reasoning, for callers that don't care about goto bookmarks.
const EMPTY_BOOKMARKS: ReadonlySet<string> = new Set();

function fixedCost(columns: ColumnKey[]): number {
  return (
    MARKER_WIDTH +
    ICON_WIDTH +
    columns.reduce((w, c) => w + COLUMN_WIDTH[c] + GAP, 0)
  );
}

/** Which trailing columns fit at `width`, widest terminal first in the list. */
export function chooseColumns(width: number): ColumnKey[] {
  let columns = [...ALL_COLUMNS];
  for (const drop of DROP_ORDER) {
    if (width - fixedCost(columns) >= MIN_NAME_WIDTH) break;
    columns = columns.filter((c) => c !== drop);
  }
  return columns;
}

export type ListLayout = {
  columns: ColumnKey[];
  nameX: number;
  nameWidth: number;
  /** Screen x each trailing column's value starts at, keyed by column. */
  colStarts: Partial<Record<ColumnKey, number>>;
};

/**
 * The full column layout for `width` — call this once per frame and pass
 * the result to both `renderListHeader()` and `renderListView()` so their
 * x-coordinates can never disagree.
 */
export function computeListLayout(width: number): ListLayout {
  const columns = chooseColumns(width);
  const nameX = MARKER_WIDTH + ICON_WIDTH;
  const trailingWidth = columns.reduce((w, c) => w + COLUMN_WIDTH[c] + GAP, 0);
  const nameWidth = Math.max(width - nameX - trailingWidth, 0);

  const colStarts: Partial<Record<ColumnKey, number>> = {};
  let cx = nameX + nameWidth;
  for (const col of columns) {
    cx += GAP;
    colStarts[col] = cx;
    cx += COLUMN_WIDTH[col];
  }

  return { columns, nameX, nameWidth, colStarts };
}

// ── cell text ──

/**
 * `entry.size` for a directory is just the raw inode size, not a total (see
 * fsapi/entry.ts), so a real total comes from `dirSizes` instead — the
 * per-path cache `Store` fills in asynchronously (`Store.dirSizes()`,
 * backed by the same `fsapi/ops/index.ts` `dirSize()` walk `selectedSize()`
 * uses). A path not yet in the cache — still being walked, the synthetic
 * ".." row (never queued), or an archive-internal entry (the batch walk
 * only ever queues real filesystem paths) — reads the same "-" a directory
 * always showed before this existed, so there's no separate "pending" glyph
 * to keep in sync with the real one.
 */
function sizeText(entry: Entry, dirSizes: ReadonlyMap<string, number>): string {
  if (entry.error) return "err";
  if (entry.kind === "symlink" && entry.broken) return "brkn";
  if (
    entry.kind === "dir" ||
    (entry.kind === "symlink" && entry.targetKind === "dir")
  ) {
    const bytes = dirSizes.get(entry.path);
    return bytes === undefined ? "-" : formatSize(bytes);
  }
  return formatSize(entry.size);
}

function columnText(
  col: ColumnKey,
  entry: Entry,
  now: number,
  dirSizes: ReadonlyMap<string, number>,
): string {
  switch (col) {
    case "size":
      return sizeText(entry, dirSizes);
    case "mode":
      return formatMode(entry.mode);
    case "owner":
      return userName(entry.uid);
    case "group":
      return groupName(entry.gid);
    case "mtime":
      return formatMtime(entry.mtimeMs, now);
  }
}

// ── column headers ──

/**
 * The dimmed "Name  Size  Mode  Owner  Group  Modified" row drawn above the
 * list. `layout` must be the exact `computeListLayout()` result the caller
 * also passes to `renderListView()` this frame — see the file header.
 */
export function renderListHeader(
  screen: Screen,
  x: number,
  y: number,
  layout: ListLayout,
): void {
  const style: Style = { fg: colors.header };
  screen.put(x + layout.nameX, y, pad("Name", layout.nameWidth), style);
  for (const col of layout.columns) {
    const colX = layout.colStarts[col];
    if (colX === undefined) continue;
    screen.put(
      x + colX,
      y,
      pad(COLUMN_LABEL[col], COLUMN_WIDTH[col], "right"),
      style,
    );
  }
}

// ── rendering ──

function renderRow(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  entry: Entry,
  isCursor: boolean,
  layout: ListLayout,
  iconSet: IconSet,
  now: number,
  marked: ReadonlySet<string>,
  clipboard: ClipboardLike,
  dirSizes: ReadonlyMap<string, number>,
  bookmarks: ReadonlySet<string>,
): void {
  const bg = isCursor ? colors.cursorBg : undefined;
  const fg = colorFor(entry);
  const rowStyle: Style = { bg };

  const { nameX, nameWidth, columns } = layout;

  // The synthetic ".." row is never markable (see Store.toggleMarkAtCursor),
  // so it never carries a status glyph even if its path happened to collide
  // with something in `marked` — it can't, but this keeps the intent explicit.
  const markState =
    entry.name === ".." ? "none" : rowMarkState(entry.path, marked, clipboard);
  // Content dims/italicizes to show a pending cut (or, more subtly, a
  // pending copy); the marker glyphs themselves stay full-strength so
  // they're always legible regardless of clipboard state.
  const contentAttr =
    markState === "cut"
      ? ATTR_DIM | ATTR_ITALIC
      : markState === "copied"
        ? ATTR_DIM
        : 0;

  screen.put(x, y, isCursor ? "›" : " ", {
    ...rowStyle,
    fg: isCursor ? colors.accent : undefined,
  });
  screen.put(x + 1, y, MARK_GLYPH[markState], {
    ...rowStyle,
    fg: markColor(markState),
  });
  screen.put(x + MARKER_WIDTH, y, pad(iconFor(iconSet, entry), ICON_WIDTH), {
    ...rowStyle,
    fg,
    attr: contentAttr,
  });
  // The synthetic ".." row never carries the bookmark star either — see the
  // ".." mark-glyph note above; the breadcrumb's own star already covers
  // "the directory I'm in right now is bookmarked."
  const displayName =
    entry.name !== ".." && bookmarks.has(entry.path)
      ? `${entry.name}${BOOKMARK_GLYPH}`
      : entry.name;
  screen.put(x + nameX, y, pad(truncate(displayName, nameWidth), nameWidth), {
    ...rowStyle,
    fg,
    attr: contentAttr,
  });

  if (entry.error) {
    const usedWidth = nameX + nameWidth;
    const remaining = Math.max(width - usedWidth - GAP, 0);
    if (remaining > 0) {
      screen.put(
        x + usedWidth + GAP,
        y,
        pad(truncate(entry.error, remaining), remaining),
        { ...rowStyle, fg: colors.error, attr: contentAttr },
      );
    }
    return;
  }

  for (const col of columns) {
    const colX = layout.colStarts[col];
    if (colX === undefined) continue;
    screen.put(
      x + colX,
      y,
      pad(columnText(col, entry, now, dirSizes), COLUMN_WIDTH[col], "right"),
      { ...rowStyle, fg: isCursor ? undefined : colors.dim, attr: contentAttr },
    );
  }
}

/**
 * Render `entries[scrollTop .. scrollTop+height)` into the `height` rows
 * starting at `(x, y)`, `width` columns wide. `scrollTop` is the caller's
 * responsibility (see `Store.ensureVisible`) — this function never scrolls
 * on its own, it only draws the window it is given. `layout` must be the
 * same `computeListLayout()` result passed to `renderListHeader()` this
 * frame.
 */
export function renderListView(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
  entries: Entry[],
  cursor: number,
  scrollTop: number,
  layout: ListLayout,
  iconSet: IconSet,
  marked: ReadonlySet<string> = EMPTY_MARKED,
  clipboard: ClipboardLike = null,
  now: number = Date.now(),
  dirSizes: ReadonlyMap<string, number> = EMPTY_DIR_SIZES,
  bookmarks: ReadonlySet<string> = EMPTY_BOOKMARKS,
): void {
  if (width <= 0 || height <= 0) return;
  for (let row = 0; row < height; row++) {
    const idx = scrollTop + row;
    const entry = entries[idx];
    if (!entry) continue; // Screen.clear() already blanked this row this frame
    renderRow(
      screen,
      x,
      y + row,
      width,
      entry,
      idx === cursor,
      layout,
      iconSet,
      now,
      marked,
      clipboard,
      dirSizes,
      bookmarks,
    );
  }
}
