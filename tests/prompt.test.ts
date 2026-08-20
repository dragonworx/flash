// tests/prompt.test.ts — ui/overlay/prompt.ts: the pure field-editing
// functions, validation, the horizontal-scroll math (including wide
// characters), and a --dump-frame-style snapshot of the rendered overlay —
// same pattern as tests/progress.test.ts (construct a Screen, draw into it,
// call renderPlainText()) since main.ts's real --dump-frame has no hook to
// inject an open prompt.

import { describe, expect, it } from "bun:test";
import { Screen } from "../src/term/screen.ts";
import {
  backspace,
  clearToStart,
  computePromptBox,
  computePromptView,
  deleteForward,
  deleteWordBack,
  insertChar,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  renderPromptOverlay,
  validateName,
} from "../src/ui/overlay/prompt.ts";

describe("field editing", () => {
  it("insertChar inserts at the cursor and advances it", () => {
    let f = { value: "helo", cursor: 3 };
    f = insertChar(f, "l");
    expect(f).toEqual({ value: "hello", cursor: 4 });
  });

  it("insertChar at the start and end", () => {
    expect(insertChar({ value: "bc", cursor: 0 }, "a")).toEqual({
      value: "abc",
      cursor: 1,
    });
    expect(insertChar({ value: "ab", cursor: 2 }, "c")).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  it("backspace removes the grapheme before the cursor", () => {
    expect(backspace({ value: "hello", cursor: 5 })).toEqual({
      value: "hell",
      cursor: 4,
    });
    expect(backspace({ value: "hello", cursor: 1 })).toEqual({
      value: "ello",
      cursor: 0,
    });
  });

  it("backspace at cursor 0 is a no-op", () => {
    expect(backspace({ value: "hello", cursor: 0 })).toEqual({
      value: "hello",
      cursor: 0,
    });
  });

  it("deleteForward removes the grapheme at the cursor without moving it", () => {
    expect(deleteForward({ value: "hello", cursor: 0 })).toEqual({
      value: "ello",
      cursor: 0,
    });
  });

  it("deleteForward at the end is a no-op", () => {
    expect(deleteForward({ value: "hello", cursor: 5 })).toEqual({
      value: "hello",
      cursor: 5,
    });
  });

  it("moveLeft/moveRight clamp at the field's edges", () => {
    expect(moveLeft({ value: "abc", cursor: 0 })).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(moveRight({ value: "abc", cursor: 3 })).toEqual({
      value: "abc",
      cursor: 3,
    });
    expect(moveRight({ value: "abc", cursor: 1 }).cursor).toBe(2);
    expect(moveLeft({ value: "abc", cursor: 2 }).cursor).toBe(1);
  });

  it("moveHome and moveEnd jump to the field's edges", () => {
    expect(moveHome({ value: "abc", cursor: 2 })).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(moveEnd({ value: "abc", cursor: 1 })).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  it("deleteWordBack removes the run of non-space characters before the cursor", () => {
    expect(deleteWordBack({ value: "hello world", cursor: 11 })).toEqual({
      value: "hello ",
      cursor: 6,
    });
  });

  it("deleteWordBack skips trailing spaces first, then deletes the word", () => {
    expect(deleteWordBack({ value: "hello   ", cursor: 8 })).toEqual({
      value: "",
      cursor: 0,
    });
  });

  it("deleteWordBack from the middle of a word only deletes up to the cursor", () => {
    expect(deleteWordBack({ value: "hello world", cursor: 8 })).toEqual({
      value: "hello rld",
      cursor: 6,
    });
  });

  it("clearToStart deletes everything before the cursor and resets it to 0", () => {
    expect(clearToStart({ value: "hello world", cursor: 6 })).toEqual({
      value: "world",
      cursor: 0,
    });
  });

  it("clearToStart at cursor 0 is a no-op", () => {
    expect(clearToStart({ value: "hello", cursor: 0 })).toEqual({
      value: "hello",
      cursor: 0,
    });
  });
});

describe("field editing — wide characters (CJK/emoji)", () => {
  it("insertChar and backspace treat a CJK character as one grapheme", () => {
    let f = { value: "", cursor: 0 };
    f = insertChar(f, "日");
    f = insertChar(f, "本");
    f = insertChar(f, "語");
    expect(f).toEqual({ value: "日本語", cursor: 3 });
    f = backspace(f);
    expect(f).toEqual({ value: "日本", cursor: 2 });
  });

  it("backspace removes a whole emoji grapheme cluster, not a surrogate half", () => {
    // A family emoji is several codepoints joined by ZWJ — one grapheme.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 👨‍👩‍👧
    const f = backspace({ value: `a${family}`, cursor: 2 });
    expect(f).toEqual({ value: "a", cursor: 1 });
  });
});

describe("validateName", () => {
  const existing = new Set(["a.txt", "build"]);

  it("rejects an empty name", () => {
    expect(validateName("", existing)).not.toBeNull();
  });

  it("rejects '.' and '..'", () => {
    expect(validateName(".", existing)).not.toBeNull();
    expect(validateName("..", existing)).not.toBeNull();
  });

  it("rejects anything containing '/'", () => {
    expect(validateName("a/b", existing)).not.toBeNull();
  });

  it("rejects a name already in the listing", () => {
    expect(validateName("build", existing)).toContain("already exists");
  });

  it("accepts a name that doesn't collide", () => {
    expect(validateName("new-name.txt", existing)).toBeNull();
  });

  it("accepts the unchanged name in rename mode via ignoreName", () => {
    expect(validateName("build", existing, "build")).toBeNull();
  });

  it("still rejects a different existing name even with ignoreName set", () => {
    expect(validateName("a.txt", existing, "build")).toContain(
      "already exists",
    );
  });
});

describe("computePromptView — horizontal scroll", () => {
  it("shows the whole value with no scroll when it fits", () => {
    const view = computePromptView("hello", 5, 20);
    expect(view).toEqual({ text: "hello", cursorCol: 5 });
  });

  it("scrolls right to keep the cursor visible when typing past the field width", () => {
    const long = "abcdefghijklmnopqrst"; // 20 chars
    const view = computePromptView(long, 20, 10);
    expect(view.text.length).toBeLessThanOrEqual(10);
    expect(view.cursorCol).toBeLessThan(10);
    expect(view.cursorCol).toBeGreaterThanOrEqual(0);
    // The visible slice should be a suffix of the value ending at the cursor.
    expect(long.endsWith(view.text)).toBe(true);
  });

  it("does not scroll when the cursor is near the start, even if the tail overflows", () => {
    const long = "abcdefghijklmnopqrst";
    const view = computePromptView(long, 2, 10);
    expect(view.text.startsWith("ab")).toBe(true);
    expect(view.cursorCol).toBe(2);
  });

  it("never splits a wide grapheme at the field edge", () => {
    // Five 2-column CJK chars = 10 columns; field width 7 forces a split
    // point that must land on a grapheme boundary.
    const value = "一二三四五";
    const view = computePromptView(value, 5, 7);
    for (const ch of view.text) {
      expect(value.includes(ch)).toBe(true);
    }
    // Every character in the slice must be a complete character from the
    // original string (no partial surrogate/half-glyph).
    expect([...view.text].every((ch) => value.includes(ch))).toBe(true);
  });

  it("returns empty for a non-positive field width", () => {
    expect(computePromptView("hello", 2, 0)).toEqual({
      text: "",
      cursorCol: 0,
    });
  });
});

describe("computePromptBox", () => {
  it("centers within the screen and clamps to the preferred width range", () => {
    const box = computePromptBox(100, 40);
    expect(box.width).toBeLessThanOrEqual(64);
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(100);
  });

  it("never exceeds the screen even when the screen is tiny", () => {
    const box = computePromptBox(10, 5);
    expect(box.width).toBeLessThanOrEqual(10);
    expect(box.height).toBeLessThanOrEqual(5);
  });
});

describe("renderPromptOverlay snapshot", () => {
  it("renders the rename prompt at 80x24 with the value and footer visible", () => {
    const screen = new Screen(80, 24, () => {});
    screen.clear();
    renderPromptOverlay(screen, 80, 24, {
      title: "Rename",
      value: "report.txt",
      cursor: 10,
      error: null,
    });
    const lines = screen.renderPlainText().split("\n");
    const text = lines.join("\n");
    expect(text).toContain("Rename");
    expect(text).toContain("report.txt");
    expect(text).toContain("Enter to confirm");
    expect(text).toContain("Esc to cancel");
  });

  it("renders an inline validation error", () => {
    const screen = new Screen(80, 24, () => {});
    screen.clear();
    renderPromptOverlay(screen, 80, 24, {
      title: "New directory",
      value: "build",
      cursor: 5,
      error: "'build' already exists",
    });
    expect(screen.renderPlainText()).toContain("already exists");
  });

  it("degrades gracefully rather than throwing on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() =>
      renderPromptOverlay(screen, 15, 6, {
        title: "Rename",
        value: "x",
        cursor: 1,
        error: null,
      }),
    ).not.toThrow();
  });
});
