// ui/overlay/help.ts — the `?` key reference: a centered box with one tab
// per binding category (Navigation, Selection, ...) and ←/→ to switch
// between them.
//
// Generated, not hand-maintained: `buildHelpTabs()` below is a pure
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
// unconditionally). The active tab is likewise marked with `[brackets]`,
// not color alone, for the same no-color-mode reason.

import { BINDINGS, type BindingCategory, ESCAPE_HELP } from "../../keymap.ts";
import { ATTR_BOLD, type Screen, type Style } from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, stringWidth, truncate } from "../../term/width.ts";

// ── content: one tab per category ──

export type HelpBindingLine = { keys: string; description: string };

export type HelpTab = {
  category: BindingCategory;
  title: string;
  lines: HelpBindingLine[];
};

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
 * Flatten `BINDINGS` (plus `ESCAPE_HELP`) into one tab per non-empty
 * category, in `CATEGORY_ORDER`. Pure and cheap enough to call on every
 * render — there are barely thirty bindings — but callers that need it more
 * than once per frame should still reuse `HELP_TABS` below rather than
 * calling this again, since the list never changes at runtime.
 */
export function buildHelpTabs(): HelpTab[] {
  const tabs: HelpTab[] = [];
  for (const category of CATEGORY_ORDER) {
    const entries = BINDINGS.filter((b) => b.category === category);
    if (entries.length === 0 && category !== "navigation") continue;
    const lines: HelpBindingLine[] = [];
    if (category === "navigation") {
      lines.push({
        keys: ESCAPE_HELP.display.join(" / "),
        description: ESCAPE_HELP.description,
      });
    }
    for (const b of entries) {
      lines.push({ keys: b.display.join(" / "), description: b.description });
    }
    tabs.push({ category, title: CATEGORY_TITLES[category], lines });
  }
  return tabs;
}

/** Computed once — the binding table is static for the life of the process. */
export const HELP_TABS: HelpTab[] = buildHelpTabs();

/** Clamp an arbitrary (possibly stale or out-of-range) tab index into `HELP_TABS`. */
function clampTab(tab: number): number {
  return Math.max(0, Math.min(tab, HELP_TABS.length - 1));
}

// ── box geometry ──

// Each tab renders as `[Title]` (active) or ` Title ` (inactive) — both
// exactly `title.length + 2` columns wide, so switching tabs never reflows
// the bar — joined with a single space. The box has to be wide enough to
// show every tab at once (no tab-bar scrolling), so `BOX_WIDTH_MIN` grows to
// fit them rather than staying the fixed 40 columns other overlays use.
function tabBarWidth(tabs: HelpTab[]): number {
  const cells = tabs.reduce((sum, t) => sum + stringWidth(t.title) + 2, 0);
  return cells + Math.max(tabs.length - 1, 0);
}

const BOX_WIDTH_MIN = Math.max(40, tabBarWidth(HELP_TABS) + 4);
const BOX_WIDTH_MAX = 84;
// border, title, tab bar, rule, <content>, blank, footer, border.
const CHROME_ROWS = 7;
const KEY_COL_WIDTH = 20;

export type HelpBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Centered box, sized like the other overlays but wider (long descriptions,
 * and now the tab bar, both need the room) and as tall as the *tallest*
 * tab's content wants — every tab shares one box size so switching tabs
 * never resizes the box — clamped to whatever the terminal actually has,
 * same defensive clamp-to-screen pattern as `overlay/progress.ts`'s
 * `computeProgressBox`.
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
  const maxTabLines = HELP_TABS.reduce(
    (max, t) => Math.max(max, t.lines.length),
    0,
  );
  const desiredHeight = maxTabLines + CHROME_ROWS;
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
 * The largest `scrollOffset` that still shows a full screen of the active
 * tab's content — `state/store.ts`'s `helpScroll` takes this as its clamp
 * bound. `lineCount` is the active tab's own line count (caller-supplied,
 * same pattern `overlay/preview.ts`'s `maxPreviewScroll` already uses for
 * its scrollable content) since this file has no access to `AppState`.
 */
export function maxHelpScroll(
  screenWidth: number,
  screenHeight: number,
  lineCount: number,
): number {
  const viewportHeight = helpViewportHeight(screenWidth, screenHeight);
  return Math.max(0, lineCount - viewportHeight);
}

// ── render ──

/**
 * Draw the tab bar: one `[Title]`/` Title ` cell per category, centered
 * within `width`, active cell picked out by both color (bg highlight, bold)
 * and brackets (so `--no-color`/non-TTY output still shows which tab is
 * open). Cells beyond the right edge are truncated rather than wrapped —
 * `BOX_WIDTH_MIN` above keeps this from happening in practice, but a
 * terminal narrower than that still clamps the box to the screen (see
 * `computeHelpBox`), so this stays defensive.
 */
function renderTabBar(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  activeIndex: number,
  bg: number,
): void {
  const cells = HELP_TABS.map((t, i) =>
    i === activeIndex ? `[${t.title}]` : ` ${t.title} `,
  );
  const totalWidth =
    cells.reduce((sum, c) => sum + stringWidth(c), 0) +
    Math.max(cells.length - 1, 0);
  const startX = x + Math.max(Math.floor((width - totalWidth) / 2), 0);
  const rightEdge = x + width;

  let cx = startX;
  for (let i = 0; i < cells.length; i++) {
    if (cx >= rightEdge) break;
    const active = i === activeIndex;
    const cell = cells[i] ?? "";
    const text = truncate(cell, Math.max(rightEdge - cx, 0));
    screen.put(
      cx,
      y,
      text,
      active
        ? { fg: colors.titleEmphasis, bg: colors.cursorBg, attr: ATTR_BOLD }
        : { fg: colors.dim, bg },
    );
    cx += stringWidth(text);
    if (i < cells.length - 1 && cx < rightEdge) {
      screen.put(cx, y, " ", { bg });
      cx += 1;
    }
  }
}

/**
 * Draw the overlay into `screen`. `scrollOffset` and `activeTab` are
 * `state.overlay`'s own (already store-clamped) values; this function
 * re-derives the viewport height from `screenWidth`/`screenHeight` and
 * slices the active tab's lines from there, so it never reads past the
 * array or draws into the border.
 */
export function renderHelpOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  scrollOffset: number,
  activeTab: number,
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
  const tabBarY = box.y + 2;
  const tabRuleY = box.y + 3;
  const contentTop = box.y + 4;
  const viewportHeight = Math.max(box.height - CHROME_ROWS, 0);
  const footerY = contentTop + viewportHeight + 1;

  screen.put(
    innerX,
    titleY,
    pad(truncate("Flash Help", innerWidth), innerWidth, "center"),
    { fg: colors.titleEmphasis, attr: ATTR_BOLD, bg },
  );

  const tabIndex = clampTab(activeTab);
  renderTabBar(screen, innerX, tabBarY, innerWidth, tabIndex, bg);

  // A rule under the tab row, doing double duty as the box's own side
  // borders (├/┤) so it reads as one continuous frame rather than a bare
  // line floating inside the box — same border style as the outer box.
  if (box.width >= 2) {
    const ruleWidth = Math.max(box.width - 2, 0);
    screen.put(box.x, tabRuleY, `├${"─".repeat(ruleWidth)}┤`, borderStyle);
  }

  const lines = HELP_TABS[tabIndex]?.lines ?? [];
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  const offset = Math.max(0, Math.min(scrollOffset, maxOffset));

  const keyColWidth = Math.min(KEY_COL_WIDTH, innerWidth);
  const descX = innerX + keyColWidth + 1;
  const descWidth = Math.max(innerWidth - keyColWidth - 1, 0);

  for (let row = 0; row < viewportHeight; row++) {
    const y = contentTop + row;
    if (y >= bottomBorderY) break;
    const line = lines[offset + row];
    if (!line) break;
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

  if (footerY < bottomBorderY) {
    const scrollPart =
      lines.length > viewportHeight
        ? "↑/↓ or j/k scrolls, PgUp/PgDn pages · "
        : "";
    const hint = `${scrollPart}←/→ switches tabs · Esc or ? closes`;
    screen.put(innerX, footerY, pad(hint, innerWidth), { fg: colors.dim, bg });
  }
}
