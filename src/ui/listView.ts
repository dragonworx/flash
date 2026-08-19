// ui/listView.ts — the detailed row list: icon, name, size, mode, owner,
// group, mtime, plus the dimmed column-header row drawn above it. Columns
// drop progressively as the terminal narrows — name and size are the last
// to go, per the plan, so `DROP_ORDER` below never mentions either.
//
// This file never branches on `--icons` itself: `term/theme.ts` owns the
// icon table and the entry->color mapping, this file only calls
// `iconFor()`/`colorFor()`. It never measures width outside `term/width.ts`
// either — every glyph and name here was already measured once, either at
// scan time (`entry.width`) or through `pad()`/`truncate()` below.
//
// `computeListLayout()` is the one place that decides where each column
// starts; both `renderListHeader()` and `renderListView()` call it so the
// header labels and the data beneath them can never drift apart.
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
// The gap between the name and the fixed-width trailing columns is filled
// with a sparse dot leader rather than left as a blank void — the visual
// design pass's fix for what used to be a 40-column gap of nothing between
// a short name and a right-aligned size on a wide terminal.

import { formatMode, formatMtime, formatSize } from "../fsapi/entry.ts";
import type { Entry } from "../fsapi/entry.ts";
import { groupName, userName } from "../fsapi/users.ts";
import type { Screen, Style } from "../term/screen.ts";
import { type IconSet, colorFor, colors, iconFor } from "../term/theme.ts";
import { pad, stringWidth, truncate } from "../term/width.ts";

// ── column layout ──

type ColumnKey = "size" | "mode" | "owner" | "group" | "mtime";

const COLUMN_WIDTH: Record<ColumnKey, number> = {
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
// deliberately absent — the plan calls out name and size as the two
// columns that must survive down to the smallest widths.
const DROP_ORDER: ColumnKey[] = ["mtime", "group", "owner", "mode"];

const MARKER_WIDTH = 2; // cursor marker glyph + gap
const ICON_WIDTH = 3; // icon glyph (possibly 2-wide) + gap
const GAP = 1;
const MIN_NAME_WIDTH = 6;
// The name column is capped rather than left to stretch across whatever
// width is left over: on a wide terminal, `available` (width minus every
// fixed cost) can be 60+ columns even though real filenames rarely need
// more than a third of that, and letting it stretch is exactly what used
// to leave a 40-column void of blank space between the name and the size
// column. Capping it pulls the trailing columns in tight instead — the
// "tighter column allocation" half of the visual-design pass's spacing
// fix. Narrow terminals are unaffected: the cap only ever *shrinks*
// `available`, never grows it, so nothing here changes `chooseColumns`'s
// drop behavior.
const NAME_CAP_WIDTH = 36;
const LEADER_CHAR = "·";
const LEADER_STRIDE = 3; // columns between each dot of the leader

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
 * The full column layout for `width` — shared by the header row and every
 * data row so their x-coordinates can never disagree. `nameWidths` is every
 * *visible* entry's cached display width (`Entry.width`, the same "measure
 * once at scan time" cache `ui/gridView.ts`'s `computeGridLayout` reads);
 * the name column sizes itself to the longest of them (capped at
 * `NAME_CAP_WIDTH`) rather than always claiming the full leftover width, so
 * a directory of short names doesn't leave a long gap before the trailing
 * columns. Passing an empty array (or omitting it) falls back to the cap,
 * for callers that don't have the entry list yet.
 */
export function computeListLayout(
  width: number,
  nameWidths: number[] = [],
): ListLayout {
  const columns = chooseColumns(width);
  const nameX = MARKER_WIDTH + ICON_WIDTH;
  const trailingWidth = columns.reduce((w, c) => w + COLUMN_WIDTH[c] + GAP, 0);
  const available = Math.max(width - nameX - trailingWidth, 0);
  const longest = nameWidths.reduce((m, w) => Math.max(m, w), 0);
  const desired =
    longest > 0 ? Math.min(longest, NAME_CAP_WIDTH) : NAME_CAP_WIDTH;
  const nameWidth = Math.min(available, desired);

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

function sizeText(entry: Entry): string {
  if (entry.error) return "err";
  if (entry.kind === "symlink" && entry.broken) return "brkn";
  if (
    entry.kind === "dir" ||
    (entry.kind === "symlink" && entry.targetKind === "dir")
  )
    return "-";
  return formatSize(entry.size);
}

function columnText(col: ColumnKey, entry: Entry, now: number): string {
  switch (col) {
    case "size":
      return sizeText(entry);
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
 * list. `entries` should be the same visible-entries list passed to
 * `renderListView` this frame, so the name column sizes identically and the
 * labels line up with the data beneath them.
 */
export function renderListHeader(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  entries: Entry[],
): void {
  if (width <= 0) return;
  const layout = computeListLayout(
    width,
    entries.map((e) => e.width),
  );
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

function drawLeader(
  screen: Screen,
  xStart: number,
  xEnd: number,
  y: number,
  style: Style,
): void {
  for (let lx = xStart; lx < xEnd; lx += LEADER_STRIDE) {
    screen.put(lx, y, LEADER_CHAR, style);
  }
}

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
): void {
  const bg = isCursor ? colors.cursorBg : undefined;
  const fg = colorFor(entry);
  const rowStyle: Style = { bg };

  const { nameX, nameWidth, columns } = layout;

  screen.put(x, y, isCursor ? "›" : " ", {
    ...rowStyle,
    fg: isCursor ? colors.accent : undefined,
  });
  screen.put(x + MARKER_WIDTH, y, pad(iconFor(iconSet, entry), ICON_WIDTH), {
    ...rowStyle,
    fg,
  });

  const nameDisplay = truncate(entry.name, nameWidth);
  screen.put(x + nameX, y, nameDisplay, { ...rowStyle, fg });

  if (columns.length > 0) {
    const leaderStart = x + nameX + stringWidth(nameDisplay) + 1;
    const leaderEnd = x + nameX + nameWidth;
    if (leaderEnd > leaderStart) {
      drawLeader(screen, leaderStart, leaderEnd, y, {
        ...rowStyle,
        fg: colors.chrome,
      });
    }
  }

  if (entry.error) {
    const usedWidth = nameX + nameWidth;
    const remaining = Math.max(width - usedWidth - GAP, 0);
    if (remaining > 0) {
      screen.put(
        x + usedWidth + GAP,
        y,
        pad(truncate(entry.error, remaining), remaining),
        { ...rowStyle, fg: colors.error },
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
      pad(columnText(col, entry, now), COLUMN_WIDTH[col], "right"),
      { ...rowStyle, fg: isCursor ? undefined : colors.dim },
    );
  }
}

/**
 * Render `entries[scrollTop .. scrollTop+height)` into the `height` rows
 * starting at `(x, y)`, `width` columns wide. `scrollTop` is the caller's
 * responsibility (see `Store.ensureVisible`) — this function never scrolls
 * on its own, it only draws the window it is given.
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
  iconSet: IconSet,
  now: number = Date.now(),
): void {
  if (width <= 0 || height <= 0) return;
  const layout = computeListLayout(
    width,
    entries.map((e) => e.width),
  );
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
    );
  }
}
