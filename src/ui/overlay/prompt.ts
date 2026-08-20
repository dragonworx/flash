// ui/overlay/prompt.ts — a reusable one-line text editor: cursor movement,
// Home/End, Ctrl+W word-delete, Ctrl+U clear-to-start, insert/backspace/
// delete. Backs both of Phase 7's text-entry overlays — rename (`r`,
// pre-filled with the current name) and mkdir (`n`, empty) — driven by
// `state/store.ts`'s `startRename`/`startMkdir`/`promptInsertChar`/etc,
// which own the `Overlay { kind: "prompt" }` state this file's functions
// read and return. Nothing here touches `Store` directly: every editing
// operation is a pure `(PromptField) -> PromptField` function, unit-tested
// without a terminal or a filesystem.
//
// Wide-character correctness (the plan's Risk #6): every measurement below
// routes through `term/width.ts`, never `String.length`. The field is
// edited by *grapheme*, not UTF-16 code unit or codepoint, via
// `term/width.ts`'s `graphemes()` — so backspacing a flag emoji or a CJK
// character removes the whole glyph in one keystroke, and the field never
// splits one mid-render. `computePromptView` is the horizontal-scroll math:
// given the full value, the cursor's grapheme index, and the field's column
// width, it returns the visible slice and where (in columns) to draw the
// cursor, scrolling just enough to keep the cursor on screen and never
// splitting a grapheme at either edge.
//
// Validation (`validateName`) lives here too, not in state/store.ts, per
// the plan's file breakdown — it is pure and has no Store dependency, so
// `state/store.ts` importing it does not create a cycle (this file never
// imports state/store.ts). It rejects empty, `.`, `..`, and anything
// containing `/` unconditionally, and an existing name unless it is the
// name being renamed *from* (`ignoreName`) — that is what lets Enter on an
// unchanged rename be a harmless no-op instead of a spurious "already
// exists" error.

import {
  ATTR_BOLD,
  ATTR_REVERSE,
  type Screen,
  type Style,
} from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { graphemes, pad, stringWidth, truncate } from "../../term/width.ts";

// ── field editing (pure) ──

export type PromptField = { value: string; cursor: number };

function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length));
}

/** Insert `ch` (expected to be one grapheme — a single typed keystroke) at the cursor. */
export function insertChar(state: PromptField, ch: string): PromptField {
  const g = graphemes(state.value);
  const cursor = clampCursor(state.cursor, g.length);
  g.splice(cursor, 0, ch);
  return { value: g.join(""), cursor: cursor + 1 };
}

export function backspace(state: PromptField): PromptField {
  const g = graphemes(state.value);
  const cursor = clampCursor(state.cursor, g.length);
  if (cursor === 0) return { value: state.value, cursor };
  g.splice(cursor - 1, 1);
  return { value: g.join(""), cursor: cursor - 1 };
}

export function deleteForward(state: PromptField): PromptField {
  const g = graphemes(state.value);
  const cursor = clampCursor(state.cursor, g.length);
  if (cursor >= g.length) return { value: state.value, cursor };
  g.splice(cursor, 1);
  return { value: g.join(""), cursor };
}

export function moveLeft(state: PromptField): PromptField {
  const length = graphemes(state.value).length;
  return { value: state.value, cursor: clampCursor(state.cursor - 1, length) };
}

export function moveRight(state: PromptField): PromptField {
  const length = graphemes(state.value).length;
  return { value: state.value, cursor: clampCursor(state.cursor + 1, length) };
}

export function moveHome(state: PromptField): PromptField {
  return { value: state.value, cursor: 0 };
}

export function moveEnd(state: PromptField): PromptField {
  return { value: state.value, cursor: graphemes(state.value).length };
}

/**
 * Ctrl+W: delete the word behind the cursor — trailing spaces first, then
 * the run of non-space graphemes before them — the standard readline/shell
 * definition.
 */
export function deleteWordBack(state: PromptField): PromptField {
  const g = graphemes(state.value);
  const cursor = clampCursor(state.cursor, g.length);
  let i = cursor;
  while (i > 0 && g[i - 1] === " ") i--;
  while (i > 0 && g[i - 1] !== " ") i--;
  const next = [...g.slice(0, i), ...g.slice(cursor)];
  return { value: next.join(""), cursor: i };
}

/** Ctrl+U: delete from the start of the field to the cursor. */
export function clearToStart(state: PromptField): PromptField {
  const g = graphemes(state.value);
  const cursor = clampCursor(state.cursor, g.length);
  return { value: g.slice(cursor).join(""), cursor: 0 };
}

// ── validation (pure) ──

/**
 * `null` means valid. Order matters only for which single message a user
 * sees at once; every rule is checked unconditionally except the collision
 * check, which is skipped when `name` equals `ignoreName` — the rename
 * overlay passes the entry's own current name there so leaving it unchanged
 * validates cleanly instead of reporting a collision with itself.
 */
export function validateName(
  name: string,
  existingNames: ReadonlySet<string>,
  ignoreName?: string,
): string | null {
  if (name.length === 0) return "name cannot be empty";
  if (name === "." || name === "..") return "invalid name";
  if (name.includes("/")) return "name cannot contain '/'";
  if (name !== ignoreName && existingNames.has(name)) {
    return `'${name}' already exists`;
  }
  return null;
}

// ── horizontal scroll (pure) ──

export type PromptView = { text: string; cursorCol: number };

/**
 * The visible slice of `value` within `fieldWidth` columns, plus the column
 * (relative to that slice) the cursor should be drawn at. Scrolls just
 * enough to keep the cursor visible — never more — and never splits a
 * grapheme at either edge, the same invariant `term/width.ts`'s `truncate`
 * upholds for read-only text.
 */
export function computePromptView(
  value: string,
  cursor: number,
  fieldWidth: number,
): PromptView {
  if (fieldWidth <= 0) return { text: "", cursorCol: 0 };

  const g = graphemes(value);
  const cursorIdx = clampCursor(cursor, g.length);
  const widths = g.map(stringWidth);

  const cum: number[] = [0];
  for (const w of widths) cum.push((cum[cum.length - 1] ?? 0) + w);

  const cursorColUnscrolled = cum[cursorIdx] ?? 0;

  // Scroll right just enough that the cursor's column, measured from
  // `startIdx`, is inside the field.
  let startIdx = 0;
  if (cursorColUnscrolled >= fieldWidth) {
    while (
      startIdx < cursorIdx &&
      cursorColUnscrolled - (cum[startIdx] ?? 0) >= fieldWidth
    ) {
      startIdx++;
    }
  }

  // Fill forward from startIdx up to fieldWidth columns, one whole grapheme
  // at a time.
  let endIdx = startIdx;
  let width = 0;
  while (endIdx < g.length) {
    const w = widths[endIdx] ?? 0;
    if (width + w > fieldWidth) break;
    width += w;
    endIdx++;
  }

  const text = g.slice(startIdx, endIdx).join("");
  const cursorCol = (cum[cursorIdx] ?? 0) - (cum[startIdx] ?? 0);
  return { text, cursorCol };
}

/** The grapheme rendered at `col` columns into `text` — used to invert the right cell for the cursor. */
function graphemeAtColumn(text: string, col: number): string {
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = stringWidth(g);
    if (col >= w && col < w + gw) return g;
    w += gw;
  }
  return " ";
}

// ── rendering ──

export type PromptOverlayInfo = {
  title: string;
  value: string;
  cursor: number;
  error: string | null;
};

const BOX_WIDTH_MIN = 24;
const BOX_WIDTH_MAX = 64;
const BOX_HEIGHT = 7; // border, title, blank, field, error, footer, border

export type PromptBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Centered box, sized and clamped exactly like `overlay/progress.ts`'s `computeProgressBox`. */
export function computePromptBox(
  screenWidth: number,
  screenHeight: number,
): PromptBoxRect {
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
 * Draw the overlay: title, the editable field with an inverse-video cell
 * standing in for the (otherwise hidden — see term/caps.ts) terminal
 * cursor, an inline validation error when present, and a footer hint.
 * Degrades gracefully on a tiny terminal, same as the progress overlay.
 */
export function renderPromptOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  info: PromptOverlayInfo,
): void {
  const box = computePromptBox(screenWidth, screenHeight);
  if (box.width < 4 || box.height < 4) return;

  const borderStyle: Style = { fg: colors.chrome };
  screen.box(box.x, box.y, box.width, box.height, borderStyle);

  const innerX = box.x + 2;
  const innerWidth = Math.max(box.width - 4, 0);
  const bottomBorderY = box.y + box.height - 1;

  const titleY = box.y + 1;
  const fieldY = box.y + 3;
  const errorY = box.y + 4;
  const footerY = box.y + 5;

  screen.put(innerX, titleY, truncate(info.title, innerWidth), {
    fg: colors.titleEmphasis,
    attr: ATTR_BOLD,
  });

  if (fieldY < bottomBorderY && innerWidth > 0) {
    const view = computePromptView(info.value, info.cursor, innerWidth);
    screen.put(innerX, fieldY, pad(view.text, innerWidth), { fg: colors.dim });
    const cursorChar = graphemeAtColumn(view.text, view.cursorCol);
    screen.put(innerX + view.cursorCol, fieldY, cursorChar, {
      attr: ATTR_REVERSE,
    });
  }

  if (errorY < bottomBorderY && info.error) {
    screen.put(innerX, errorY, truncate(info.error, innerWidth), {
      fg: colors.error,
    });
  }

  if (footerY < bottomBorderY) {
    screen.put(
      innerX,
      footerY,
      pad("Enter confirm · Esc cancel · Ctrl+W/U word/clear", innerWidth),
      {
        fg: colors.dim,
      },
    );
  }
}
