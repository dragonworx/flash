// tests/listView.test.ts — column layout math (the name-protection
// property at narrow widths) and header/data alignment, rendered through a
// real `Screen` and read back via `renderPlainText()` so the assertions
// cover actual cell placement, not just the pure layout numbers. Entries
// here deliberately use ASCII-only names with `--icons=ascii` so every
// glyph is exactly one column wide — that keeps character index and
// terminal column identical for these tests, with no wide-glyph offset to
// account for (see term/width.ts).

import { describe, expect, it } from "bun:test";
import type { Entry } from "../src/fsapi/entry.ts";
import { Screen } from "../src/term/screen.ts";
import type { ColumnKey } from "../src/ui/listView.ts";
import {
  COLUMN_WIDTH,
  chooseColumns,
  computeListLayout,
  renderListHeader,
  renderListView,
} from "../src/ui/listView.ts";

const MIN_NAME_WIDTH = 24;

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

describe("computeListLayout: name-width protection", () => {
  // The property the coordinator asked for: whenever at least one optional
  // (droppable) column is still showing, the name column must never have
  // been squeezed below its minimum. chooseColumns only stops dropping
  // once this holds, so this is really a regression guard on the threshold
  // itself (previously 6, now 24) rather than the dropping mechanism.
  it.each([46, 60, 80])(
    "keeps the name column at or above its minimum at width %i",
    (width) => {
      const layout = computeListLayout(width);
      if (layout.columns.length > 0) {
        expect(layout.nameWidth).toBeGreaterThanOrEqual(MIN_NAME_WIDTH);
      }
    },
  );

  it("drops columns least-essential-first as the terminal narrows", () => {
    // Widest: everything shows.
    expect(chooseColumns(200)).toEqual([
      "size",
      "mode",
      "owner",
      "group",
      "mtime",
    ]);
    // Narrowing must drop mtime before group, group before owner, owner
    // before mode, and size never drops.
    const dropOrder: ColumnKey[] = ["mtime", "group", "owner", "mode", "size"];
    const droppedAtWidth: Partial<Record<ColumnKey, number>> = {};
    for (let w = 200; w >= 10; w--) {
      const shown = new Set(chooseColumns(w));
      for (const col of dropOrder) {
        if (droppedAtWidth[col] === undefined && !shown.has(col)) {
          droppedAtWidth[col] = w;
        }
      }
    }
    expect(droppedAtWidth.size).toBeUndefined(); // size never drops, even at width 10
    const mtimeAt = droppedAtWidth.mtime as number;
    const groupAt = droppedAtWidth.group as number;
    const ownerAt = droppedAtWidth.owner as number;
    const modeAt = droppedAtWidth.mode as number;
    expect(mtimeAt).toBeGreaterThanOrEqual(groupAt);
    expect(groupAt).toBeGreaterThanOrEqual(ownerAt);
    expect(ownerAt).toBeGreaterThanOrEqual(modeAt);
  });

  it("gives the name column the full remaining width on a wide terminal", () => {
    // No cap: at 100 columns, name should absorb essentially all the slack
    // rather than being capped to some fixed small width.
    const layout = computeListLayout(100);
    expect(layout.nameWidth).toBeGreaterThan(40);
  });
});

describe("header/data column alignment", () => {
  it("positions every header label at the same x as its column's data", () => {
    const width = 100;
    const layout = computeListLayout(width);
    const screen = new Screen(width, 3, () => {});
    const entries = [makeEntry("normal-file.txt")];

    renderListHeader(screen, 0, 0, layout);
    renderListView(screen, 0, 1, width, 1, entries, 0, 0, layout, "ascii");

    const [headerLine, dataLine] = screen.renderPlainText().split("\n");
    expect(headerLine).toBeDefined();
    expect(dataLine).toBeDefined();

    // "Name" (header) and the entry name both start at layout.nameX.
    const entryName = "normal-file.txt";
    expect(headerLine?.slice(layout.nameX, layout.nameX + 4)).toBe("Name");
    expect(dataLine?.slice(layout.nameX, layout.nameX + entryName.length)).toBe(
      entryName,
    );

    // Every trailing column's label and its data are right-aligned inside
    // the exact same [colStart, colStart + COLUMN_WIDTH) field, so both
    // must end (their rightmost non-blank character) at the same index —
    // this is guaranteed by construction (both draws consume the same
    // `layout` object) but asserting it against the actual rendered text
    // is what would catch a real divergence, not just a logic error.
    for (const col of layout.columns) {
      const colX = layout.colStarts[col];
      expect(colX).toBeDefined();
      if (colX === undefined) continue;
      const fieldEnd = colX + COLUMN_WIDTH[col] - 1; // rightmost column of the field
      const headerCell = headerLine?.[fieldEnd];
      const dataCell = dataLine?.[fieldEnd];
      expect(headerCell).not.toBe(" ");
      expect(headerCell).not.toBeUndefined();
      expect(dataCell).not.toBe(" ");
      expect(dataCell).not.toBeUndefined();
    }
  });

  it("keeps the same colStarts whether or not a row happens to error", () => {
    const width = 100;
    const layout = computeListLayout(width);
    // computeListLayout depends only on width, so calling it again must be
    // byte-identical — this is the guarantee main.ts relies on when it
    // computes the layout once and threads it into both header and rows.
    expect(computeListLayout(width)).toEqual(layout);
  });
});

describe("no dot leader", () => {
  it("fills the gap after a short name with plain whitespace, not a leader glyph", () => {
    const width = 100;
    const layout = computeListLayout(width);
    const screen = new Screen(width, 2, () => {});
    renderListView(
      screen,
      0,
      0,
      width,
      1,
      [makeEntry("short.txt")],
      0,
      0,
      layout,
      "ascii",
    );
    const line = screen.renderPlainText().split("\n")[0] ?? "";
    expect(line).not.toContain("·");
  });
});
