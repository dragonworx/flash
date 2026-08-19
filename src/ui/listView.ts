// ui/listView.ts — the detailed row list: icon, name, size, mode, owner,
// group, mtime. Columns drop progressively as the terminal narrows — name
// and size are the last to go, per the plan, so `DROP_ORDER` below never
// mentions either.
//
// This file never branches on `--icons` itself: `term/theme.ts` owns the
// icon table and the entry->color mapping, this file only calls
// `iconFor()`/`colorFor()`. It never measures width outside `term/width.ts`
// either — every glyph and name here was already measured once, either at
// scan time (`entry.width`, unused directly here but the reason scan.ts
// caches it) or through `pad()`/`truncate()` below.
//
// The cursor row has no reliable color-only indicator: `Screen.flush()`
// gates *all* SGR — including plain attributes like reverse-video — behind
// the same `--no-color`/non-TTY switch that disables color, so a
// `--dump-frame --no-color` snapshot would show no cursor at all if reverse
// video were the only cue. The leading marker column (`›` vs a space) is
// the color-independent cue; ATTR_REVERSE on top of it is a bonus in a real
// terminal, not the mechanism.

import { formatMode, formatMtime, formatSize } from "../fsapi/entry.ts";
import type { Entry } from "../fsapi/entry.ts";
import { groupName, userName } from "../fsapi/users.ts";
import { ATTR_REVERSE, type Screen, type Style } from "../term/screen.ts";
import { type IconSet, colorFor, colors, iconFor } from "../term/theme.ts";
import { pad, truncate } from "../term/width.ts";

// ── column layout ──

type ColumnKey = "size" | "mode" | "owner" | "group" | "mtime";

const COLUMN_WIDTH: Record<ColumnKey, number> = {
  size: 6,
  mode: 10,
  owner: 8,
  group: 8,
  mtime: 10,
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

// ── rendering ──

function renderRow(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  entry: Entry,
  isCursor: boolean,
  columns: ColumnKey[],
  iconSet: IconSet,
  now: number,
): void {
  const rowStyle: Style = isCursor ? { attr: ATTR_REVERSE } : {};
  const fg = isCursor ? undefined : colorFor(entry);
  const dimFg = isCursor ? undefined : colors.dim;

  const iconX = x + MARKER_WIDTH;
  const nameX = iconX + ICON_WIDTH;
  const trailingWidth = columns.reduce((w, c) => w + COLUMN_WIDTH[c] + GAP, 0);
  const nameWidth = Math.max(
    width - MARKER_WIDTH - ICON_WIDTH - trailingWidth,
    0,
  );

  screen.put(x, y, isCursor ? "›" : " ", { ...rowStyle, fg });
  screen.put(iconX, y, pad(iconFor(iconSet, entry), ICON_WIDTH), {
    ...rowStyle,
    fg,
  });
  screen.put(nameX, y, pad(entry.name, nameWidth), { ...rowStyle, fg });

  let cx = nameX + nameWidth;
  if (entry.error) {
    const remaining = Math.max(width - (cx - x) - GAP, 0);
    if (remaining > 0) {
      screen.put(
        cx + GAP,
        y,
        pad(truncate(entry.error, remaining), remaining),
        { ...rowStyle, fg: colors.error },
      );
    }
    return;
  }

  for (const col of columns) {
    cx += GAP;
    screen.put(
      cx,
      y,
      pad(columnText(col, entry, now), COLUMN_WIDTH[col], "right"),
      { ...rowStyle, fg: dimFg },
    );
    cx += COLUMN_WIDTH[col];
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
  const columns = chooseColumns(width);
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
      columns,
      iconSet,
      now,
    );
  }
}
