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
// Only arm 4 is reachable in Phase 2 — there are no overlays, marks, or
// archives yet — but the table is written in full now so Phase 4 (marks),
// Phase 7 (overlays), and Phase 8 (archives) each slot in by editing one
// guard function, not by restructuring this file.
//
// `←`, `h`, and `Backspace` bypass this table entirely and always go up, so
// there is always a way to navigate that never depends on Escape's state.

import type { AppState } from "./state/store.ts";
import type { Key } from "./term/input.ts";

export type Action =
  | { type: "moveCursor"; delta: number }
  | { type: "moveCursorTo"; pos: "home" | "end" }
  | { type: "pageMove"; direction: "up" | "down" }
  | { type: "enter" }
  | { type: "up" }
  | { type: "toggleHidden" }
  | { type: "cycleSort" }
  | { type: "toggleSortReverse" }
  | { type: "help" }
  | { type: "quit" }
  // Escape-precedence arms with no handler yet — later phases give these
  // real behavior in app.ts/main.ts; today they are unreachable (see the
  // guards below) but typed so the table above compiles against them.
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
  if (key.ctrl || key.alt) return null;

  switch (key.name) {
    case "up":
    case "k":
      return { type: "moveCursor", delta: -1 };
    case "down":
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
    case "right":
    case "l":
      return { type: "enter" };
    case "left":
    case "h":
    case "backspace":
      return { type: "up" };
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
