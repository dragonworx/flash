// tests/screen.test.ts — the double-buffer diff: the core behavior the
// whole renderer depends on. See src/term/screen.ts for the invariants
// these tests hold it to.

import { afterEach, describe, expect, it } from "bun:test";
import * as ansi from "../src/term/ansi.ts";
import { ATTR_BOLD, Screen } from "../src/term/screen.ts";

afterEach(() => {
  ansi.setEnabled(true);
});

// Built from a string rather than a /regex literal/ containing a raw ESC —
// biome's noControlCharactersInRegex rule flags the literal form.
const ESC = "\x1b";
const cursorMoveRe = new RegExp(`${ESC}\\[\\d+;\\d+H`, "g");
const sgrRe = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const anyEscapeRe = new RegExp(`${ESC}\\[[^a-zA-Z]*[a-zA-Z]`, "g");

function countCursorMoves(output: string): number {
  return output.match(cursorMoveRe)?.length ?? 0;
}

function countSGR(output: string): number {
  // SGR sequences are `\x1b[<digits/semicolons>m` — distinct from cursor
  // moves (end in H) and the sync-output toggle (has a literal "?").
  return output.match(sgrRe)?.length ?? 0;
}

/** Strip every escape sequence, leaving only the glyph text that was sent. */
function textOnly(output: string): string {
  return output.replace(anyEscapeRe, "");
}

/**
 * A Screen wired to a collector instead of real stdout, so `bun test`
 * doesn't dump raw escape sequences into the runner's own output. Every
 * assertion below still reads flush()'s *returned* string, never this
 * collector — it exists only to keep the terminal clean.
 */
function makeScreen(columns: number, rows: number): Screen {
  const written: string[] = [];
  return new Screen(columns, rows, (chunk) => written.push(chunk));
}

describe("Screen.flush diffing", () => {
  it("emits nothing on a second flush of an identical frame", () => {
    const screen = makeScreen(10, 3);
    screen.put(0, 0, "hello", {});
    screen.flush(); // first flush: full repaint, settles front == back

    screen.put(0, 0, "hello", {}); // same content again
    const second = screen.flush();
    expect(second).toBe("");
    expect(screen.bytesWritten).toBe(0);
  });

  it("changing one cell emits exactly one cursor move", () => {
    const screen = makeScreen(10, 3);
    screen.flush(); // settle the initial full repaint

    screen.put(3, 1, "x", {});
    const out = screen.flush();
    expect(countCursorMoves(out)).toBe(1);
    expect(out).toContain(ansi.moveTo(2, 4)); // 1-indexed: row 2, col 4
    expect(out).toContain("x");
  });

  it("a run of changed cells emits one cursor move, not one per cell", () => {
    const screen = makeScreen(10, 3);
    screen.flush();

    screen.put(0, 0, "abcde", {});
    const out = screen.flush();
    expect(countCursorMoves(out)).toBe(1);
    expect(out).toContain("abcde");
  });

  it("does not re-emit SGR for consecutive cells sharing a style", () => {
    const screen = makeScreen(10, 3);
    screen.flush();

    screen.put(0, 0, "abcde", { fg: 0xff0000, attr: ATTR_BOLD });
    const out = screen.flush();
    expect(countSGR(out)).toBe(1);
  });

  it("emits a fresh SGR only where the style actually changes mid-run", () => {
    const screen = makeScreen(10, 3);
    screen.flush();

    screen.put(0, 0, "ab", { fg: 0xff0000 });
    screen.put(2, 0, "cd", { fg: 0x00ff00 });
    const out = screen.flush();
    expect(countCursorMoves(out)).toBe(1); // still one contiguous run
    expect(countSGR(out)).toBe(2); // the color changed once inside it
  });

  it("wraps a non-empty flush in synchronized output", () => {
    const screen = makeScreen(10, 3);
    const out = screen.flush();
    expect(out.startsWith(ansi.beginSyncOutput())).toBe(true);
    expect(out.endsWith(ansi.endSyncOutput())).toBe(true);
  });

  it("emits no SGR at all when color is disabled", () => {
    const screen = makeScreen(10, 3);
    screen.flush();

    ansi.setEnabled(false);
    screen.put(0, 0, "abc", { fg: 0xff0000, attr: ATTR_BOLD });
    const out = screen.flush();
    expect(countSGR(out)).toBe(0);
    expect(out).toContain("abc");
  });
});

describe("wide characters", () => {
  it("occupies two cells for a 2-wide grapheme and never emits the continuation separately", () => {
    const screen = makeScreen(10, 3);
    screen.flush(); // settle to a blank baseline

    screen.put(0, 0, "世界", {});
    const out = screen.flush();
    expect(textOnly(out)).toBe("世界");
  });

  it("replaces a 2-wide char that would straddle the right edge with a space", () => {
    const screen = makeScreen(4, 1);
    screen.put(0, 0, "abc世", {}); // 世 would need columns 3-4, but col 3 is the last column
    const out = screen.flush();
    expect(out).toContain("abc ");
    expect(out).not.toContain("世");
  });

  it("does not resurrect a wide glyph's text when only a neighboring cell changes", () => {
    const screen = makeScreen(10, 3);
    screen.flush();
    screen.put(0, 0, "世界", {});
    screen.flush();

    screen.put(4, 0, "x", {});
    const out = screen.flush();
    expect(out).not.toContain("世");
    expect(out).not.toContain("界");
    expect(out).toContain("x");
  });
});

describe("Screen.resize", () => {
  it("forces a full repaint on the next flush after resize", () => {
    const screen = makeScreen(10, 3);
    screen.put(0, 0, "hi", {});
    screen.flush();

    screen.resize(10, 3); // same dimensions, still forces a repaint
    screen.put(0, 0, "hi", {}); // identical visible content as before
    const out = screen.flush();
    expect(out).not.toBe("");
    expect(out).toContain("hi");
  });

  it("clamps degenerate dimensions to at least 1x1", () => {
    const screen = makeScreen(0, 0);
    expect(screen.columns).toBeGreaterThanOrEqual(1);
    expect(screen.rows).toBeGreaterThanOrEqual(1);
  });
});

describe("Screen.clear", () => {
  it("resets the back buffer so the next flush shows blanks where content was", () => {
    const screen = makeScreen(5, 1);
    screen.put(0, 0, "abc", {});
    screen.flush();

    screen.clear();
    const out = screen.flush();
    expect(out).not.toContain("a");
    expect(out).not.toContain("b");
    expect(out).not.toContain("c");
  });
});
