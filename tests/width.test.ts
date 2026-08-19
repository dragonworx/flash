// tests/width.test.ts — grapheme-aware stringWidth, truncate, and pad.

import { describe, expect, it } from "bun:test";
import { pad, stringWidth, truncate } from "../src/term/width.ts";

describe("stringWidth", () => {
  it("counts ASCII as one column per character", () => {
    expect(stringWidth("abc")).toBe(3);
  });

  it("counts CJK as two columns per character", () => {
    expect(stringWidth("世界")).toBe(4);
  });

  it("counts a ZWJ emoji family as one two-column cluster", () => {
    expect(stringWidth("👨‍👩‍👧")).toBe(2);
  });

  it("counts a decomposed combining accent as one column", () => {
    const decomposed = "é"; // "e" + combining acute accent
    expect(stringWidth(decomposed)).toBe(1);
  });

  it("returns 0 for an empty string", () => {
    expect(stringWidth("")).toBe(0);
  });
});

describe("truncate", () => {
  it("returns the input unchanged when it already fits", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("cuts plain text and appends the ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("keeps a ZWJ emoji cluster intact when it fits, or drops it entirely otherwise", () => {
    const s = "ab👨‍👩‍👧cd"; // widths: a1 b1 family2 c1 d1 = 6 total
    expect(truncate(s, 5)).toBe("ab👨‍👩‍👧…");
    expect(truncate(s, 4)).toBe("ab…");
  });

  it("never overflows maxWidth even when the last kept grapheme is 2 columns wide", () => {
    const s = "世界hi";
    for (let w = 0; w <= 8; w++) {
      const out = truncate(s, w);
      expect(stringWidth(out)).toBeLessThanOrEqual(w);
    }
  });

  it("returns an empty string for non-positive width", () => {
    expect(truncate("hello", 0)).toBe("");
    expect(truncate("hello", -5)).toBe("");
  });

  it("falls back to no ellipsis when there is no room for one", () => {
    const out = truncate("hello", 1);
    expect(stringWidth(out)).toBeLessThanOrEqual(1);
  });
});

describe("pad", () => {
  it("pads left-aligned text with trailing spaces", () => {
    expect(pad("hi", 5)).toBe("hi   ");
  });

  it("pads right-aligned text with leading spaces", () => {
    expect(pad("hi", 5, "right")).toBe("   hi");
  });

  it("pads center-aligned text", () => {
    expect(pad("hi", 6, "center")).toBe("  hi  ");
  });

  it("truncates instead of overflowing when text is too wide", () => {
    const out = pad("世界世界", 5);
    expect(stringWidth(out)).toBe(5);
  });

  it("returns an empty string for non-positive width", () => {
    expect(pad("hi", 0)).toBe("");
  });
});
