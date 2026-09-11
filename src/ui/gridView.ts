// ui/gridView.ts — the column-flow grid: icon + name only, laid out
// column-major (fills straight down a column before starting the next one)
// into as many columns as fit at the widest visible name, capped so one
// very long filename can't collapse the whole grid to a single column.
//
// `v` toggles list/grid in main.ts; this file owns the grid's own layout
// math, cursor geometry, and scroll clamping, all pure and unit-tested
// (tests/gridView.test.ts) exactly like `ui/listView.ts`'s
// `computeListLayout`/`chooseColumns`. It shares the same marker/icon
// convention as the list view (a leading `›` for the cursor, a background
// highlight from `term/theme.ts`) and the same `iconFor`/`colorFor` lookups
// — the grid never invents its own color or glyph rules.
//
// Column-major cursor geometry: entry index `i` sits at column
// `floor(i / rows)`, row `i % rows`. Every column holds exactly `rows`
// entries except the last, which holds whatever remains — the standard
// column-major fill, and the only column that can ever be short. Arrow-key
// navigation is deliberately geometric rather than a raw index delta:
// moving with the flat array's natural +1/-1 step would silently jump from
// the bottom of one column to the top of the next, which is exactly the
// "feels like a wrapped list" bug the plan warns grid navigation must
// avoid. So ↑/↓ (`moveGridCursor` with dir "up"/"down") clamp to the
// current column's own row range, and ←/→ ("left"/"right") jump a whole
// column's worth of entries (±`rows`) to land on the same row in the
// neighbouring column, clamped into whatever that column's shorter range
// allows.

import type { Entry } from "../fsapi/entry.ts";
import type { GitStatus } from "../fsapi/gitStatus.ts";
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
  gitStatusColor,
  gitStatusSuffix,
  iconFor,
  markColor,
  rowMarkState,
} from "../term/theme.ts";
import { pad, stringWidth, truncate } from "../term/width.ts";

/** Structural, not imported from state/store.ts — see ui/listView.ts's file header. */
type ClipboardLike = { mode: "copy" | "cut"; paths: string[] } | null;

// Shared, never mutated — the default for callers that don't care about
// marks (mirrors ui/listView.ts's EMPTY_MARKED).
const EMPTY_MARKED: ReadonlySet<string> = new Set();
// Same reasoning, for callers that don't care about goto bookmarks.
const EMPTY_BOOKMARKS: ReadonlySet<string> = new Set();
// Same reasoning, for callers that don't care about git status markers.
const EMPTY_GIT_STATUSES: ReadonlyMap<string, GitStatus | null> = new Map();

// ── layout ──

const MARKER_WIDTH = 2; // cursor marker glyph + gap — mirrors listView.ts
const ICON_WIDTH = 3; // icon glyph (possibly 2-wide) + gap
const NAME_GAP = 1; // trailing gap that doubles as the inter-column gap
const MIN_NAME_WIDTH = 6;
const MAX_NAME_WIDTH = 32; // caps the column so one giant filename can't
// collapse the grid to a single column

export type GridLayout = {
  /** Number of columns that fit; 0 when there is nothing to show. */
  columns: number;
  /** Total width of one cell, including its trailing gap. */
  colWidth: number;
  /** Width allotted to the name text within a cell. */
  nameWidth: number;
};

/**
 * `entry.width` (see term/width.ts's "never measure width per row per
 * frame" invariant) plus the goto-bookmark star's and/or the git status
 * marker's width when this entry gets one (see renderCell's own ".."
 * exclusion) — callers must feed this, not the bare `entry.width`, into
 * `computeGridLayout`'s `nameWidths`, or a bookmarked/git-marked name
 * sitting right at the column's width cap gets its suffix silently
 * truncated off by `truncate()` instead of the column reserving room for
 * it up front.
 */
export function entryDisplayWidth(
  entry: Entry,
  bookmarks: ReadonlySet<string>,
  gitStatuses: ReadonlyMap<string, GitStatus | null> = EMPTY_GIT_STATUSES,
): number {
  if (entry.name === "..") return entry.width;
  const bookmarkWidth = bookmarks.has(entry.path)
    ? stringWidth(BOOKMARK_GLYPH)
    : 0;
  const gitWidth = stringWidth(gitStatusSuffix(gitStatuses.get(entry.path)));
  return entry.width + bookmarkWidth + gitWidth;
}

/**
 * `nameWidths` is each visible entry's display width (`entryDisplayWidth`
 * above), not the entries themselves, so this stays a pure function over
 * numbers and is trivial to unit test with synthetic widths (including a
 * wide CJK/emoji case) without constructing fake `Entry` objects.
 */
export function computeGridLayout(
  width: number,
  nameWidths: number[],
): GridLayout {
  const fixed = MARKER_WIDTH + ICON_WIDTH + NAME_GAP;
  if (width <= 0 || nameWidths.length === 0) {
    return { columns: 0, colWidth: 0, nameWidth: 0 };
  }

  const maxEntryWidth = nameWidths.reduce((m, w) => Math.max(m, w), 0);
  const desired = Math.min(
    Math.max(maxEntryWidth, MIN_NAME_WIDTH),
    MAX_NAME_WIDTH,
  );
  // Shrink to fit even a single column when the terminal is narrower than
  // the desired cell — narrow terminals must still render *something*.
  const nameWidth = Math.max(Math.min(desired, width - fixed), 1);
  const colWidth = fixed + nameWidth;
  const columns = Math.max(1, Math.floor(width / colWidth));

  return { columns, colWidth, nameWidth };
}

/** Rows needed to hold `total` entries in `columns` columns, column-major. */
export function gridRowCount(total: number, columns: number): number {
  if (columns <= 0) return 0;
  return Math.ceil(total / columns);
}

/** How many entries actually sit in column `col` (only the last can be short). */
function columnSize(
  col: number,
  columns: number,
  rows: number,
  total: number,
): number {
  if (col < columns - 1) return rows;
  return total - (columns - 1) * rows;
}

// ── cursor geometry ──

export type GridDirection = "up" | "down" | "left" | "right";

/**
 * The new cursor index after moving `dir` from `cursor`, within a grid of
 * `columns` columns / `rows` rows holding `total` entries. Clamps at every
 * edge rather than wrapping — see the file header for why `up`/`down` and
 * `left`/`right` use different deltas.
 */
export function moveGridCursor(
  cursor: number,
  total: number,
  columns: number,
  rows: number,
  dir: GridDirection,
): number {
  if (total === 0 || columns <= 0 || rows <= 0) return 0;
  const clampedCursor = Math.max(0, Math.min(total - 1, cursor));
  const col = Math.floor(clampedCursor / rows);
  const row = clampedCursor % rows;

  if (dir === "up" || dir === "down") {
    const size = columnSize(col, columns, rows, total);
    const nextRow = Math.max(
      0,
      Math.min(size - 1, row + (dir === "up" ? -1 : 1)),
    );
    return col * rows + nextRow;
  }

  const nextCol = Math.max(
    0,
    Math.min(columns - 1, col + (dir === "left" ? -1 : 1)),
  );
  const size = columnSize(nextCol, columns, rows, total);
  const nextRow = Math.max(0, Math.min(size - 1, row));
  return nextCol * rows + nextRow;
}

/**
 * Adjust a grid scroll offset (measured in grid *rows*, not entries) so
 * `cursorRow` stays inside `[scrollTop, scrollTop + viewportHeight)` —
 * the grid analogue of `Store.ensureVisible`, kept separate because grid
 * scrolling is row-space, not entry-space (many entries share a row).
 */
export function clampGridScroll(
  scrollTop: number,
  cursorRow: number,
  viewportHeight: number,
  totalRows: number,
): number {
  if (viewportHeight <= 0) return 0;
  let top = scrollTop;
  if (cursorRow < top) top = cursorRow;
  else if (cursorRow >= top + viewportHeight)
    top = cursorRow - viewportHeight + 1;
  const maxTop = Math.max(0, totalRows - viewportHeight);
  return Math.max(0, Math.min(top, maxTop));
}

// ── rendering ──
//
// Phase 4 reuses the marker column's trailing gap (previously always blank)
// for the same status glyph ui/listView.ts draws — see that file's header
// for the full reasoning. Cursor (`x`) and mark/clipboard status (`x + 1`)
// are adjacent columns, so a cell that is both the cursor and marked shows
// both at once with no special-casing.

function renderCell(
  screen: Screen,
  x: number,
  y: number,
  nameWidth: number,
  entry: Entry,
  isCursor: boolean,
  iconSet: IconSet,
  marked: ReadonlySet<string>,
  clipboard: ClipboardLike,
  bookmarks: ReadonlySet<string>,
  gitStatuses: ReadonlyMap<string, GitStatus | null>,
): void {
  const bg = isCursor ? colors.cursorBg : undefined;
  const fg = colorFor(entry);
  const rowStyle: Style = { bg };

  const markState =
    entry.name === ".." ? "none" : rowMarkState(entry.path, marked, clipboard);
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
  // Same ".." exclusion as ui/listView.ts's renderRow — see its comment.
  const bookmarkSuffix =
    entry.name !== ".." && bookmarks.has(entry.path) ? BOOKMARK_GLYPH : "";
  const gitStatus = entry.name !== ".." ? gitStatuses.get(entry.path) : null;
  const gitSuffix = gitStatusSuffix(gitStatus);
  const displayName = `${entry.name}${bookmarkSuffix}${gitSuffix}`;
  const truncated = truncate(displayName, nameWidth);
  const nameX = x + MARKER_WIDTH + ICON_WIDTH;
  // Same split-for-color approach as ui/listView.ts's renderRow — see its
  // comment.
  if (gitSuffix && truncated.endsWith(gitSuffix)) {
    const basePart = truncated.slice(0, truncated.length - gitSuffix.length);
    screen.put(nameX, y, basePart, { ...rowStyle, fg, attr: contentAttr });
    screen.put(nameX + stringWidth(basePart), y, gitSuffix, {
      ...rowStyle,
      fg: gitStatusColor(gitStatus),
      attr: contentAttr,
    });
    const usedWidth = stringWidth(truncated);
    if (usedWidth < nameWidth) {
      screen.put(nameX + usedWidth, y, " ".repeat(nameWidth - usedWidth), {
        ...rowStyle,
        fg,
        attr: contentAttr,
      });
    }
  } else {
    screen.put(nameX, y, pad(truncated, nameWidth), {
      ...rowStyle,
      fg,
      attr: contentAttr,
    });
  }
}

/**
 * Render the visible slice of `entries` into a `width`×`height` grid
 * starting at `(x, y)`. `scrollRow` is a *grid row* offset (see
 * `clampGridScroll`), the caller's responsibility exactly like
 * `renderListView`'s `scrollTop`.
 */
export function renderGridView(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
  entries: Entry[],
  cursor: number,
  scrollRow: number,
  iconSet: IconSet,
  marked: ReadonlySet<string> = EMPTY_MARKED,
  clipboard: ClipboardLike = null,
  bookmarks: ReadonlySet<string> = EMPTY_BOOKMARKS,
  gitStatuses: ReadonlyMap<string, GitStatus | null> = EMPTY_GIT_STATUSES,
): void {
  if (width <= 0 || height <= 0 || entries.length === 0) return;
  const layout = computeGridLayout(
    width,
    entries.map((e) => entryDisplayWidth(e, bookmarks, gitStatuses)),
  );
  if (layout.columns === 0) return;
  const rows = gridRowCount(entries.length, layout.columns);

  for (let col = 0; col < layout.columns; col++) {
    const size = columnSize(col, layout.columns, rows, entries.length);
    for (let visRow = 0; visRow < height; visRow++) {
      const row = scrollRow + visRow;
      if (row >= size) continue;
      const idx = col * rows + row;
      const entry = entries[idx];
      if (!entry) continue;
      renderCell(
        screen,
        x + col * layout.colWidth,
        y + visRow,
        layout.nameWidth,
        entry,
        idx === cursor,
        iconSet,
        marked,
        clipboard,
        bookmarks,
        gitStatuses,
      );
    }
  }
}
