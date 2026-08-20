// ui/overlay/confirm.ts — the delete confirmation: a centered box naming
// exactly what is about to be permanently unlinked (the user chose
// confirmation over a trash can, so this overlay has to earn it), plus the
// footer's explicit warning that only `y` accepts.
//
// `state/store.ts`'s `startDelete`/`buildDeleteMessage` build the actual
// sentence ("Delete 3 items, including directory 'build/' (412 files)?")
// before this overlay ever opens — this file only renders whatever string
// it's handed, it never counts anything itself. `keymap.ts`'s
// `resolveConfirmKey` is the other half of the safety property this overlay
// exists for: `Enter` is deliberately NOT wired to accept, only a literal
// `y`/`Y` is — a stray keypress (Enter, Space, an arrow key someone meant
// for the list behind this overlay) must never destroy anything. Escape,
// `n`, and every other key all cancel, same as Enter.
//
// Matches the Phase 3 visual language and degrades under `--no-color`/
// `--icons=ascii` for free, same reasoning as overlay/progress.ts's file
// header: `Screen.flush()` already strips SGR, and this file draws nothing
// that depends on a specific icon set.

import { ATTR_BOLD, type Screen, type Style } from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, truncate } from "../../term/width.ts";

const BOX_WIDTH_MIN = 24;
const BOX_WIDTH_MAX = 64;
const BOX_HEIGHT = 6; // border, blank, message, blank, footer, border

export type ConfirmBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Centered box, sized and clamped exactly like the other two overlays. */
export function computeConfirmBox(
  screenWidth: number,
  screenHeight: number,
): ConfirmBoxRect {
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

/**
 * Draw the overlay: the message (truncated, not wrapped — `buildDeleteMessage`
 * keeps it to one sentence) in the warning color, and a footer that spells
 * out the asymmetry explicitly rather than assuming the user remembers it.
 */
export function renderConfirmOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  message: string,
): void {
  const box = computeConfirmBox(screenWidth, screenHeight);
  if (box.width < 4 || box.height < 4) return;

  const borderStyle: Style = { fg: colors.error };
  screen.box(box.x, box.y, box.width, box.height, borderStyle);

  const innerX = box.x + 2;
  const innerWidth = Math.max(box.width - 4, 0);
  const bottomBorderY = box.y + box.height - 1;

  const messageY = box.y + 2;
  const footerY = box.y + 4;

  if (messageY < bottomBorderY) {
    screen.put(innerX, messageY, truncate(message, innerWidth), {
      fg: colors.error,
      attr: ATTR_BOLD,
    });
  }

  if (footerY < bottomBorderY) {
    screen.put(
      innerX,
      footerY,
      pad("y deletes forever · anything else cancels", innerWidth),
      {
        fg: colors.dim,
      },
    );
  }
}
