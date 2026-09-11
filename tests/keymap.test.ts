// tests/keymap.test.ts — src/keymap.ts: the key -> action table, focused on
// what Phase 4 added (Tab, Shift+↑/↓, Ctrl+A, c/x), on Escape's precedence
// table (the one binding whose meaning depends on state), and, at the
// bottom, Phase 7's overlay-capture routing — the mechanism that makes
// "Enter does not confirm a delete" true. Everything here builds a plain
// `AppState` object directly rather than driving a real `Store` through
// `load()` — `resolveAction` only ever reads state, it never needs a live
// filesystem-backed store.

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

  it("Ctrl+C copies paths to the system clipboard — q is the sole quit key", () => {
    const action = resolveAction(
      makeKey({ name: "c", ctrl: true }),
      makeState(),
    );
    expect(action).toEqual({ type: "copyPath", separator: "newline" });
  });

  it("Ctrl+Alt+C copies paths space-separated", () => {
    const action = resolveAction(
      makeKey({ name: "c", ctrl: true, alt: true }),
      makeState(),
    );
    expect(action).toEqual({ type: "copyPath", separator: "space" });
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

  it("~ jumps to the home directory", () => {
    expect(resolveAction(makeKey({ name: "~" }), makeState())).toEqual({
      type: "goHome",
    });
  });

  it("only q quits", () => {
    expect(resolveAction(makeKey({ name: "q" }), makeState())).toEqual({
      type: "quit",
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

  it("clears (cancels) a staged cut even with no marks (arm 2)", () => {
    const state = makeState({
      marked: new Set(),
      clipboard: { mode: "cut", paths: ["/tmp/somewhere/a.txt"] },
    });
    expect(resolveEscape(state)).toEqual({ type: "clearMarks" });
  });

  it("clears a staged copy too, even with no marks (arm 2)", () => {
    const state = makeState({
      marked: new Set(),
      clipboard: { mode: "copy", paths: ["/tmp/somewhere/a.txt"] },
    });
    expect(resolveEscape(state)).toEqual({ type: "clearMarks" });
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

// ── Phase 7: rename/mkdir/delete/permissions ──

describe("resolveAction: top-level Phase 7 bindings (no overlay open)", () => {
  it("r/n/d/Delete/m map to the four startX actions", () => {
    expect(resolveAction(makeKey({ name: "r" }), makeState())).toEqual({
      type: "startRename",
    });
    expect(resolveAction(makeKey({ name: "n" }), makeState())).toEqual({
      type: "startMkdir",
    });
    expect(resolveAction(makeKey({ name: "d" }), makeState())).toEqual({
      type: "startDelete",
    });
    expect(resolveAction(makeKey({ name: "delete" }), makeState())).toEqual({
      type: "startDelete",
    });
    expect(resolveAction(makeKey({ name: "m" }), makeState())).toEqual({
      type: "startPermissions",
    });
  });
});

describe("resolveAction: prompt overlay captures input", () => {
  const promptState = makeState({
    overlay: {
      kind: "prompt",
      mode: "rename",
      value: "old.txt",
      cursor: 7,
      error: null,
      originalName: "old.txt",
      originalPath: "/tmp/somewhere/old.txt",
    },
  });

  it("types a letter that would otherwise be a global binding (e.g. 'r', 'q')", () => {
    expect(resolveAction(makeKey({ name: "r" }), promptState)).toEqual({
      type: "promptChar",
      ch: "r",
    });
    expect(resolveAction(makeKey({ name: "q" }), promptState)).toEqual({
      type: "promptChar",
      ch: "q",
    });
  });

  it("types a wide/CJK character verbatim", () => {
    expect(resolveAction(makeKey({ name: "文" }), promptState)).toEqual({
      type: "promptChar",
      ch: "文",
    });
  });

  it("routes editing keys to their prompt-specific actions", () => {
    expect(resolveAction(makeKey({ name: "enter" }), promptState)).toEqual({
      type: "promptSubmit",
    });
    expect(resolveAction(makeKey({ name: "backspace" }), promptState)).toEqual({
      type: "promptBackspace",
    });
    expect(resolveAction(makeKey({ name: "delete" }), promptState)).toEqual({
      type: "promptDeleteForward",
    });
    expect(resolveAction(makeKey({ name: "home" }), promptState)).toEqual({
      type: "promptHome",
    });
    expect(resolveAction(makeKey({ name: "end" }), promptState)).toEqual({
      type: "promptEnd",
    });
    expect(resolveAction(makeKey({ name: "left" }), promptState)).toEqual({
      type: "promptLeft",
    });
    expect(resolveAction(makeKey({ name: "right" }), promptState)).toEqual({
      type: "promptRight",
    });
    expect(resolveAction(makeKey({ name: "space" }), promptState)).toEqual({
      type: "promptChar",
      ch: " ",
    });
  });

  it("Ctrl+W and Ctrl+U map to word-delete and clear-to-start", () => {
    expect(
      resolveAction(makeKey({ name: "w", ctrl: true }), promptState),
    ).toEqual({ type: "promptWordDelete" });
    expect(
      resolveAction(makeKey({ name: "u", ctrl: true }), promptState),
    ).toEqual({ type: "promptClearToStart" });
  });

  it("Escape closes the prompt via the ordinary Escape precedence, not a prompt-specific action", () => {
    expect(resolveAction(makeKey({ name: "escape" }), promptState)).toEqual({
      type: "closeOverlay",
    });
  });

  it("swallows an arrow-key-adjacent function key rather than typing it", () => {
    expect(resolveAction(makeKey({ name: "f5" }), promptState)).toBeNull();
  });
});

describe("resolveAction: confirm overlay — Enter never accepts", () => {
  const confirmState = makeState({
    overlay: {
      kind: "confirm",
      message: "Delete 'a.txt'?",
      paths: ["/tmp/somewhere/a.txt"],
    },
  });

  it("only a literal y/Y confirms", () => {
    expect(resolveAction(makeKey({ name: "y" }), confirmState)).toEqual({
      type: "confirmYes",
    });
    expect(resolveAction(makeKey({ name: "Y" }), confirmState)).toEqual({
      type: "confirmYes",
    });
  });

  it("Enter does NOT confirm — the plan's named safety property", () => {
    expect(resolveAction(makeKey({ name: "enter" }), confirmState)).toEqual({
      type: "confirmCancel",
    });
  });

  it("n and any other key cancel, same as Enter", () => {
    expect(resolveAction(makeKey({ name: "n" }), confirmState)).toEqual({
      type: "confirmCancel",
    });
    expect(resolveAction(makeKey({ name: "q" }), confirmState)).toEqual({
      type: "confirmCancel",
    });
    expect(resolveAction(makeKey({ name: "space" }), confirmState)).toEqual({
      type: "confirmCancel",
    });
  });

  it("Escape closes it via the ordinary precedence table", () => {
    expect(resolveAction(makeKey({ name: "escape" }), confirmState)).toEqual({
      type: "closeOverlay",
    });
  });
});

describe("resolveAction: permissions overlay", () => {
  const permState = makeState({
    overlay: {
      kind: "permissions",
      paths: ["/tmp/somewhere/a.txt"],
      rwxBits: 0o644,
      specialBits: 0,
      specialExplicit: false,
      digitCount: 0,
      focus: 0,
      error: null,
    },
  });

  it("Space toggles, arrows move focus, Enter applies", () => {
    expect(resolveAction(makeKey({ name: "space" }), permState)).toEqual({
      type: "permToggle",
    });
    expect(resolveAction(makeKey({ name: "up" }), permState)).toEqual({
      type: "permMoveFocus",
      dir: "up",
    });
    expect(resolveAction(makeKey({ name: "down" }), permState)).toEqual({
      type: "permMoveFocus",
      dir: "down",
    });
    expect(resolveAction(makeKey({ name: "left" }), permState)).toEqual({
      type: "permMoveFocus",
      dir: "left",
    });
    expect(resolveAction(makeKey({ name: "right" }), permState)).toEqual({
      type: "permMoveFocus",
      dir: "right",
    });
    expect(resolveAction(makeKey({ name: "enter" }), permState)).toEqual({
      type: "permApply",
    });
  });

  it("digit keys 0-7 map to permDigit", () => {
    expect(resolveAction(makeKey({ name: "7" }), permState)).toEqual({
      type: "permDigit",
      digit: 7,
    });
    expect(resolveAction(makeKey({ name: "0" }), permState)).toEqual({
      type: "permDigit",
      digit: 0,
    });
  });

  it("digit 8/9 (invalid octal) and plain letters are ignored", () => {
    expect(resolveAction(makeKey({ name: "8" }), permState)).toBeNull();
    expect(resolveAction(makeKey({ name: "q" }), permState)).toBeNull();
  });
});

describe("resolveAction: preview overlay captures input", () => {
  const previewState = makeState({
    overlay: {
      kind: "preview",
      path: "/tmp/somewhere/file.txt",
      lines: [],
      scrollOffset: 0,
      loading: false,
      error: null,
      truncated: false,
    },
  });

  it("scroll keys map to previewScroll", () => {
    expect(resolveAction(makeKey({ name: "down" }), previewState)).toEqual({
      type: "previewScroll",
      delta: 1,
    });
    expect(resolveAction(makeKey({ name: "j" }), previewState)).toEqual({
      type: "previewScroll",
      delta: 1,
    });
    expect(resolveAction(makeKey({ name: "up" }), previewState)).toEqual({
      type: "previewScroll",
      delta: -1,
    });
    expect(resolveAction(makeKey({ name: "k" }), previewState)).toEqual({
      type: "previewScroll",
      delta: -1,
    });
    expect(resolveAction(makeKey({ name: "pagedown" }), previewState)).toEqual({
      type: "previewScroll",
      delta: 10,
    });
    expect(resolveAction(makeKey({ name: "pageup" }), previewState)).toEqual({
      type: "previewScroll",
      delta: -10,
    });
    expect(resolveAction(makeKey({ name: "end" }), previewState)).toEqual({
      type: "previewScroll",
      delta: 1_000_000,
    });
    expect(resolveAction(makeKey({ name: "home" }), previewState)).toEqual({
      type: "previewScroll",
      delta: -1_000_000,
    });
  });

  it("g/G alias Home/End, matching less/bat's own jump-to-top/bottom", () => {
    expect(resolveAction(makeKey({ name: "g" }), previewState)).toEqual({
      type: "previewScroll",
      delta: -1_000_000,
    });
    expect(resolveAction(makeKey({ name: "G" }), previewState)).toEqual({
      type: "previewScroll",
      delta: 1_000_000,
    });
  });

  it("Ctrl+D/U/F/B map to vim/less's half/full-page scroll", () => {
    expect(
      resolveAction(makeKey({ name: "f", ctrl: true }), previewState),
    ).toEqual({ type: "previewScroll", delta: 10 });
    expect(
      resolveAction(makeKey({ name: "b", ctrl: true }), previewState),
    ).toEqual({ type: "previewScroll", delta: -10 });
    expect(
      resolveAction(makeKey({ name: "d", ctrl: true }), previewState),
    ).toEqual({ type: "previewScroll", delta: 5 });
    expect(
      resolveAction(makeKey({ name: "u", ctrl: true }), previewState),
    ).toEqual({ type: "previewScroll", delta: -5 });
  });

  it("other Ctrl combos are swallowed, not leaked through", () => {
    expect(
      resolveAction(makeKey({ name: "c", ctrl: true }), previewState),
    ).toBeNull();
  });

  it("swallows keys that would copy/cut/quit/rename in the plain browser", () => {
    expect(resolveAction(makeKey({ name: "c" }), previewState)).toBeNull();
    expect(resolveAction(makeKey({ name: "x" }), previewState)).toBeNull();
    expect(resolveAction(makeKey({ name: "q" }), previewState)).toBeNull();
    expect(resolveAction(makeKey({ name: "r" }), previewState)).toBeNull();
    expect(resolveAction(makeKey({ name: "enter" }), previewState)).toBeNull();
  });

  it("Escape closes it via the ordinary precedence table (arm 1)", () => {
    expect(resolveEscape(previewState)).toEqual({ type: "closeOverlay" });
    expect(resolveAction(makeKey({ name: "escape" }), previewState)).toEqual({
      type: "closeOverlay",
    });
  });
});

describe("resolveAction: goto bookmark ('b')", () => {
  it("b opens the bookmark picker in the plain browser", () => {
    expect(resolveAction(makeKey({ name: "b" }), makeState())).toEqual({
      type: "startBookmarks",
    });
  });
});

describe("resolveAction: bookmarks overlay captures input", () => {
  const bookmarksState = makeState({
    overlay: {
      kind: "bookmarks",
      items: [
        { name: "flash", path: "/home/dev/github/flash" },
        { name: "kb", path: "/home/dev/github/kb" },
      ],
      cursor: 0,
    },
  });

  it("up/down/j/k move the row cursor", () => {
    expect(resolveAction(makeKey({ name: "down" }), bookmarksState)).toEqual({
      type: "bookmarksMove",
      delta: 1,
    });
    expect(resolveAction(makeKey({ name: "j" }), bookmarksState)).toEqual({
      type: "bookmarksMove",
      delta: 1,
    });
    expect(resolveAction(makeKey({ name: "up" }), bookmarksState)).toEqual({
      type: "bookmarksMove",
      delta: -1,
    });
    expect(resolveAction(makeKey({ name: "k" }), bookmarksState)).toEqual({
      type: "bookmarksMove",
      delta: -1,
    });
  });

  it("Home/End jump to the ends of the list", () => {
    expect(resolveAction(makeKey({ name: "home" }), bookmarksState)).toEqual({
      type: "bookmarksMoveTo",
      pos: "home",
    });
    expect(resolveAction(makeKey({ name: "end" }), bookmarksState)).toEqual({
      type: "bookmarksMoveTo",
      pos: "end",
    });
  });

  it("Enter/Space select the highlighted bookmark", () => {
    expect(resolveAction(makeKey({ name: "enter" }), bookmarksState)).toEqual({
      type: "selectBookmark",
    });
    expect(resolveAction(makeKey({ name: "space" }), bookmarksState)).toEqual({
      type: "selectBookmark",
    });
  });

  it("b again closes it, mirroring '?' on the help overlay", () => {
    expect(resolveAction(makeKey({ name: "b" }), bookmarksState)).toEqual({
      type: "closeOverlay",
    });
  });

  it("swallows keys that would copy/cut/quit in the plain browser", () => {
    expect(resolveAction(makeKey({ name: "c" }), bookmarksState)).toBeNull();
    expect(resolveAction(makeKey({ name: "x" }), bookmarksState)).toBeNull();
    expect(resolveAction(makeKey({ name: "q" }), bookmarksState)).toBeNull();
  });

  it("Escape closes it via the ordinary precedence table (arm 1)", () => {
    expect(resolveEscape(bookmarksState)).toEqual({ type: "closeOverlay" });
    expect(resolveAction(makeKey({ name: "escape" }), bookmarksState)).toEqual({
      type: "closeOverlay",
    });
  });
});
