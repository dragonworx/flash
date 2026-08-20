// tests/keymap.test.ts — src/keymap.ts: the key -> action table, focused on
// what Phase 4 added (Tab, Shift+↑/↓, Ctrl+A, c/x) and on Escape's
// precedence table, which is the one binding whose meaning depends on
// state. Everything here builds a plain `AppState` object directly rather
// than driving a real `Store` through `load()` — `resolveAction` only ever
// reads state, it never needs a live filesystem-backed store.

import { describe, expect, it } from "bun:test";
import { DEFAULT_SORT } from "../src/fsapi/scan.ts";
import { resolveAction, resolveEscape } from "../src/keymap.ts";
import type { AppState } from "../src/state/store.ts";
import type { Key } from "../src/term/input.ts";

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

describe("resolveAction: Phase 4 bindings", () => {
  it("Tab toggles the mark at the cursor", () => {
    const action = resolveAction(makeKey({ name: "tab" }), makeState());
    expect(action).toEqual({ type: "toggleMark" });
  });

  it("Shift+Up/Down extends the range selection, carrying the direction", () => {
    const up = resolveAction(makeKey({ name: "up", shift: true }), makeState());
    expect(up).toEqual({ type: "extendSelection", dir: "up" });

    const down = resolveAction(
      makeKey({ name: "down", shift: true }),
      makeState(),
    );
    expect(down).toEqual({ type: "extendSelection", dir: "down" });
  });

  it("a plain (unshifted) Up/Down still navigates, not extends", () => {
    const action = resolveAction(makeKey({ name: "up" }), makeState());
    expect(action).toEqual({ type: "navigate", dir: "up" });
  });

  it("Ctrl+A marks all", () => {
    const action = resolveAction(
      makeKey({ name: "a", ctrl: true }),
      makeState(),
    );
    expect(action).toEqual({ type: "markAll" });
  });

  it("Ctrl+C still quits — Ctrl+A is a narrow addition, not a general ctrl passthrough", () => {
    const action = resolveAction(
      makeKey({ name: "c", ctrl: true }),
      makeState(),
    );
    expect(action).toEqual({ type: "quit" });
  });

  it("other ctrl/alt combinations remain no-ops", () => {
    expect(
      resolveAction(makeKey({ name: "x", ctrl: true }), makeState()),
    ).toBeNull();
    expect(
      resolveAction(makeKey({ name: "c", alt: true }), makeState()),
    ).toBeNull();
  });

  it("c copies, x cuts", () => {
    expect(resolveAction(makeKey({ name: "c" }), makeState())).toEqual({
      type: "copy",
    });
    expect(resolveAction(makeKey({ name: "x" }), makeState())).toEqual({
      type: "cut",
    });
  });
});

describe("resolveEscape precedence", () => {
  it("goes up when nothing else applies (arm 4)", () => {
    expect(resolveEscape(makeState())).toEqual({ type: "up" });
  });

  it("clears marks when marks exist, instead of navigating up (arm 2)", () => {
    const state = makeState({ marked: new Set(["/tmp/somewhere/a.txt"]) });
    expect(resolveEscape(state)).toEqual({ type: "clearMarks" });
  });

  it("leaves marks alone and goes up once marks are empty again", () => {
    const state = makeState({ marked: new Set() });
    expect(resolveEscape(state)).toEqual({ type: "up" });
  });

  it("resolveAction('escape') routes through the same precedence table", () => {
    const state = makeState({ marked: new Set(["/tmp/somewhere/a.txt"]) });
    const action = resolveAction(makeKey({ name: "escape" }), state);
    expect(action).toEqual({ type: "clearMarks" });
  });
});

describe("navigation bypass: ←/h/Backspace always go up", () => {
  it("ignores marks entirely, unlike Escape", () => {
    const state = makeState({ marked: new Set(["/tmp/somewhere/a.txt"]) });
    expect(resolveAction(makeKey({ name: "h" }), state)).toEqual({
      type: "up",
    });
    expect(resolveAction(makeKey({ name: "backspace" }), state)).toEqual({
      type: "up",
    });
    // "left" resolves to a view-aware `navigate` action (main.ts's
    // handleNavigate treats it as "up" in list view) rather than `up`
    // directly — see keymap.ts's file header for why.
    expect(resolveAction(makeKey({ name: "left" }), state)).toEqual({
      type: "navigate",
      dir: "left",
    });
  });
});
