// term/ansiParse.ts — turn an SGR-colored text blob (bat's `--color=always`
// output, or plain `cat` output with no escapes at all) into per-line
// arrays of styled text runs `ui/overlay/preview.ts` can hand straight to
// `Screen.put`. Pure and independently testable, same as term/width.ts —
// this is the only place in the codebase that has to understand SGR.
//
// Only SGR (`ESC [ ... m`) is interpreted; every other CSI sequence (cursor
// moves, erase-line, etc.) and every OSC sequence are stripped and ignored —
// bat with `--paging=never` never emits any of those for a plain file dump,
// but stripping unconditionally means garbage from an unexpected tool
// degrades to plain text instead of leaking escape bytes onto the screen.
//
// SGR state persists across line breaks (real terminal semantics: a color
// opened on one line and never reset carries into the next) since bat
// resets at the end of every highlighted line but a plain `cat` of a file
// that itself happens to contain raw escape bytes might not.

import type { Style } from "./screen.ts";
import { graphemes, stringWidth } from "./width.ts";

export type StyledSegment = { text: string; style: Style };

const TAB_WIDTH = 4;

const ATTR_BOLD = 1 << 0;
const ATTR_DIM = 1 << 1;
const ATTR_ITALIC = 1 << 2;
const ATTR_REVERSE = 1 << 3;

// ── 256-color palette -> packed 0xRRGGBB ──
// Standard xterm layout: 16 basic colors, a 6x6x6 color cube, then a
// 24-step grayscale ramp — the same table every terminal emulator ships.

const BASIC_16: number[] = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080,
  0xc0c0c0, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff,
  0x00ffff, 0xffffff,
];

function buildPalette(): number[] {
  const table = [...BASIC_16];
  const ramp = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        table.push(
          ((ramp[r] ?? 0) << 16) | ((ramp[g] ?? 0) << 8) | (ramp[b] ?? 0),
        );
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    table.push((v << 16) | (v << 8) | v);
  }
  return table;
}

const PALETTE_256 = buildPalette();

// ── SGR state machine ──

type SgrState = { fg: number; bg: number; attr: number };

function freshState(): SgrState {
  return { fg: -1, bg: -1, attr: 0 };
}

/** Apply one SGR parameter list (already split on `;`) to `state`, in place. */
function applySgr(codes: number[], state: SgrState): void {
  let i = 0;
  while (i < codes.length) {
    const code = codes[i] ?? 0;
    if (code === 0) {
      state.fg = -1;
      state.bg = -1;
      state.attr = 0;
    } else if (code === 1) state.attr |= ATTR_BOLD;
    else if (code === 2) state.attr |= ATTR_DIM;
    else if (code === 3) state.attr |= ATTR_ITALIC;
    else if (code === 7) state.attr |= ATTR_REVERSE;
    else if (code === 22) state.attr &= ~(ATTR_BOLD | ATTR_DIM);
    else if (code === 23) state.attr &= ~ATTR_ITALIC;
    else if (code === 27) state.attr &= ~ATTR_REVERSE;
    else if (code >= 30 && code <= 37) state.fg = BASIC_16[code - 30] ?? -1;
    else if (code === 39) state.fg = -1;
    else if (code >= 40 && code <= 47) state.bg = BASIC_16[code - 40] ?? -1;
    else if (code === 49) state.bg = -1;
    else if (code >= 90 && code <= 97)
      state.fg = BASIC_16[8 + (code - 90)] ?? -1;
    else if (code >= 100 && code <= 107)
      state.bg = BASIC_16[8 + (code - 100)] ?? -1;
    else if (code === 38 || code === 48) {
      const target: "fg" | "bg" = code === 38 ? "fg" : "bg";
      const mode = codes[i + 1];
      if (mode === 5) {
        const idx = codes[i + 2];
        state[target] = idx !== undefined ? (PALETTE_256[idx] ?? -1) : -1;
        i += 2;
      } else if (mode === 2) {
        const r = codes[i + 2] ?? 0;
        const g = codes[i + 3] ?? 0;
        const b = codes[i + 4] ?? 0;
        state[target] = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
        i += 4;
      }
    }
    i++;
  }
}

function styleOf(state: SgrState): Style {
  const style: Style = {};
  if (state.fg !== -1) style.fg = state.fg;
  if (state.bg !== -1) style.bg = state.bg;
  if (state.attr !== 0) style.attr = state.attr;
  return style;
}

// ── main parse ──

// An SGR sequence (`ESC [ params m`) or any other CSI sequence
// (`ESC [ ... <final-byte>`) to skip over.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC byte is the point
const CSI = /\x1b\[([0-9;]*)([a-zA-Z])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching real ESC/BEL bytes is the point
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Every other C0 control byte (tab and newline are handled separately).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping stray control bytes is the point
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Expand tabs to the next 4-column stop, tracking display column via `stringWidth`. */
function expandTabs(
  text: string,
  startCol: number,
): { text: string; col: number } {
  if (!text.includes("\t")) return { text, col: startCol + stringWidth(text) };
  let out = "";
  let col = startCol;
  for (const g of graphemes(text)) {
    if (g === "\t") {
      const spaces = TAB_WIDTH - (col % TAB_WIDTH);
      out += " ".repeat(spaces);
      col += spaces;
    } else {
      out += g;
      col += stringWidth(g);
    }
  }
  return { text: out, col };
}

/**
 * Parse `raw` into one array of styled segments per line. Carriage returns
 * are dropped (bat/cat output is expected to be line-oriented, never a
 * cursor-home redraw) and tabs expand to the next 4-column stop, matching
 * every other fixed-width assumption in this codebase's rendering.
 */
export function parseAnsiLines(raw: string): StyledSegment[][] {
  const withoutOsc = raw.replace(OSC, "");
  const lines: StyledSegment[][] = [];
  const state = freshState();

  for (const rawLine of withoutOsc.split("\n")) {
    const line = rawLine.replace(/\r/g, "");
    const segments: StyledSegment[] = [];
    let lastIndex = 0;
    let col = 0;

    const pushText = (chunk: string) => {
      const cleaned = chunk.replace(CONTROL_CHARS, "");
      if (cleaned.length === 0) return;
      const { text, col: newCol } = expandTabs(cleaned, col);
      col = newCol;
      segments.push({ text, style: styleOf(state) });
    };

    CSI.lastIndex = 0;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((match = CSI.exec(line)) !== null) {
      pushText(line.slice(lastIndex, match.index));
      lastIndex = CSI.lastIndex;
      const [, params, final] = match;
      if (final === "m") {
        const codes = params ? params.split(";").map(Number) : [0];
        applySgr(codes, state);
      }
      // Any other final byte (K, H, ...): the sequence is dropped and
      // `state` is left untouched — see the file header.
    }
    pushText(line.slice(lastIndex));
    lines.push(segments);
  }
  return lines;
}
