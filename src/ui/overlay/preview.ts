// ui/overlay/preview.ts — the text file preview opened by Enter on a
// regular file: a near-full-screen box with the file's path as a header,
// its (already ANSI-parsed) content scrolled underneath, and a footer
// naming the way back. Colors and chrome match the app's other overlays
// (progress.ts/help.ts/confirm.ts) — the one difference is that each
// content row draws pre-styled segments from `term/ansiParse.ts` (bat's own
// syntax-highlighting colors) instead of a single `Style` for the whole
// row, since that highlighting is the entire point of piping through `bat`
// in the first place.

import type { StyledSegment } from "../../term/ansiParse.ts";
import { ATTR_BOLD, type Screen, type Style } from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, stringWidth, truncate } from "../../term/width.ts";

export type PreviewOverlayState = {
  path: string;
  lines: StyledSegment[][];
  scrollOffset: number;
  loading: boolean;
  error: string | null;
  truncated: boolean;
};

// A near-full-screen pane, unlike the small centered boxes the other
// overlays use — reading file content benefits from all the width and
// height the terminal has to spare.
const MARGIN_X = 2;
const MARGIN_Y = 1;
// border, path header, rule, <content>, rule, footer, border.
const CHROME_ROWS = 6;

export type PreviewBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function computePreviewBox(
  screenWidth: number,
  screenHeight: number,
): PreviewBoxRect {
  const w = screenWidth <= 0 ? 1 : screenWidth;
  const h = screenHeight <= 0 ? 1 : screenHeight;
  const width = Math.min(Math.max(w - MARGIN_X * 2, 1), w);
  const height = Math.min(Math.max(h - MARGIN_Y * 2, 1), h);
  return {
    x: Math.max(0, Math.floor((w - width) / 2)),
    y: Math.max(0, Math.floor((h - height) / 2)),
    width,
    height,
  };
}

/** How many content rows actually fit inside the box `computePreviewBox` would draw. */
export function previewViewportHeight(
  screenWidth: number,
  screenHeight: number,
): number {
  const box = computePreviewBox(screenWidth, screenHeight);
  return Math.max(box.height - CHROME_ROWS, 0);
}

/**
 * The largest `scrollOffset` that still shows a full screen of content —
 * `state/store.ts`'s `previewScroll` takes this as its clamp bound,
 * computed here (not in the store, which has no terminal size to work
 * with) exactly like `ui/overlay/help.ts`'s `maxHelpScroll`.
 */
export function maxPreviewScroll(
  screenWidth: number,
  screenHeight: number,
  lineCount: number,
): number {
  const viewportHeight = previewViewportHeight(screenWidth, screenHeight);
  return Math.max(0, lineCount - viewportHeight);
}

/**
 * One content row: draw each styled segment in sequence, clipped to
 * `width` columns. A segment with no explicit foreground (plain `cat`
 * output, or bat's own "no color for this run" default) gets
 * `colors.titleEmphasis` rather than being left as "terminal default" —
 * every other overlay in this app sets its text color explicitly for the
 * same reason: a user's own terminal palette could otherwise render
 * unreadably dim (or invisible) against this overlay's dark backdrop.
 */
function renderLine(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  segments: StyledSegment[],
  bg: number,
): void {
  let col = 0;
  for (const seg of segments) {
    if (col >= width) break;
    const text = truncate(seg.text, width - col);
    if (text.length === 0) continue;
    screen.put(x + col, y, text, {
      fg: seg.style.fg ?? colors.titleEmphasis,
      bg: seg.style.bg ?? bg,
      attr: seg.style.attr,
    });
    col += stringWidth(text);
  }
}

/**
 * Draw the overlay into `screen`. `state.scrollOffset` is `state.overlay`'s
 * own (already store-clamped) value; this function re-derives the viewport
 * height from `screenWidth`/`screenHeight` and slices `state.lines` from
 * there, so it never reads past the array or draws into the border.
 */
export function renderPreviewOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  state: PreviewOverlayState,
): void {
  const box = computePreviewBox(screenWidth, screenHeight);
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
  const ruleWidth = Math.max(box.width - 2, 0);

  const headerY = box.y + 1;
  const ruleY = box.y + 2;
  const contentTop = box.y + 3;
  const viewportHeight = Math.max(box.height - CHROME_ROWS, 0);
  const footerRuleY = contentTop + viewportHeight;
  const footerY = footerRuleY + 1;

  screen.put(innerX, headerY, truncate(state.path, innerWidth), {
    fg: colors.titleEmphasis,
    attr: ATTR_BOLD,
    bg,
  });

  if (ruleY < bottomBorderY) {
    screen.put(box.x + 1, ruleY, "─".repeat(ruleWidth), {
      fg: colors.chrome,
      bg,
    });
  }

  if (state.loading) {
    if (contentTop < bottomBorderY) {
      screen.put(innerX, contentTop, truncate("loading…", innerWidth), {
        fg: colors.dim,
        bg,
      });
    }
  } else if (state.error) {
    if (contentTop < bottomBorderY) {
      screen.put(innerX, contentTop, truncate(state.error, innerWidth), {
        fg: colors.error,
        bg,
      });
    }
  } else {
    const maxOffset = Math.max(0, state.lines.length - viewportHeight);
    const offset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
    for (let row = 0; row < viewportHeight; row++) {
      const y = contentTop + row;
      if (y >= bottomBorderY) break;
      const line = state.lines[offset + row];
      if (line === undefined) continue;
      renderLine(screen, innerX, y, innerWidth, line, bg);
    }
  }

  if (footerRuleY < bottomBorderY) {
    screen.put(box.x + 1, footerRuleY, "─".repeat(ruleWidth), {
      fg: colors.chrome,
      bg,
    });
  }

  if (footerY < bottomBorderY) {
    const scrollHint =
      !state.loading && !state.error && state.lines.length > viewportHeight
        ? "↑/↓ or j/k scrolls, PgUp/PgDn pages, g/G jumps · "
        : "";
    const truncHint = state.truncated ? " · truncated" : "";
    screen.put(
      innerX,
      footerY,
      pad(`${scrollHint}Esc back${truncHint}`, innerWidth),
      {
        fg: colors.dim,
        bg,
      },
    );
  }
}
