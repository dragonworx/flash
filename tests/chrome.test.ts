// tests/chrome.test.ts — breadcrumb collapsing and status-bar text, tested
// as pure string functions (no Screen needed — see ui/chrome.ts).

import { describe, expect, it } from "bun:test";
import { stringWidth } from "../src/term/width.ts";
import {
  formatBreadcrumb,
  formatItemCount,
  formatStatusLeft,
  pathSegments,
} from "../src/ui/chrome.ts";

describe("pathSegments", () => {
  it("splits an absolute path with a leading root segment", () => {
    expect(pathSegments("/home/dev/github/fs")).toEqual([
      "/",
      "home",
      "dev",
      "github",
      "fs",
    ]);
  });

  it("returns just the root for '/'", () => {
    expect(pathSegments("/")).toEqual(["/"]);
  });
});

describe("formatBreadcrumb", () => {
  it("shows the full path when it fits", () => {
    expect(formatBreadcrumb("/home/dev/fs", 80)).toBe("/ › home › dev › fs");
  });

  it("collapses the middle with … when it does not fit, keeping the tail", () => {
    const out = formatBreadcrumb("/home/dev/github/fs/src/term", 20);
    expect(out).toContain("…");
    expect(out.endsWith("term")).toBe(true);
    expect(out.startsWith("/")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(20);
  });

  it("never exceeds maxWidth even at extreme narrowness", () => {
    const cwd = "/home/dev/github/fs/src/term/width.ts";
    for (const w of [1, 3, 5, 8, 12, 20, 40]) {
      expect(stringWidth(formatBreadcrumb(cwd, w))).toBeLessThanOrEqual(w);
    }
  });

  it("returns an empty string for non-positive width", () => {
    expect(formatBreadcrumb("/a/b", 0)).toBe("");
  });
});

describe("formatItemCount", () => {
  it("pluralizes correctly", () => {
    expect(formatItemCount(0)).toBe("0 items");
    expect(formatItemCount(1)).toBe("1 item");
    expect(formatItemCount(2)).toBe("2 items");
  });
});

describe("formatStatusLeft (Phase 4: mark count + clipboard state)", () => {
  it("shows just the item count when nothing is marked or staged", () => {
    expect(formatStatusLeft({ itemCount: 12 })).toBe("12 items");
  });

  it("appends the mark count when something is marked", () => {
    expect(formatStatusLeft({ itemCount: 12, markedCount: 3 })).toBe(
      "12 items, 3 marked",
    );
  });

  it("appends the clipboard state after marks, e.g. '3 marked · 2 cut'", () => {
    expect(
      formatStatusLeft({
        itemCount: 12,
        markedCount: 3,
        clipboard: { mode: "cut", paths: ["/a", "/b"] },
      }),
    ).toBe("12 items, 3 marked · 2 cut");
  });

  it("shows the clipboard state even with nothing currently marked (cursor fallback)", () => {
    expect(
      formatStatusLeft({
        itemCount: 12,
        clipboard: { mode: "copy", paths: ["/a"] },
      }),
    ).toBe("12 items · 1 copied");
  });

  it("ignores an empty clipboard register", () => {
    expect(
      formatStatusLeft({
        itemCount: 12,
        clipboard: { mode: "cut", paths: [] },
      }),
    ).toBe("12 items");
    expect(formatStatusLeft({ itemCount: 12, clipboard: null })).toBe(
      "12 items",
    );
  });
});
