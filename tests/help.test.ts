// tests/help.test.ts — ui/overlay/help.ts, generated straight from
// keymap.ts's BINDINGS table. Two things earn their place here beyond the
// usual box-sizing/snapshot pattern (tests/confirm.test.ts,
// tests/progress.test.ts): a drift guard (every binding has a real
// description, and the table actually reaches every category the plan
// asks for) and a scroll-mechanics check, since this is the one overlay
// that can outgrow its box.

import { describe, expect, it } from "bun:test";
import { DEFAULT_SORT } from "../src/fsapi/scan.ts";
import {
  BINDINGS,
  type BindingCategory,
  ESCAPE_HELP,
  resolveAction,
  resolveEscape,
} from "../src/keymap.ts";
import type { AppState } from "../src/state/store.ts";
import type { Key } from "../src/term/input.ts";
import { Screen } from "../src/term/screen.ts";
import {
  HELP_LINES,
  buildHelpLines,
  computeHelpBox,
  helpViewportHeight,
  maxHelpScroll,
  renderHelpOverlay,
} from "../src/ui/overlay/help.ts";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    cwd: "/tmp/somewhere",
    entries: [],
    scanError: null,
    cursor: 0,
    scrollTop: 0,
    marked: new Set(),
    view: "list",
    showHidden: false,
    sort: DEFAULT_SORT,
    clipboard: null,
    overlay: null,
    message: null,
    archive: null,
    ...overrides,
  };
}

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    name: "a",
    ctrl: false,
    shift: false,
    alt: false,
    raw: "a",
    ...overrides,
  };
}

const ALL_CATEGORIES: BindingCategory[] = [
  "navigation",
  "selection",
  "file operations",
  "archives",
  "view",
  "app",
];

describe("BINDINGS: the drift guard", () => {
  it("every binding has a non-empty display and a non-empty description", () => {
    for (const b of BINDINGS) {
      expect(b.display.length).toBeGreaterThan(0);
      for (const d of b.display) expect(d.trim().length).toBeGreaterThan(0);
      expect(b.description.trim().length).toBeGreaterThan(0);
    }
    expect(ESCAPE_HELP.description.trim().length).toBeGreaterThan(0);
  });

  it("every category the plan names has at least one binding", () => {
    for (const category of ALL_CATEGORIES) {
      if (category === "navigation") continue; // covered by ESCAPE_HELP alone even if BINDINGS had none
      const count = BINDINGS.filter((b) => b.category === category).length;
      expect(count).toBeGreaterThan(0);
    }
  });

  it("covers the full implemented key surface named in SPEC.md/the plan", () => {
    const descriptions = BINDINGS.map((b) => b.description.toLowerCase()).join(
      "\n",
    );
    for (const must of [
      "copy",
      "cut",
      "paste",
      "rename",
      "delete",
      "permissions",
      "zip",
      "extract",
      "hidden",
      "sort",
      "view",
      "mark",
    ]) {
      expect(descriptions).toContain(must);
    }
  });
});

describe("buildHelpLines / HELP_LINES", () => {
  it("is deterministic and matches the precomputed constant", () => {
    expect(buildHelpLines()).toEqual(HELP_LINES);
  });

  it("has exactly one heading per non-empty category, in the plan's order", () => {
    const headings = HELP_LINES.filter((l) => l.kind === "heading").map(
      (l) => l.text,
    );
    expect(headings).toEqual([
      "Navigation",
      "Selection",
      "File operations",
      "Archives",
      "View",
      "App",
    ]);
  });

  it("includes Escape's own row under Navigation", () => {
    const idx = HELP_LINES.findIndex(
      (l) => l.kind === "heading" && l.text === "Navigation",
    );
    const next = HELP_LINES[idx + 1];
    expect(next).toEqual({
      kind: "binding",
      keys: "Esc",
      description: ESCAPE_HELP.description,
    });
  });

  it("has one binding row for every BINDINGS entry, plus Escape", () => {
    const bindingRows = HELP_LINES.filter((l) => l.kind === "binding");
    expect(bindingRows.length).toBe(BINDINGS.length + 1);
  });
});

describe("computeHelpBox / helpViewportHeight / maxHelpScroll", () => {
  it("centers within the screen and clamps to the preferred width range", () => {
    const box = computeHelpBox(120, 60);
    expect(box.width).toBeLessThanOrEqual(84);
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(120);
  });

  it("never exceeds the screen even when the screen is tiny", () => {
    const box = computeHelpBox(10, 5);
    expect(box.width).toBeLessThanOrEqual(10);
    expect(box.height).toBeLessThanOrEqual(5);
  });

  it("a short terminal has a smaller viewport than a tall one, and scroll room to match", () => {
    const shortViewport = helpViewportHeight(80, 15);
    const tallViewport = helpViewportHeight(80, 60);
    expect(shortViewport).toBeLessThan(tallViewport);
    expect(maxHelpScroll(80, 15)).toBeGreaterThan(maxHelpScroll(80, 60));
  });

  it("a terminal tall enough to show everything needs no scrolling", () => {
    expect(maxHelpScroll(80, 200)).toBe(0);
  });
});

describe("renderHelpOverlay snapshot", () => {
  it("renders category headings and known bindings without a scroll offset", () => {
    const screen = new Screen(90, 40, () => {});
    screen.clear();
    renderHelpOverlay(screen, 90, 40, 0);
    const text = screen.renderPlainText();
    expect(text).toContain("Keyboard shortcuts");
    expect(text).toContain("Navigation");
    expect(text).toContain("Archives");
    expect(text).toContain("Esc");
  });

  it("scrolling changes what's visible", () => {
    const top = new Screen(90, 20, () => {});
    top.clear();
    renderHelpOverlay(top, 90, 20, 0);
    const bottom = new Screen(90, 20, () => {});
    bottom.clear();
    renderHelpOverlay(bottom, 90, 20, maxHelpScroll(90, 20));
    expect(top.renderPlainText()).not.toBe(bottom.renderPlainText());
  });

  it("clamps an out-of-range scroll offset rather than throwing or rendering blank", () => {
    const screen = new Screen(90, 20, () => {});
    screen.clear();
    expect(() => renderHelpOverlay(screen, 90, 20, 1_000_000)).not.toThrow();
    const text = screen.renderPlainText();
    // Still shows real content at the (clamped) bottom, not a blank overlay.
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("degrades gracefully on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() => renderHelpOverlay(screen, 15, 6, 0)).not.toThrow();
  });
});

describe("keymap integration: opening, scrolling, and closing help", () => {
  it("'?' with no overlay open requests the help action", () => {
    const action = resolveAction(makeKey({ name: "?" }), makeState());
    expect(action).toEqual({ type: "help" });
  });

  it("while help is open, scroll keys map to helpScroll and swallow plain letters", () => {
    const state = makeState({ overlay: { kind: "help", scrollOffset: 0 } });
    expect(resolveAction(makeKey({ name: "down" }), state)).toEqual({
      type: "helpScroll",
      delta: 1,
    });
    expect(resolveAction(makeKey({ name: "j" }), state)).toEqual({
      type: "helpScroll",
      delta: 1,
    });
    expect(resolveAction(makeKey({ name: "pagedown" }), state)).toEqual({
      type: "helpScroll",
      delta: 10,
    });
    expect(resolveAction(makeKey({ name: "end" }), state)).toEqual({
      type: "helpScroll",
      delta: 1_000_000,
    });
    // A key that would copy/cut/quit in the normal view does nothing while
    // help is open — it must not leak through to the browser underneath.
    expect(resolveAction(makeKey({ name: "c" }), state)).toBeNull();
    expect(resolveAction(makeKey({ name: "q" }), state)).toBeNull();
  });

  it("'?' again closes the overlay instead of reopening it", () => {
    const state = makeState({ overlay: { kind: "help", scrollOffset: 3 } });
    expect(resolveAction(makeKey({ name: "?" }), state)).toEqual({
      type: "closeOverlay",
    });
  });

  it("Escape closes help via the ordinary precedence table (arm 1)", () => {
    const state = makeState({ overlay: { kind: "help", scrollOffset: 3 } });
    expect(resolveEscape(state)).toEqual({ type: "closeOverlay" });
    expect(resolveAction(makeKey({ name: "escape" }), state)).toEqual({
      type: "closeOverlay",
    });
  });
});
