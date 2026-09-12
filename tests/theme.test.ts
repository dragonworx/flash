// tests/theme.test.ts — term/theme.ts's `filterMatchSpan`: the `/` quick
// filter's "where did this match" rule, tested as a pure function of
// (name, query) so a regression shows up without rendering anything.

import { afterEach, describe, expect, it } from "bun:test";
import {
  colors,
  filterMatchSpan,
  setDetectedBackground,
} from "../src/term/theme.ts";

describe("filterMatchSpan", () => {
  it("finds a whole-word match at the start", () => {
    expect(filterMatchSpan("report.pdf", "report")).toEqual({
      start: 0,
      end: 6,
    });
  });

  it("finds a partial match in the middle", () => {
    expect(filterMatchSpan("my-report-final.pdf", "report")).toEqual({
      start: 3,
      end: 9,
    });
  });

  it("is case-insensitive", () => {
    expect(filterMatchSpan("REPORT.pdf", "report")).toEqual({
      start: 0,
      end: 6,
    });
    expect(filterMatchSpan("report.pdf", "REPORT")).toEqual({
      start: 0,
      end: 6,
    });
  });

  it("returns null when there's no match", () => {
    expect(filterMatchSpan("image.png", "report")).toBeNull();
  });

  it("returns null for an empty, null, or undefined query", () => {
    expect(filterMatchSpan("anything", "")).toBeNull();
    expect(filterMatchSpan("anything", null)).toBeNull();
    expect(filterMatchSpan("anything", undefined)).toBeNull();
  });

  it("matches the first occurrence when the query repeats", () => {
    expect(filterMatchSpan("aabaa", "a")).toEqual({ start: 0, end: 1 });
  });
});

describe("setDetectedBackground", () => {
  const defaultCursorBg = colors.cursorBg;
  const defaultFooterBg = colors.footerBg;

  afterEach(() => {
    colors.cursorBg = defaultCursorBg;
    colors.footerBg = defaultFooterBg;
  });

  it("leaves the dark-terminal defaults untouched when no reply arrived", () => {
    setDetectedBackground(null);
    expect(colors.cursorBg).toBe(defaultCursorBg);
    expect(colors.footerBg).toBe(defaultFooterBg);
  });

  it("derives darker cursor/footer shades for a light background", () => {
    setDetectedBackground(0xffffff);
    expect(colors.cursorBg).toBeLessThan(0xffffff);
    expect(colors.footerBg).toBeLessThan(0xffffff);
    // cursorBg blends more toward black than footerBg, so it reads darker —
    // same relationship as the dark-terminal literals it replaces.
    expect(colors.cursorBg).toBeLessThan(colors.footerBg);
  });

  it("derives lighter cursor/footer shades for a dark background", () => {
    setDetectedBackground(0x000000);
    expect(colors.cursorBg).toBeGreaterThan(0);
    expect(colors.footerBg).toBeGreaterThan(0);
    // cursorBg blends more toward white than footerBg, so it reads lighter.
    expect(colors.cursorBg).toBeGreaterThan(colors.footerBg);
  });
});
