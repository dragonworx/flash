// tests/ansi.test.ts — escape-sequence builders and the setEnabled kill switch.

import { afterEach, describe, expect, it } from "bun:test";
import * as ansi from "../src/term/ansi.ts";

afterEach(() => {
  ansi.setEnabled(true);
});

describe("setEnabled kill switch", () => {
  it("wraps text in SGR codes when enabled", () => {
    expect(ansi.bold("hi")).toBe("\x1b[1mhi\x1b[0m");
    expect(ansi.fg(255, 0, 0)("hi")).toBe("\x1b[38;2;255;0;0mhi\x1b[0m");
  });

  it("returns input unchanged when disabled", () => {
    ansi.setEnabled(false);
    expect(ansi.bold("hi")).toBe("hi");
    expect(ansi.dim("hi")).toBe("hi");
    expect(ansi.italic("hi")).toBe("hi");
    expect(ansi.reverse("hi")).toBe("hi");
    expect(ansi.fg(1, 2, 3)("hi")).toBe("hi");
    expect(ansi.bg(1, 2, 3)("hi")).toBe("hi");
  });

  it("isEnabled reflects the current toggle", () => {
    expect(ansi.isEnabled()).toBe(true);
    ansi.setEnabled(false);
    expect(ansi.isEnabled()).toBe(false);
  });

  it("style wrappers are unaffected by empty strings either way", () => {
    ansi.setEnabled(false);
    expect(ansi.bold("")).toBe("");
    ansi.setEnabled(true);
    expect(ansi.bold("")).toBe("\x1b[1m\x1b[0m");
  });
});

describe("cursor and screen-mode builders", () => {
  it("builds a 1-indexed cursor move sequence", () => {
    expect(ansi.moveTo(3, 5)).toBe("\x1b[3;5H");
  });

  it("builds hide/show cursor sequences", () => {
    expect(ansi.hideCursor()).toBe("\x1b[?25l");
    expect(ansi.showCursor()).toBe("\x1b[?25h");
  });

  it("builds alt-screen enter/exit sequences", () => {
    expect(ansi.enterAltScreen()).toBe("\x1b[?1049h");
    expect(ansi.exitAltScreen()).toBe("\x1b[?1049l");
  });

  it("builds synchronized-output begin/end sequences", () => {
    expect(ansi.beginSyncOutput()).toBe("\x1b[?2026h");
    expect(ansi.endSyncOutput()).toBe("\x1b[?2026l");
  });

  it("builds focus-reporting on/off sequences", () => {
    expect(ansi.enableFocusReporting()).toBe("\x1b[?1004h");
    expect(ansi.disableFocusReporting()).toBe("\x1b[?1004l");
  });

  it("builds erase sequences", () => {
    expect(ansi.eraseScreen()).toBe("\x1b[2J");
    expect(ansi.eraseLine()).toBe("\x1b[2K");
  });

  it("these builders are unaffected by setEnabled", () => {
    ansi.setEnabled(false);
    expect(ansi.enterAltScreen()).toBe("\x1b[?1049h");
    expect(ansi.hideCursor()).toBe("\x1b[?25l");
  });
});

describe("SGR reset", () => {
  it("returns the raw reset sequence regardless of enabled state", () => {
    expect(ansi.reset()).toBe("\x1b[0m");
    ansi.setEnabled(false);
    expect(ansi.reset()).toBe("\x1b[0m");
  });
});
