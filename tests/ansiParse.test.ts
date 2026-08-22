// tests/ansiParse.test.ts — term/ansiParse.ts's SGR-to-styled-segments
// parser. Pure and independent of any subprocess (see tests/preview.test.ts
// for the fsapi layer that actually invokes bat/cat).

import { describe, expect, it } from "bun:test";
import { parseAnsiLines } from "../src/term/ansiParse.ts";

describe("parseAnsiLines: plain text", () => {
  it("splits on newlines into one segment array per line", () => {
    const lines = parseAnsiLines("a\nb\nc");
    expect(lines.length).toBe(3);
    expect(lines[0]).toEqual([{ text: "a", style: {} }]);
    expect(lines[1]).toEqual([{ text: "b", style: {} }]);
    expect(lines[2]).toEqual([{ text: "c", style: {} }]);
  });

  it("an empty line parses to an empty segment array", () => {
    const lines = parseAnsiLines("a\n\nc");
    expect(lines[1]).toEqual([]);
  });

  it("drops carriage returns", () => {
    const lines = parseAnsiLines("a\r\nb\r\n");
    expect(lines[0]).toEqual([{ text: "a", style: {} }]);
    expect(lines[1]).toEqual([{ text: "b", style: {} }]);
  });

  it("strips other C0 control bytes", () => {
    const lines = parseAnsiLines("a\x07b\x00c");
    expect(lines[0]).toEqual([{ text: "abc", style: {} }]);
  });

  it("expands tabs to the next 4-column stop", () => {
    const lines = parseAnsiLines("a\tb");
    expect(lines[0]).toEqual([{ text: "a   b", style: {} }]);
    const lines2 = parseAnsiLines("ab\tc");
    expect(lines2[0]).toEqual([{ text: "ab  c", style: {} }]);
  });
});

describe("parseAnsiLines: SGR", () => {
  it("applies a truecolor foreground (38;2;r;g;b)", () => {
    const lines = parseAnsiLines("\x1b[38;2;255;0;0mred\x1b[0m");
    expect(lines[0]).toEqual([{ text: "red", style: { fg: 0xff0000 } }]);
  });

  it("applies a truecolor background (48;2;r;g;b)", () => {
    const lines = parseAnsiLines("\x1b[48;2;0;255;0mgreen bg\x1b[0m");
    expect(lines[0]).toEqual([{ text: "green bg", style: { bg: 0x00ff00 } }]);
  });

  it("applies a basic 16-color foreground (30-37, 90-97)", () => {
    expect(parseAnsiLines("\x1b[31mred\x1b[0m")[0]).toEqual([
      { text: "red", style: { fg: 0x800000 } },
    ]);
    expect(parseAnsiLines("\x1b[91mbright red\x1b[0m")[0]).toEqual([
      { text: "bright red", style: { fg: 0xff0000 } },
    ]);
  });

  it("applies a 256-color palette index (38;5;N)", () => {
    // Index 196 is deep in the 6x6x6 cube: pure red.
    const lines = parseAnsiLines("\x1b[38;5;196mred\x1b[0m");
    expect(lines[0]).toEqual([{ text: "red", style: { fg: 0xff0000 } }]);
  });

  it("maps bold/dim/italic/reverse to the packed attr bitmask", () => {
    const ATTR_BOLD = 1 << 0;
    const ATTR_ITALIC = 1 << 2;
    const lines = parseAnsiLines("\x1b[1;3mboth\x1b[0m");
    expect(lines[0]).toEqual([
      { text: "both", style: { attr: ATTR_BOLD | ATTR_ITALIC } },
    ]);
  });

  it("splits a line into multiple segments at each style change", () => {
    const lines = parseAnsiLines(
      "\x1b[31mred\x1b[0m plain \x1b[32mgreen\x1b[0m",
    );
    expect(lines[0]).toEqual([
      { text: "red", style: { fg: 0x800000 } },
      { text: " plain ", style: {} },
      { text: "green", style: { fg: 0x008000 } },
    ]);
  });

  it("SGR state persists across a line break until reset", () => {
    const lines = parseAnsiLines("\x1b[31mred\nstill red\x1b[0m");
    expect(lines[0]).toEqual([{ text: "red", style: { fg: 0x800000 } }]);
    expect(lines[1]).toEqual([{ text: "still red", style: { fg: 0x800000 } }]);
  });

  it("39/49 reset only the foreground/background, not attrs", () => {
    const lines = parseAnsiLines("\x1b[1;31mbold red\x1b[39mstill bold\x1b[0m");
    const ATTR_BOLD = 1 << 0;
    expect(lines[0]).toEqual([
      { text: "bold red", style: { fg: 0x800000, attr: ATTR_BOLD } },
      { text: "still bold", style: { attr: ATTR_BOLD } },
    ]);
  });

  it("strips non-SGR CSI sequences without touching the running style", () => {
    const lines = parseAnsiLines("\x1b[31mred\x1b[Kmore red\x1b[0m");
    expect(lines[0]).toEqual([
      { text: "red", style: { fg: 0x800000 } },
      { text: "more red", style: { fg: 0x800000 } },
    ]);
  });

  it("strips OSC sequences entirely", () => {
    const lines = parseAnsiLines(
      "before\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\after",
    );
    expect(lines[0]).toEqual([{ text: "beforelinkafter", style: {} }]);
  });
});
