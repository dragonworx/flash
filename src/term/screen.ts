// term/screen.ts — the cell-buffer renderer: front/back double buffering
// and a diffed flush(). This is the single most important file in the app
// (see the plan): nothing else ever writes to stdout directly, everything
// writes cells into the back buffer here and `flush()` decides what
// actually needs to hit the wire.
//
// Performance invariant, measured on this machine: a 200x50 full repaint
// plus full diff costs ~0.23ms — the diff itself is never the bottleneck,
// so this stays a plain array of reused `Cell` objects rather than typed
// arrays (which measured identically and buy nothing). The real budget is
// output bytes: `process.stdout.write` to a TTY is blocking at roughly
// 4.8 KB/ms in Bun, so a naive full-screen repaint with SGR codes (~40KB)
// costs ~8ms while a properly diffed single-line change is well under 2KB.
// `flush()` must never emit more than a few KB for a small change — that is
// the whole point of the diff, and `bytesWritten` below exists so callers
// (and tests) can check it stays that way.
//
// The diff walks the back buffer once, comparing each cell to the front
// buffer. A "run" is a contiguous stretch of changed cells on one row: the
// whole run gets exactly one cursor move, and an SGR escape is emitted only
// when the style actually changes cell-to-cell — including across runs, via
// a `flush()`-scoped "current SGR state" — so a frame with many
// identically-styled changed cells does not re-emit color per character.
//
// Wide characters: `put()` measures with `term/width.ts`. A 2-column
// grapheme occupies two cells — the first cell holds the glyph with
// `width: 2`, the second is a continuation cell (`ch: ""`) that the diff
// walk always skips, so a wide character can never be split across a
// partial redraw. A 2-wide grapheme that would straddle the right edge is
// replaced with a single space instead of being clipped mid-glyph.

import * as ansi from "./ansi.ts";
import { graphemes, stringWidth } from "./width.ts";

// ── types ──

export const ATTR_BOLD = 1 << 0;
export const ATTR_DIM = 1 << 1;
export const ATTR_ITALIC = 1 << 2;
export const ATTR_REVERSE = 1 << 3;

/** -1 means "terminal default", otherwise a packed 0xRRGGBB truecolor value. */
export type Style = { fg?: number; bg?: number; attr?: number };

export type Cell = {
  ch: string;
  fg: number;
  bg: number;
  attr: number;
  width: 1 | 2;
};

const NONE = -1;

function defaultWrite(chunk: string): void {
  process.stdout.write(chunk);
}

function blankCell(): Cell {
  return { ch: " ", fg: NONE, bg: NONE, attr: 0, width: 1 };
}

function allocate(columns: number, rows: number): Cell[] {
  const cells = new Array<Cell>(columns * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = blankCell();
  return cells;
}

function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.ch === b.ch &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.attr === b.attr &&
    a.width === b.width
  );
}

function sgrFor(fg: number, bg: number, attr: number): string {
  const codes: (string | number)[] = [0];
  if (attr & ATTR_BOLD) codes.push(1);
  if (attr & ATTR_DIM) codes.push(2);
  if (attr & ATTR_ITALIC) codes.push(3);
  if (attr & ATTR_REVERSE) codes.push(7);
  if (fg !== NONE)
    codes.push(`38;2;${(fg >> 16) & 0xff};${(fg >> 8) & 0xff};${fg & 0xff}`);
  if (bg !== NONE)
    codes.push(`48;2;${(bg >> 16) & 0xff};${(bg >> 8) & 0xff};${bg & 0xff}`);
  return `\x1b[${codes.join(";")}m`;
}

// ── Screen ──

export class Screen {
  columns: number;
  rows: number;

  private back: Cell[];
  private front: Cell[];
  private forceRepaint = true;
  private readonly writeOut: (chunk: string) => void;
  /** Bytes emitted by the most recent flush() — exposed for tests/debugging. */
  bytesWritten = 0;

  /**
   * `write` is the output sink flush() sends bytes to, defaulting to real
   * stdout. Tests pass a collector instead so `bun test` doesn't dump raw
   * escape sequences into the test runner's own output — flush() still
   * returns the emitted string either way, which is what callers (and
   * every test in tests/screen.test.ts) should assert on.
   */
  constructor(
    columns: number,
    rows: number,
    write: (chunk: string) => void = defaultWrite,
  ) {
    this.columns = Math.max(columns, 1);
    this.rows = Math.max(rows, 1);
    this.back = allocate(this.columns, this.rows);
    this.front = allocate(this.columns, this.rows);
    this.writeOut = write;
  }

  /** Reallocate both buffers and force a full repaint on the next flush(). */
  resize(columns: number, rows: number): void {
    this.columns = Math.max(columns, 1);
    this.rows = Math.max(rows, 1);
    this.back = allocate(this.columns, this.rows);
    this.front = allocate(this.columns, this.rows);
    this.forceRepaint = true;
  }

  /** Reset every cell in the back buffer to blank, in place. */
  clear(): void {
    for (const cell of this.back) {
      cell.ch = " ";
      cell.fg = NONE;
      cell.bg = NONE;
      cell.attr = 0;
      cell.width = 1;
    }
  }

  private setCell(
    x: number,
    y: number,
    ch: string,
    fg: number,
    bg: number,
    attr: number,
    width: 1 | 2,
  ): void {
    if (x < 0 || x >= this.columns || y < 0 || y >= this.rows) return;
    const cell = this.back[y * this.columns + x];
    if (!cell) return;
    cell.ch = ch;
    cell.fg = fg;
    cell.bg = bg;
    cell.attr = attr;
    cell.width = width;
  }

  private setContinuation(x: number, y: number): void {
    if (x < 0 || x >= this.columns || y < 0 || y >= this.rows) return;
    const cell = this.back[y * this.columns + x];
    if (!cell) return;
    cell.ch = "";
    cell.fg = NONE;
    cell.bg = NONE;
    cell.attr = 0;
    cell.width = 1;
  }

  /**
   * Write `text` into the back buffer starting at (x, y), one row only —
   * callers wrap their own text. Clips at both edges; a 2-wide grapheme
   * that would straddle the right edge becomes a single space rather than
   * being cut mid-glyph.
   */
  put(x: number, y: number, text: string, style: Style = {}): void {
    if (y < 0 || y >= this.rows) return;
    const fg = style.fg ?? NONE;
    const bg = style.bg ?? NONE;
    const attr = style.attr ?? 0;

    let col = x;
    for (const g of graphemes(text)) {
      if (col >= this.columns) break;
      const raw = stringWidth(g);
      if (raw <= 0) continue; // zero-width grapheme: no column to consume
      const w: 1 | 2 = raw >= 2 ? 2 : 1;

      if (col < 0) {
        col += w;
        continue;
      }
      if (w === 2 && col === this.columns - 1) {
        this.setCell(col, y, " ", fg, bg, attr, 1);
        col++;
        break;
      }
      this.setCell(col, y, g, fg, bg, attr, w);
      if (w === 2) this.setContinuation(col + 1, y);
      col += w;
    }
  }

  /** Draw a single-line box border (┌─┐│└┘) at (x, y), sized w × h. */
  box(x: number, y: number, w: number, h: number, style: Style = {}): void {
    if (w <= 0 || h <= 0) return;
    if (w === 1) {
      for (let row = 0; row < h; row++) this.put(x, y + row, "│", style);
      return;
    }
    if (h === 1) {
      this.put(x, y, "─".repeat(w), style);
      return;
    }

    const horizontal = "─".repeat(w - 2);
    this.put(x, y, `┌${horizontal}┐`, style);
    for (let row = 1; row < h - 1; row++) {
      this.put(x, y + row, "│", style);
      this.put(x + w - 1, y + row, "│", style);
    }
    this.put(x, y + h - 1, `└${horizontal}┘`, style);
  }

  /**
   * Diff the back buffer against the front buffer, emit only the changed
   * runs wrapped in synchronized output, swap buffers, and return what was
   * written (also written to stdout as a side effect). Emits nothing —
   * not even the synchronized-output wrapper — when nothing changed.
   */
  flush(): string {
    const colorEnabled = ansi.isEnabled();
    const parts: string[] = [];

    let curFg = NONE;
    let curBg = NONE;
    let curAttr = 0;
    let styleKnown = false;

    for (let y = 0; y < this.rows; y++) {
      let x = 0;
      while (x < this.columns) {
        const idx = y * this.columns + x;
        const back = this.back[idx];
        const front = this.front[idx];
        if (!back || !front) {
          x++;
          continue;
        }
        if (back.ch === "") {
          // Stray continuation with nothing preceding it in this scan (its
          // wide glyph was unchanged) — never emitted on its own.
          x++;
          continue;
        }
        const changed = this.forceRepaint || !cellsEqual(back, front);
        if (!changed) {
          x++;
          continue;
        }

        // Start of a changed run: one cursor move, then walk forward while
        // cells on this row keep being changed.
        const runStartCol = x;
        let text = "";
        let cx = x;
        while (cx < this.columns) {
          const i2 = y * this.columns + cx;
          const b = this.back[i2];
          if (!b) break;
          if (b.ch === "") {
            cx++;
            continue;
          } // continuation cell: already part of the previous glyph's text
          const f = this.front[i2];
          const isChanged = this.forceRepaint || !f || !cellsEqual(b, f);
          if (!isChanged) break;

          if (
            colorEnabled &&
            (!styleKnown ||
              b.fg !== curFg ||
              b.bg !== curBg ||
              b.attr !== curAttr)
          ) {
            text += sgrFor(b.fg, b.bg, b.attr);
            curFg = b.fg;
            curBg = b.bg;
            curAttr = b.attr;
            styleKnown = true;
          }
          text += b.ch;
          cx += b.width;
        }

        parts.push(ansi.moveTo(y + 1, runStartCol + 1), text);
        x = cx;
      }
    }

    let output = "";
    if (parts.length > 0) {
      output = `${ansi.beginSyncOutput()}${parts.join("")}${ansi.endSyncOutput()}`;
      this.writeOut(output);
    }

    this.bytesWritten = Buffer.byteLength(output, "utf8");
    this.copyBackToFront();
    this.forceRepaint = false;
    return output;
  }

  private copyBackToFront(): void {
    for (let i = 0; i < this.back.length; i++) {
      const b = this.back[i];
      const f = this.front[i];
      if (!b || !f) continue;
      f.ch = b.ch;
      f.fg = b.fg;
      f.bg = b.bg;
      f.attr = b.attr;
      f.width = b.width;
    }
  }
}
