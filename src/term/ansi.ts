// term/ansi.ts — raw ANSI/VT escape-sequence builders.
//
// Everything here is a small pure function: given some coordinates or a
// string, return the escape sequence (or the styled string) to emit. Nothing
// in this file touches stdout — callers decide when and how to write.
//
// Two kinds of exports live side by side:
//   - Terminal-mode builders (cursor, alt screen, sync output, focus
//     reporting, erase) always return their real sequence. They control
//     structure, not color, so they are never suppressed.
//   - SGR style wrappers (bold/dim/italic/reverse/fg/bg) follow the house
//     pattern from /home/dev/github/goto/colors.js: each one wraps text in
//     an opening code and a trailing reset. Call `setEnabled(false)` for
//     `--no-color`, `NO_COLOR`, or a non-TTY stdout, and every wrapper below
//     starts returning its input unchanged — the same code path then
//     produces plain output.
//
// No mouse-reporting sequences are defined here, ever — flash never grabs
// the mouse (see the plan's "Match the house conventions" / product
// decisions). Do not add any.

// ── color kill-switch ──

let enabled = true;

/** Toggle SGR styling. Pass false for `--no-color`, NO_COLOR, or non-TTY. */
export function setEnabled(value: boolean): void {
  enabled = Boolean(value);
}

/** True when SGR styling is currently applied. */
export function isEnabled(): boolean {
  return enabled;
}

const ESC = "\x1b[";
const SGR_RESET = `${ESC}0m`;

// ── cursor ──

/** Move the cursor to 1-indexed row/col (CUP). */
export function moveTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

export function cursorUp(n = 1): string {
  return `${ESC}${n}A`;
}

export function cursorDown(n = 1): string {
  return `${ESC}${n}B`;
}

export function cursorForward(n = 1): string {
  return `${ESC}${n}C`;
}

export function cursorBack(n = 1): string {
  return `${ESC}${n}D`;
}

export function hideCursor(): string {
  return `${ESC}?25l`;
}

export function showCursor(): string {
  return `${ESC}?25h`;
}

// ── screen modes ──

/** Enter the alternate screen buffer (xterm-style, saves the real screen). */
export function enterAltScreen(): string {
  return `${ESC}?1049h`;
}

/** Leave the alternate screen buffer, restoring whatever was there before. */
export function exitAltScreen(): string {
  return `${ESC}?1049l`;
}

/** Begin a synchronized-output frame — the terminal buffers the redraw. */
export function beginSyncOutput(): string {
  return `${ESC}?2026h`;
}

/** End a synchronized-output frame — the terminal flushes it as one paint. */
export function endSyncOutput(): string {
  return `${ESC}?2026l`;
}

/** Ask the terminal to report focus in/out as `\x1b[I` / `\x1b[O`. */
export function enableFocusReporting(): string {
  return `${ESC}?1004h`;
}

export function disableFocusReporting(): string {
  return `${ESC}?1004l`;
}

/**
 * Ask the terminal to wrap pasted text in `\x1b[200~` / `\x1b[201~`. flash
 * never turns this on — herdr enables it for every pane on its own, so
 * `caps.ts` explicitly disables it on entry and on restore. `term/input.ts`
 * also discards the markers defensively in case one arrives anyway.
 */
export function enableBracketedPaste(): string {
  return `${ESC}?2004h`;
}

export function disableBracketedPaste(): string {
  return `${ESC}?2004l`;
}

// ── erase ──

export function eraseScreen(): string {
  return `${ESC}2J`;
}

export function eraseLine(): string {
  return `${ESC}2K`;
}

export function eraseToEndOfLine(): string {
  return `${ESC}K`;
}

// ── SGR style wrappers ──
//
// Each wrapper closes with a full reset, mirroring goto/colors.js: the
// opening codes are combined into a single sequence and always followed by
// `\x1b[0m`, so wrappers compose safely when nested by the caller.

function style(...codes: (string | number)[]): (text: string) => string {
  const open = codes.map((c) => `${ESC}${c}m`).join("");
  return (text: string) => (enabled ? `${open}${text}${SGR_RESET}` : text);
}

export const bold = style(1);
export const dim = style(2);
export const italic = style(3);
export const reverse = style(7);

/** Raw SGR reset sequence, unwrapped — for callers managing state themselves. */
export function reset(): string {
  return SGR_RESET;
}

/** Wrap `text` in a 24-bit truecolor foreground, reset afterward. */
export function fg(r: number, g: number, b: number): (text: string) => string {
  return style(`38;2;${r};${g};${b}`);
}

/** Wrap `text` in a 24-bit truecolor background, reset afterward. */
export function bg(r: number, g: number, b: number): (text: string) => string {
  return style(`48;2;${r};${g};${b}`);
}
