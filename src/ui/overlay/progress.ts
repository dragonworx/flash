// ui/overlay/progress.ts — the paste (copy) progress overlay: a centered
// box drawn over the file list with a bar, percentage, item/byte counts,
// the current path (truncated via term/width.ts), and "Esc to cancel".
//
// Matches the Phase 3 visual language: the same box-drawing border and
// chrome colors as ui/chrome.ts's banner, so it reads as part of the same
// app rather than a bolted-on dialog. `Screen.flush()` already suppresses
// all SGR under `--no-color`/`NO_COLOR`/non-TTY (term/ansi.ts's kill
// switch), so this file never special-cases color itself — every `Style`
// below degrades to plain text for free. The bar's fill characters
// (█/░) are unicode box-drawing, which render fine even under
// `--icons=ascii` in any real terminal, but `--icons=ascii` exists
// precisely for terminals (or captured logs) that cannot render extended
// glyphs at all, so this file accepts an explicit `ascii` flag and
// substitutes `#`/`-` when it's set, same as term/theme.ts's icon table
// does for entry glyphs.

import { formatSize } from "../../fsapi/entry.ts";
import { ATTR_BOLD, type Screen, type Style } from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, stringWidth, truncate } from "../../term/width.ts";

export type ProgressOverlayState = {
  label: string;
  done: number;
  total: number;
  currentPath: string;
  bytesDone: number;
  bytesTotal: number;
};

const BOX_WIDTH_MIN = 24;
const BOX_WIDTH_MAX = 64;
const BOX_HEIGHT = 8; // border, title, blank, bar, counts, path, footer, border

export type ProgressBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Where the box lands, centered in `screenWidth` x `screenHeight`, clamped to fit. */
export function computeProgressBox(
  screenWidth: number,
  screenHeight: number,
): ProgressBoxRect {
  const w = screenWidth <= 0 ? 1 : screenWidth;
  const h = screenHeight <= 0 ? 1 : screenHeight;
  const preferred = Math.max(BOX_WIDTH_MIN, Math.min(BOX_WIDTH_MAX, w - 4));
  const width = Math.min(preferred, w);
  const height = Math.min(BOX_HEIGHT, h);
  return {
    x: Math.max(0, Math.floor((w - width) / 2)),
    y: Math.max(0, Math.floor((h - height) / 2)),
    width,
    height,
  };
}

/** Pure: the bar's fill string at `innerWidth` columns for `fraction` (0..1, clamped). */
export function renderBar(
  fraction: number,
  innerWidth: number,
  ascii: boolean,
): string {
  if (innerWidth <= 0) return "";
  const clamped = Math.max(
    0,
    Math.min(1, Number.isFinite(fraction) ? fraction : 0),
  );
  const filled = Math.round(clamped * innerWidth);
  const fillChar = ascii ? "#" : "█";
  const emptyChar = ascii ? "-" : "░";
  return fillChar.repeat(filled) + emptyChar.repeat(innerWidth - filled);
}

/** "12.3M / 45.0M" — pure, tested directly (tests/progress.test.ts). */
export function formatByteCounts(
  bytesDone: number,
  bytesTotal: number,
): string {
  return `${formatSize(bytesDone)} / ${formatSize(bytesTotal)}`;
}

function fractionOf(state: ProgressOverlayState): number {
  if (state.bytesTotal > 0) return state.bytesDone / state.bytesTotal;
  if (state.total > 0) return state.done / state.total;
  return 0;
}

/**
 * Draw the overlay into `screen`. `screenWidth`/`screenHeight` are the full
 * frame size — this function computes and centers its own box, the same
 * way `ui/chrome.ts`'s banner owns its own layout. Degrades row by row as
 * the box shrinks (`computeProgressBox` clamps to whatever the terminal
 * actually has), never throwing on a tiny terminal.
 */
export function renderProgressOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  state: ProgressOverlayState,
  ascii: boolean,
): void {
  const box = computeProgressBox(screenWidth, screenHeight);
  if (box.width < 4 || box.height < 4) return;

  const borderStyle: Style = { fg: colors.chrome };
  screen.box(box.x, box.y, box.width, box.height, borderStyle);

  const innerX = box.x + 2;
  const innerWidth = Math.max(box.width - 4, 0);
  const bottomBorderY = box.y + box.height - 1;

  const titleY = box.y + 1;
  const barY = box.y + 3;
  const countsY = box.y + 4;
  const pathY = box.y + 5;
  const footerY = box.y + 6;

  screen.put(innerX, titleY, truncate(state.label, innerWidth), {
    fg: colors.titleEmphasis,
    attr: ATTR_BOLD,
  });

  if (barY < bottomBorderY) {
    const frac = fractionOf(state);
    const pctText = ` ${Math.round(frac * 100)}%`;
    const barWidth = Math.max(innerWidth - stringWidth(pctText), 0);
    screen.put(innerX, barY, renderBar(frac, barWidth, ascii), {
      fg: colors.accent,
    });
    screen.put(innerX + barWidth, barY, pctText, { fg: colors.dim });
  }

  if (countsY < bottomBorderY) {
    const counts =
      state.total > 0
        ? `${state.done}/${state.total} items · ${formatByteCounts(state.bytesDone, state.bytesTotal)}`
        : formatByteCounts(state.bytesDone, state.bytesTotal);
    screen.put(innerX, countsY, truncate(counts, innerWidth), {
      fg: colors.dim,
    });
  }

  if (pathY < bottomBorderY) {
    screen.put(innerX, pathY, truncate(state.currentPath, innerWidth), {
      fg: colors.dim,
    });
  }

  if (footerY < bottomBorderY) {
    screen.put(innerX, footerY, pad("Esc to cancel", innerWidth), {
      fg: colors.dim,
    });
  }
}
