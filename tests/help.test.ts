// tests/help.test.ts — ui/overlay/help.ts, generated straight from
// keymap.ts's BINDINGS table. Two things earn their place here beyond the
// usual box-sizing/snapshot pattern (tests/confirm.test.ts,
// tests/progress.test.ts): a drift guard (every binding has a real
// description, and the table actually reaches every category the plan
// asks for) and a tab/scroll-mechanics check, since this is the one
// overlay with tabs and content that can outgrow its box.

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
  HELP_TABS,
  buildHelpTabs,
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
    filter: null,
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

describe("buildHelpTabs / HELP_TABS", () => {
  it("is deterministic and matches the precomputed constant", () => {
    expect(buildHelpTabs()).toEqual(HELP_TABS);
  });

  it("has exactly one tab per non-empty category, in the plan's order", () => {
    expect(HELP_TABS.map((t) => t.title)).toEqual([
      "Navigation",
      "Selection",
      "File operations",
      "Archives",
      "View",
      "App",
    ]);
  });

  it("includes Escape's own row in the Navigation tab", () => {
    const nav = HELP_TABS.find((t) => t.category === "navigation");
    expect(nav?.lines[0]).toEqual({
      keys: "Esc",
      description: ESCAPE_HELP.description,
    });
  });

  it("has one line for every BINDINGS entry in its category, plus Escape under Navigation", () => {
    const totalLines = HELP_TABS.reduce((n, t) => n + t.lines.length, 0);
    expect(totalLines).toBe(BINDINGS.length + 1);
  });
});

describe("computeHelpBox / helpViewportHeight / maxHelpScroll", () => {
  it("centers within the screen and clamps to the preferred width range, wide enough for every tab", () => {
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
    const lineCount = HELP_TABS[0]?.lines.length ?? 0;
    const shortViewport = helpViewportHeight(80, 15);
    const tallViewport = helpViewportHeight(80, 60);
    expect(shortViewport).toBeLessThan(tallViewport);
    expect(maxHelpScroll(80, 15, lineCount)).toBeGreaterThan(
      maxHelpScroll(80, 60, lineCount),
    );
  });

  it("a terminal tall enough to show everything needs no scrolling", () => {
    const lineCount = HELP_TABS[0]?.lines.length ?? 0;
    expect(maxHelpScroll(80, 200, lineCount)).toBe(0);
  });

  it("box height is sized to the tallest tab, not just the active one", () => {
    const maxTabLines = HELP_TABS.reduce(
      (max, t) => Math.max(max, t.lines.length),
      0,
    );
    const box = computeHelpBox(120, 200);
    // border, title, tab bar, rule, blank, footer, border == 7 chrome rows.
    expect(box.height).toBe(maxTabLines + 7);
  });
});

describe("renderHelpOverlay snapshot", () => {
  it("renders the tab bar and the active tab's bindings without a scroll offset", () => {
    const navIndex = HELP_TABS.findIndex((t) => t.category === "navigation");
    const screen = new Screen(90, 40, () => {});
    screen.clear();
    renderHelpOverlay(screen, 90, 40, 0, navIndex);
    const text = screen.renderPlainText();
    expect(text).toContain("Flash Help");
    expect(text).toContain("[Navigation]");
    expect(text).toContain("Selection");
    expect(text).toContain("Esc");
  });

  it("switching tabs changes what's visible", () => {
    const navIndex = HELP_TABS.findIndex((t) => t.category === "navigation");
    const archivesIndex = HELP_TABS.findIndex((t) => t.category === "archives");
    const nav = new Screen(90, 40, () => {});
    nav.clear();
    renderHelpOverlay(nav, 90, 40, 0, navIndex);
    const archives = new Screen(90, 40, () => {});
    archives.clear();
    renderHelpOverlay(archives, 90, 40, 0, archivesIndex);
    expect(nav.renderPlainText()).not.toBe(archives.renderPlainText());
    expect(archives.renderPlainText()).toContain("[Archives]");
  });

  it("scrolling changes what's visible within a tab", () => {
    const navIndex = HELP_TABS.findIndex((t) => t.category === "navigation");
    const lineCount = HELP_TABS[navIndex]?.lines.length ?? 0;
    const top = new Screen(90, 20, () => {});
    top.clear();
    renderHelpOverlay(top, 90, 20, 0, navIndex);
    const bottom = new Screen(90, 20, () => {});
    bottom.clear();
    renderHelpOverlay(
      bottom,
      90,
      20,
      maxHelpScroll(90, 20, lineCount),
      navIndex,
    );
    expect(top.renderPlainText()).not.toBe(bottom.renderPlainText());
  });

  it("clamps an out-of-range scroll offset rather than throwing or rendering blank", () => {
    const screen = new Screen(90, 20, () => {});
    screen.clear();
    expect(() => renderHelpOverlay(screen, 90, 20, 1_000_000, 0)).not.toThrow();
    const text = screen.renderPlainText();
    // Still shows real content at the (clamped) bottom, not a blank overlay.
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("clamps an out-of-range tab index rather than throwing", () => {
    const screen = new Screen(90, 20, () => {});
    screen.clear();
    expect(() => renderHelpOverlay(screen, 90, 20, 0, 999)).not.toThrow();
    const text = screen.renderPlainText();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("degrades gracefully on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() => renderHelpOverlay(screen, 15, 6, 0, 0)).not.toThrow();
  });
});

describe("keymap integration: opening, scrolling, switching tabs, and closing help", () => {
  it("'?' with no overlay open requests the help action", () => {
    const action = resolveAction(makeKey({ name: "?" }), makeState());
    expect(action).toEqual({ type: "help" });
  });

  it("while help is open, scroll keys map to helpScroll and swallow plain letters", () => {
    const state = makeState({
      overlay: { kind: "help", scrollOffset: 0, tab: 0 },
    });
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

  it("while help is open, ←/→ map to helpTab", () => {
    const state = makeState({
      overlay: { kind: "help", scrollOffset: 0, tab: 0 },
    });
    expect(resolveAction(makeKey({ name: "left" }), state)).toEqual({
      type: "helpTab",
      delta: -1,
    });
    expect(resolveAction(makeKey({ name: "right" }), state)).toEqual({
      type: "helpTab",
      delta: 1,
    });
  });

  it("'?' again closes the overlay instead of reopening it", () => {
    const state = makeState({
      overlay: { kind: "help", scrollOffset: 3, tab: 0 },
    });
    expect(resolveAction(makeKey({ name: "?" }), state)).toEqual({
      type: "closeOverlay",
    });
  });

  it("Escape closes help via the ordinary precedence table (arm 1)", () => {
    const state = makeState({
      overlay: { kind: "help", scrollOffset: 3, tab: 0 },
    });
    expect(resolveEscape(state)).toEqual({ type: "closeOverlay" });
    expect(resolveAction(makeKey({ name: "escape" }), state)).toEqual({
      type: "closeOverlay",
    });
  });
});
