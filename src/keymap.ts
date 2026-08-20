// keymap.ts — key string -> action, the single place key bindings live.
//
// `resolveAction()` is the only function `main.ts` calls on a keypress; it
// never inspects a `Key` directly. That keeps every binding — including
// Escape's context-sensitive precedence — declared in exactly one place, so
// nothing has to be cross-referenced against `main.ts` to know what a key
// does.
//
// Escape has three jobs per the plan, resolved in strict precedence order,
// first match wins:
//   1. An overlay is open -> close it.
//   2. Marks exist -> clear them.
//   3. Browsing an archive at its root -> leave the archive.
//   4. Otherwise -> go up one directory.
// Arms 2 and 4 are reachable as of Phase 4 (marks are real now); arm 1
// (overlays, Phase 7) and arm 3 (archives, Phase 8) are still unreachable —
// but the table was written in full back in Phase 2 so each later phase
// slots in by editing one guard function, not by restructuring this file.
// Phase 4 itself needed no change here at all: `s.marked.size > 0` was
// already the guard.
//
// `h` and `Backspace` bypass this table entirely and always go up, so there
// is always a way to navigate that never depends on Escape's state. `←`
// joins them in list view, but not in grid view — see the `navigate`
// Action's comment below for why grid mode needs the literal arrow keys to
// mean "move the cursor" instead.

import type { AppState } from "./state/store.ts";
import type { Key } from "./term/input.ts";

export type Action =
  | { type: "moveCursor"; delta: number }
  | { type: "moveCursorTo"; pos: "home" | "end" }
  | { type: "pageMove"; direction: "up" | "down" }
  // Emitted only for the four literal arrow keys, never for h/j/k/l — see
  // the comment on the switch statement below. main.ts resolves this
  // against the current view: list mode reproduces the original
  // up/down-move, left-go-up, right-enter behavior; grid mode moves the
  // cursor geometrically (ui/gridView.ts's `moveGridCursor`), since a flat
  // moveCursor delta would let ↑/↓ silently cross a column boundary.
  | { type: "navigate"; dir: "up" | "down" | "left" | "right" }
  | { type: "enter" }
  | { type: "up" }
  | { type: "toggleView" }
  | { type: "toggleHidden" }
  | { type: "cycleSort" }
  | { type: "toggleSortReverse" }
  | { type: "help" }
  | { type: "quit" }
  // Phase 4: selection and clipboard. `toggleMark` also advances the
  // cursor (see state/store.ts's `MARK_ADVANCE`); `extendSelection` carries
  // the arrow direction so the Shift+↑/↓ range anchor extends the right way.
  | { type: "toggleMark" }
  | { type: "extendSelection"; dir: "up" | "down" }
  | { type: "markAll" }
  | { type: "copy" }
  | { type: "cut" }
  // Escape-precedence arms. `clearMarks` is live as of Phase 4; `closeOverlay`
  // (Phase 7) and `leaveArchive` (Phase 8) are still unreachable today (see
  // the guards below) but typed so the table above compiles against them.
  | { type: "closeOverlay" }
  | { type: "clearMarks" }
  | { type: "leaveArchive" };

// ── Escape precedence ──

type EscapeGuard = (state: AppState) => Action | null;

function isArchiveRoot(state: AppState): boolean {
  return state.archive !== null && state.archive.innerPath === "";
}

const ESCAPE_PRECEDENCE: EscapeGuard[] = [
  (s) => (s.overlay ? { type: "closeOverlay" } : null),
  (s) => (s.marked.size > 0 ? { type: "clearMarks" } : null),
  (s) => (isArchiveRoot(s) ? { type: "leaveArchive" } : null),
  () => ({ type: "up" }),
];

export function resolveEscape(state: AppState): Action {
  for (const guard of ESCAPE_PRECEDENCE) {
    const action = guard(state);
    if (action) return action;
  }
  // Unreachable: the last guard above always matches.
  return { type: "up" };
}

// ── the rest of the bindings ──

/**
 * Map one keypress to an action, or `null` when the key means nothing right
 * now. `state` is only consulted for Escape's precedence table above —
 * every other binding is a static lookup.
 */
export function resolveAction(key: Key, state: AppState): Action | null {
  if (key.name === "escape") return resolveEscape(state);
  if (key.ctrl && key.name === "c") return { type: "quit" };
  if (key.ctrl && key.name === "a") return { type: "markAll" };
  // Shift+↑/↓ extends the range selection — checked ahead of the ctrl/alt
  // early-return below (shift is its own flag, unrelated to it) and ahead
  // of the plain arrow-key cases, which a bare ↑/↓ still falls through to.
  if (key.shift && (key.name === "up" || key.name === "down")) {
    return { type: "extendSelection", dir: key.name };
  }
  if (key.ctrl || key.alt) return null;

  switch (key.name) {
    // The literal arrow keys are view-aware (see the `navigate` Action
    // comment above) — only they change meaning in grid mode. The vi
    // letters keep their plain list-style meaning in every view, so there
    // is always a fixed, predictable set of bindings regardless of view.
    case "up":
      return { type: "navigate", dir: "up" };
    case "down":
      return { type: "navigate", dir: "down" };
    case "left":
      return { type: "navigate", dir: "left" };
    case "right":
      return { type: "navigate", dir: "right" };
    case "k":
      return { type: "moveCursor", delta: -1 };
    case "j":
      return { type: "moveCursor", delta: 1 };
    case "pageup":
      return { type: "pageMove", direction: "up" };
    case "pagedown":
      return { type: "pageMove", direction: "down" };
    case "home":
      return { type: "moveCursorTo", pos: "home" };
    case "end":
      return { type: "moveCursorTo", pos: "end" };
    case "enter":
    case "space":
    case "l":
      return { type: "enter" };
    case "h":
    case "backspace":
      return { type: "up" };
    case "tab":
      return { type: "toggleMark" };
    case "c":
      return { type: "copy" };
    case "x":
      return { type: "cut" };
    case "v":
      return { type: "toggleView" };
    case ".":
      return { type: "toggleHidden" };
    case "s":
      return { type: "cycleSort" };
    case "S":
      return { type: "toggleSortReverse" };
    case "?":
      return { type: "help" };
    case "q":
      return { type: "quit" };
    default:
      return null;
  }
}
