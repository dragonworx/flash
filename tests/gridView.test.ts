// tests/gridView.test.ts — grid layout math and column-major cursor
// geometry, tested as pure functions over synthetic widths (see
// ui/gridView.ts's file header for why `computeGridLayout` takes
// `nameWidths: number[]` rather than `Entry[]`).

import { describe, expect, it } from "bun:test";
import type { Entry } from "../src/fsapi/entry.ts";
import { Screen } from "../src/term/screen.ts";
import {
  clampGridScroll,
  computeGridLayout,
  entryDisplayWidth,
  gridRowCount,
  moveGridCursor,
  renderGridView,
} from "../src/ui/gridView.ts";

function makeEntry(name: string, overrides: Partial<Entry> = {}): Entry {
  return {
    name,
    path: `/tmp/${name}`,
    kind: "file",
    size: 123,
    mode: 0o100644,
    uid: 1000,
    gid: 1000,
    mtimeMs: Date.now() - 60_000,
    width: name.length,
    ...overrides,
  };
}

describe("entryDisplayWidth", () => {
  it("adds the bookmark star's width for a bookmarked entry", () => {
    const entry = makeEntry("arena-engine", { width: 12 });
    expect(entryDisplayWidth(entry, new Set(["/tmp/arena-engine"]))).toBe(14);
  });

  it("leaves an entry's width alone when it isn't bookmarked", () => {
    const entry = makeEntry("arena-engine", { width: 12 });
    expect(entryDisplayWidth(entry, new Set())).toBe(12);
  });

  it("never stars the synthetic '..' row, even if its path is bookmarked", () => {
    const entry = makeEntry("..", { path: "/tmp/parent", width: 2 });
    expect(entryDisplayWidth(entry, new Set(["/tmp/parent"]))).toBe(2);
  });
});

describe("computeGridLayout", () => {
  it("returns nothing for an empty entry list or non-positive width", () => {
    expect(computeGridLayout(80, [])).toEqual({
      columns: 0,
      colWidth: 0,
      nameWidth: 0,
    });
    expect(computeGridLayout(0, [5])).toEqual({
      columns: 0,
      colWidth: 0,
      nameWidth: 0,
    });
  });

  it("fits multiple columns on a wide terminal with short names", () => {
    const widths = [5, 8, 3, 6, 7];
    const layout = computeGridLayout(100, widths);
    expect(layout.columns).toBeGreaterThan(1);
    expect(layout.columns * layout.colWidth).toBeLessThanOrEqual(100);
  });

  it("caps the name column so one very long name doesn't collapse everything", () => {
    const widths = [5, 6, 200]; // one absurdly long name
    const layout = computeGridLayout(200, widths);
    expect(layout.nameWidth).toBeLessThan(200);
    expect(layout.columns).toBeGreaterThan(1);
  });

  it("shrinks to fit a single column when the terminal is narrower than one cell", () => {
    const layout = computeGridLayout(10, [20]);
    expect(layout.columns).toBe(1);
    expect(layout.colWidth).toBeLessThanOrEqual(10);
    expect(layout.nameWidth).toBeGreaterThan(0);
  });

  it("handles a wide CJK/emoji name (display width, not code-unit length)", () => {
    // "日本語ファイル" is 7 characters but 14 display columns wide —
    // computeGridLayout must be driven by the pre-measured display width
    // (what scan.ts caches on Entry.width), never a raw string length.
    const cjkWidth = 14;
    const widths = [3, cjkWidth, 5];
    const layout = computeGridLayout(80, widths);
    // The column sizes exactly to the widest name (under the cap), so it
    // holds the CJK name in full with no truncation.
    expect(layout.nameWidth).toBe(cjkWidth);
    expect(layout.colWidth).toBeGreaterThan(cjkWidth);
    expect(layout.columns * layout.colWidth).toBeLessThanOrEqual(80);
  });
});

describe("gridRowCount", () => {
  it("computes column-major row count, rounding up", () => {
    expect(gridRowCount(10, 3)).toBe(4); // 4+4+2
    expect(gridRowCount(9, 3)).toBe(3);
    expect(gridRowCount(0, 3)).toBe(0);
  });

  it("returns 0 for non-positive columns", () => {
    expect(gridRowCount(10, 0)).toBe(0);
  });
});

describe("moveGridCursor", () => {
  // 10 entries, 3 columns -> rows = 4: col0 = [0,1,2,3], col1 = [4,5,6,7],
  // col2 (short, last column) = [8,9].
  const total = 10;
  const columns = 3;
  const rows = 4;

  it("moves down within the same column", () => {
    expect(moveGridCursor(0, total, columns, rows, "down")).toBe(1);
    expect(moveGridCursor(1, total, columns, rows, "down")).toBe(2);
  });

  it("moves up within the same column", () => {
    expect(moveGridCursor(2, total, columns, rows, "up")).toBe(1);
  });

  it("clamps at the top/bottom of a column rather than crossing into the next one", () => {
    // idx 3 is the bottom of column 0 — moving down must NOT land on idx 4
    // (top of column 1), which is what a naive +1 index delta would do.
    expect(moveGridCursor(3, total, columns, rows, "down")).toBe(3);
    expect(moveGridCursor(0, total, columns, rows, "up")).toBe(0);
  });

  it("clamps at the bottom of a short trailing column", () => {
    // Column 2 only has entries 8 and 9 (row 0 and row 1) — row 2/3 don't
    // exist there.
    expect(moveGridCursor(9, total, columns, rows, "down")).toBe(9);
  });

  it("moves right to the same row in the next column (a column's worth of entries)", () => {
    expect(moveGridCursor(0, total, columns, rows, "right")).toBe(4);
    expect(moveGridCursor(1, total, columns, rows, "right")).toBe(5);
  });

  it("moves left to the same row in the previous column", () => {
    expect(moveGridCursor(5, total, columns, rows, "left")).toBe(1);
  });

  it("clamps into a shorter target column rather than landing out of range", () => {
    // idx 7 = column 1, row 3. Column 2 (the last, short column) only goes
    // up to row 1 (entries 8, 9) — moving right must land on its last row,
    // not on a nonexistent idx 11.
    expect(moveGridCursor(7, total, columns, rows, "right")).toBe(9);
  });

  it("clamps at the left/right edges of the grid", () => {
    expect(moveGridCursor(0, total, columns, rows, "left")).toBe(0);
    expect(moveGridCursor(9, total, columns, rows, "right")).toBe(9);
  });

  it("returns 0 for an empty grid", () => {
    expect(moveGridCursor(0, 0, 0, 0, "down")).toBe(0);
  });
});

describe("clampGridScroll", () => {
  it("scrolls down to keep the cursor row visible", () => {
    expect(clampGridScroll(0, 10, 5, 20)).toBe(6);
  });

  it("scrolls up to keep the cursor row visible", () => {
    expect(clampGridScroll(10, 2, 5, 20)).toBe(2);
  });

  it("leaves the offset alone when the cursor is already visible", () => {
    expect(clampGridScroll(3, 5, 5, 20)).toBe(3);
  });

  it("never scrolls past the end of the content", () => {
    expect(clampGridScroll(0, 19, 5, 20)).toBe(15);
  });

  it("clamps to 0 for a non-positive viewport", () => {
    expect(clampGridScroll(5, 5, 0, 20)).toBe(0);
  });
});

// ── Phase 4: selection & clipboard status rendering ──
//
// The grid reuses the same marker-column convention as the list view (see
// ui/gridView.ts's file header): status glyph at screen column 1, right
// after the cursor marker at column 0. Plain-text assertions here
// (`renderPlainText()`) are exactly what `--dump-frame` without `--color`
// shows.

function firstLine(screen: Screen): string {
  return screen.renderPlainText().split("\n")[0] ?? "";
}

describe("renderGridView: selection & clipboard status", () => {
  it("shows '*' for a marked cell, in the column right after the cursor marker", () => {
    const entry = makeEntry("marked.txt");
    const screen = new Screen(40, 2, () => {});
    renderGridView(
      screen,
      0,
      0,
      40,
      1,
      [entry],
      -1,
      0,
      "ascii",
      new Set([entry.path]),
    );
    expect(firstLine(screen)[1]).toBe("*");
  });

  it("shows 'x' for a cut cell and '+' for a copied one", () => {
    const cutEntry = makeEntry("cut.txt");
    const cutScreen = new Screen(40, 2, () => {});
    renderGridView(
      cutScreen,
      0,
      0,
      40,
      1,
      [cutEntry],
      -1,
      0,
      "ascii",
      new Set(),
      { mode: "cut", paths: [cutEntry.path] },
    );
    expect(firstLine(cutScreen)[1]).toBe("x");

    const copiedEntry = makeEntry("copied.txt");
    const copyScreen = new Screen(40, 2, () => {});
    renderGridView(
      copyScreen,
      0,
      0,
      40,
      1,
      [copiedEntry],
      -1,
      0,
      "ascii",
      new Set(),
      { mode: "copy", paths: [copiedEntry.path] },
    );
    expect(firstLine(copyScreen)[1]).toBe("+");
  });

  it("shows both the cursor marker and the mark glyph on a marked cursor cell", () => {
    const entry = makeEntry("both.txt");
    const screen = new Screen(40, 2, () => {});
    renderGridView(
      screen,
      0,
      0,
      40,
      1,
      [entry],
      0, // cursor on this (the only) cell
      0,
      "ascii",
      new Set([entry.path]),
    );
    const line = firstLine(screen);
    expect(line[0]).toBe("›");
    expect(line[1]).toBe("*");
  });

  it("never shows a status glyph for the synthetic '..' cell", () => {
    const dotdot = makeEntry("..", { path: "/tmp/parent" });
    const screen = new Screen(40, 2, () => {});
    renderGridView(
      screen,
      0,
      0,
      40,
      1,
      [dotdot],
      -1,
      0,
      "ascii",
      new Set(["/tmp/parent"]),
    );
    expect(firstLine(screen)[1]).toBe(" ");
  });

  it("renders an unmarked, non-clipboard cell with a blank status column", () => {
    const entry = makeEntry("plain.txt");
    const screen = new Screen(40, 2, () => {});
    renderGridView(screen, 0, 0, 40, 1, [entry], -1, 0, "ascii");
    expect(firstLine(screen)[1]).toBe(" ");
  });
});
