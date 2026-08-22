// ui/overlay/help.ts — the `?` key reference: a centered, scrollable box
// listing every plain-key binding, grouped by category.
//
// Generated, not hand-maintained: `buildHelpLines()` below is a pure
// function of `keymap.ts`'s `BINDINGS` table (plus the hand-written
// `ESCAPE_HELP` entry keymap.ts exports alongside it — see that file's
// comment for why Escape isn't folded into `BINDINGS` itself). There is no
// second, parallel list of "what flash's keys do" anywhere in this file:
// every row on screen is `display.join(" / ")` and `description` read
// straight off the same objects `resolveAction` dispatches through, so this
// screen cannot say something a keypress doesn't actually do, and a new
// binding shows up here automatically the moment it's added to the table.
// tests/help.test.ts is the enforcement: it fails if a category comes up
// empty or a binding's `description` is blank.
//
// Matches the Phase 3 visual language — the same box border and chrome
// colors as ui/chrome.ts's banner and the other overlays — and degrades
// under `--no-color`/`NO_COLOR`/non-TTY for free, the same way
// overlay/confirm.ts and overlay/progress.ts do: `Screen.flush()` already
// strips all SGR on that path, and nothing here special-cases `--icons`
// (the ↑/↓/› glyphs used are UI chrome, not file-type icons — see
// ui/listView.ts's cursor marker for the precedent of drawing those
// unconditionally).

import { BINDINGS, type BindingCategory, ESCAPE_HELP } from "../../keymap.ts";
import { ATTR_BOLD, type Screen, type Style } from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, truncate } from "../../term/width.ts";

// ── content: grouped, flattened lines ──

export type HelpLine =
  | { kind: "heading"; text: string }
  | { kind: "binding"; keys: string; description: string };

// Display order for the help screen — independent of BINDINGS' own array
// order, which instead has to put Shift+↑/↓ and Ctrl+A ahead of the plain
// arrow/letter entries so `resolveAction`'s scan resolves ambiguity
// correctly (see keymap.ts's file comment on that array). The plan asks for
// exactly this grouping and order: "navigation, selection, file operations,
// archives, view, app."
const CATEGORY_ORDER: BindingCategory[] = [
  "navigation",
  "selection",
  "file operations",
  "archives",
  "view",
  "app",
];

const CATEGORY_TITLES: Record<BindingCategory, string> = {
  navigation: "Navigation",
  selection: "Selection",
  "file operations": "File operations",
  archives: "Archives",
  view: "View",
  app: "App",
};

/**
 * Flatten `BINDINGS` (plus `ESCAPE_HELP`) into the exact sequence of lines
 * the overlay draws, one category at a time in `CATEGORY_ORDER`. Pure and
 * cheap enough to call on every render — there are barely thirty bindings —
 * but callers that need it more than once per frame (scroll clamping in
 * main.ts included) should still reuse `HELP_LINES` below rather than
 * calling this again, since the list never changes at runtime.
 */
export function buildHelpLines(): HelpLine[] {
  const lines: HelpLine[] = [];
  for (const category of CATEGORY_ORDER) {
    const entries = BINDINGS.filter((b) => b.category === category);
    if (entries.length === 0 && category !== "navigation") continue;
    lines.push({ kind: "heading", text: CATEGORY_TITLES[category] });
    if (category === "navigation") {
      lines.push({
        kind: "binding",
        keys: ESCAPE_HELP.display.join(" / "),
        description: ESCAPE_HELP.description,
      });
    }
    for (const b of entries) {
      lines.push({
        kind: "binding",
        keys: b.display.join(" / "),
        description: b.description,
      });
    }
  }
  return lines;
}

/** Computed once — the binding table is static for the life of the process. */
export const HELP_LINES: HelpLine[] = buildHelpLines();

// ── box geometry ──

const BOX_WIDTH_MIN = 40;
const BOX_WIDTH_MAX = 84;
// border, title, blank, <content>, blank, footer, border.
const CHROME_ROWS = 6;
const KEY_COL_WIDTH = 20;

export type HelpBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Centered box, sized like the other overlays but wider (long descriptions
 * need the room) and as tall as the content wants, clamped to whatever the
 * terminal actually has — same defensive clamp-to-screen pattern as
 * `overlay/progress.ts`'s `computeProgressBox`.
 */
export function computeHelpBox(
  screenWidth: number,
  screenHeight: number,
): HelpBoxRect {
  const w = screenWidth <= 0 ? 1 : screenWidth;
  const h = screenHeight <= 0 ? 1 : screenHeight;
  const preferredWidth = Math.max(
    BOX_WIDTH_MIN,
    Math.min(BOX_WIDTH_MAX, w - 4),
  );
  const width = Math.min(preferredWidth, w);
  const desiredHeight = HELP_LINES.length + CHROME_ROWS;
  const height = Math.min(desiredHeight, h);
  return {
    x: Math.max(0, Math.floor((w - width) / 2)),
    y: Math.max(0, Math.floor((h - height) / 2)),
    width,
    height,
  };
}

/** How many content rows actually fit inside the box `computeHelpBox` would draw. */
export function helpViewportHeight(
  screenWidth: number,
  screenHeight: number,
): number {
  const box = computeHelpBox(screenWidth, screenHeight);
  return Math.max(box.height - CHROME_ROWS, 0);
}

/**
 * The largest `scrollOffset` that still shows a full screen of content —
 * `state/store.ts`'s `helpScroll` takes this as its clamp bound, computed
 * here (not in the store, which has no terminal size to work with) from the
 * same geometry `renderHelpOverlay` itself uses, so the two can never
 * disagree about where the bottom is.
 */
export function maxHelpScroll(
  screenWidth: number,
  screenHeight: number,
): number {
  const viewportHeight = helpViewportHeight(screenWidth, screenHeight);
  return Math.max(0, HELP_LINES.length - viewportHeight);
}

// ── render ──

/**
 * Draw the overlay into `screen`. `scrollOffset` is `state.overlay`'s own
 * (already store-clamped) value; this function re-derives the viewport
 * height from `screenWidth`/`screenHeight` and slices `HELP_LINES` from
 * there, so it never reads past the array or draws into the border.
 */
export function renderHelpOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  scrollOffset: number,
): void {
  const box = computeHelpBox(screenWidth, screenHeight);
  if (box.width < 4 || box.height < 4) return;

  // A solid backdrop, not just a border: every `put()` below sets this same
  // `bg` too, since `Screen.put` replaces a cell's style wholesale (an
  // omitted `bg` means "terminal default", not "whatever was already
  // there") — without it the file list underneath would show through
  // wherever a line's text is shorter than the box is wide.
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

  screen.put(innerX, titleY, truncate("Keyboard shortcuts", innerWidth), {
    fg: colors.titleEmphasis,
    attr: ATTR_BOLD,
    bg,
  });

  const maxOffset = Math.max(0, HELP_LINES.length - viewportHeight);
  const offset = Math.max(0, Math.min(scrollOffset, maxOffset));

  const keyColWidth = Math.min(KEY_COL_WIDTH, innerWidth);
  const descX = innerX + keyColWidth + 1;
  const descWidth = Math.max(innerWidth - keyColWidth - 1, 0);

  for (let row = 0; row < viewportHeight; row++) {
    const y = contentTop + row;
    if (y >= bottomBorderY) break;
    const line = HELP_LINES[offset + row];
    if (!line) break;
    if (line.kind === "heading") {
      screen.put(innerX, y, truncate(line.text, innerWidth), {
        fg: colors.header,
        attr: ATTR_BOLD,
        bg,
      });
    } else {
      screen.put(innerX, y, pad(line.keys, keyColWidth), {
        fg: colors.accent,
        attr: ATTR_BOLD,
        bg,
      });
      if (descWidth > 0) {
        screen.put(descX, y, truncate(line.description, descWidth), {
          fg: colors.titleEmphasis,
          bg,
        });
      }
    }
  }

  if (footerY < bottomBorderY) {
    const hint =
      HELP_LINES.length > viewportHeight
        ? "↑/↓ or j/k scrolls, PgUp/PgDn pages · Esc or ? closes"
        : "Esc or ? closes";
    screen.put(innerX, footerY, pad(hint, innerWidth), { fg: colors.dim, bg });
  }
}
