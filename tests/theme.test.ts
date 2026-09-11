// tests/theme.test.ts — term/theme.ts's `filterMatchSpan`: the `/` quick
// filter's "where did this match" rule, tested as a pure function of
// (name, query) so a regression shows up without rendering anything.

import { describe, expect, it } from "bun:test";
import { filterMatchSpan } from "../src/term/theme.ts";

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
