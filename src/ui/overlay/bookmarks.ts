// ui/overlay/bookmarks.ts — the `b` key's goto bookmark picker: a centered,
// scrollable, *selectable* list (unlike ui/overlay/help.ts's free-scrolling
// text) of `fsapi/goto.ts`'s bookmarks, in the same order `goto` (no args)
// lists them in. Enter (state/store.ts's `selectBookmark`) jumps the file
// view straight to the highlighted path.
//
// Same box chrome as help.ts/preview.ts (border, title, content, footer,
// same colors) but each content row is a name/path pair with a cursor
// marker, styled like ui/listView.ts's rows (`›` marker + `colors.cursorBg`
// highlight — the marker is the color-independent cue, the background is a
// bonus for a real terminal, per that file's header) rather than help.ts's
// plain two-column text.

import type { GotoBookmark } from "../../fsapi/goto.ts";
import { ATTR_BOLD, type Screen, type Style } from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, truncate } from "../../term/width.ts";

export type BookmarksOverlayState = {
  items: GotoBookmark[];
  cursor: number;
};

const BOX_WIDTH_MIN = 40;
const BOX_WIDTH_MAX = 84;
// border, title, blank, <content>, blank, footer, border — same layout as
// ui/overlay/help.ts's CHROME_ROWS.
const CHROME_ROWS = 6;
const NAME_COL_MAX = 24;

export type BookmarksBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function computeBookmarksBox(
  screenWidth: number,
  screenHeight: number,
  itemCount: number,
): BookmarksBoxRect {
  const w = screenWidth <= 0 ? 1 : screenWidth;
  const h = screenHeight <= 0 ? 1 : screenHeight;
  const preferredWidth = Math.max(
    BOX_WIDTH_MIN,
    Math.min(BOX_WIDTH_MAX, w - 4),
  );
  const width = Math.min(preferredWidth, w);
  const desiredHeight = Math.max(itemCount, 1) + CHROME_ROWS;
  const height = Math.min(desiredHeight, h);
  return {
    x: Math.max(0, Math.floor((w - width) / 2)),
    y: Math.max(0, Math.floor((h - height) / 2)),
    width,
    height,
  };
}

/** How many rows actually fit inside the box `computeBookmarksBox` would draw. */
export function bookmarksViewportHeight(
  screenWidth: number,
  screenHeight: number,
  itemCount: number,
): number {
  const box = computeBookmarksBox(screenWidth, screenHeight, itemCount);
  return Math.max(box.height - CHROME_ROWS, 0);
}

/**
 * The scroll offset that keeps `cursor` on screen, centered when there's
 * room to — unlike help/preview's free scroll, there is no persisted
 * scroll-offset field to clamp incrementally against (see
 * `state/store.ts`'s `Overlay` union comment on the `bookmarks` variant),
 * so this is recomputed from `cursor` alone on every render.
 */
function scrollOffsetFor(
  cursor: number,
  itemCount: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0 || itemCount <= viewportHeight) return 0;
  const maxOffset = itemCount - viewportHeight;
  const centered = cursor - Math.floor(viewportHeight / 2);
  return Math.max(0, Math.min(centered, maxOffset));
}

export function renderBookmarksOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  state: BookmarksOverlayState,
): void {
  const box = computeBookmarksBox(
    screenWidth,
    screenHeight,
    state.items.length,
  );
  if (box.width < 4 || box.height < 4) return;

  const bg = colors.footerBg;
  const borderStyle: Style = { fg: colors.chrome, bg };
  screen.box(box.x, box.y, box.width, box.height, borderStyle);
  for (let y = box.y + 1; y < box.y + box.height - 1; y++) {
    screen.put(box.x + 1, y, " ".repeat(box.width - 2), { bg });
  }

  const innerX = box.x + 2;
  const innerWidth = Math.max(box.width - 4, 0);
  const bottomBorderY = box.y + box.height - 1;

  const titleY = box.y + 1;
  const contentTop = box.y + 3;
  const viewportHeight = Math.max(box.height - CHROME_ROWS, 0);
  const footerY = contentTop + viewportHeight + 1;

  screen.put(innerX, titleY, truncate("Goto bookmarks", innerWidth), {
    fg: colors.titleEmphasis,
    attr: ATTR_BOLD,
    bg,
  });

  const offset = scrollOffsetFor(
    state.cursor,
    state.items.length,
    viewportHeight,
  );

  const nameColWidth = Math.min(
    NAME_COL_MAX,
    Math.max(...state.items.map((b) => b.name.length), 0),
    Math.max(innerWidth - 3, 0),
  );
  const pathX = innerX + 2 + nameColWidth + 1;
  const pathWidth = Math.max(innerWidth - 2 - nameColWidth - 1, 0);

  if (state.items.length === 0) {
    if (contentTop < bottomBorderY) {
      screen.put(
        innerX,
        contentTop,
        truncate("No bookmarks found", innerWidth),
        {
          fg: colors.dim,
          bg,
        },
      );
    }
  }

  for (let row = 0; row < viewportHeight; row++) {
    const y = contentTop + row;
    if (y >= bottomBorderY) break;
    const idx = offset + row;
    const item = state.items[idx];
    if (!item) break;
    const isCursor = idx === state.cursor;
    const rowBg = isCursor ? colors.cursorBg : bg;

    screen.put(innerX, y, isCursor ? "›" : " ", {
      fg: isCursor ? colors.accent : undefined,
      bg: rowBg,
    });
    screen.put(
      innerX + 2,
      y,
      pad(truncate(item.name, nameColWidth), nameColWidth),
      {
        fg: colors.titleEmphasis,
        attr: isCursor ? ATTR_BOLD : 0,
        bg: rowBg,
      },
    );
    if (pathWidth > 0) {
      screen.put(pathX, y, pad(truncate(item.path, pathWidth), pathWidth), {
        fg: colors.dim,
        bg: rowBg,
      });
    }
    // Fill the rest of the row so the cursor highlight spans the full box
    // width, not just the text — matches ui/listView.ts's row highlight.
    const usedWidth = pathX + pathWidth - innerX;
    if (isCursor && usedWidth < innerWidth) {
      screen.put(innerX + usedWidth, y, " ".repeat(innerWidth - usedWidth), {
        bg: rowBg,
      });
    }
  }

  if (footerY < bottomBorderY) {
    const hint =
      state.items.length > 0
        ? "↑/↓ or j/k selects, Enter jumps · Esc or b closes"
        : "Esc or b closes";
    screen.put(innerX, footerY, pad(hint, innerWidth), { fg: colors.dim, bg });
  }
}
