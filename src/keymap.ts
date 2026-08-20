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
// Arms 1, 2, and 4 are reachable as of Phase 7 (Phase 5a's progress overlay
// and Phase 7's prompt/confirm/permissions overlays all set `state.overlay`;
// marks have been real since Phase 4); arm 3 (archives, Phase 8) is still
// unreachable — but the table was written in full back in Phase 2 so each
// later phase slots in by editing one guard function, not by restructuring
// this file. Phase 4 itself needed no change here at all: `s.marked.size >
// 0` was already the guard.
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
  // Phase 5a: paste. `v` is already the view-toggle key, so `p` it is.
  // Targets the current directory and consumes `AppState.clipboard` — see
  // state/store.ts's `paste()`.
  | { type: "paste" }
  // Escape-precedence arms. `clearMarks` is live as of Phase 4.
  // `closeOverlay` becomes live in Phase 5a too — the paste progress
  // overlay is the first real `AppState.overlay` value, so arm 1 below is
  // no longer only theoretical (see main.ts's handling of it: it cancels an
  // in-flight paste rather than a bare close, since a progress overlay
  // isn't just cosmetic). `leaveArchive` (Phase 8) is still unreachable
  // today (see the guards below) but typed so the table above compiles
  // against it.
  | { type: "closeOverlay" }
  | { type: "clearMarks" }
  | { type: "leaveArchive" }
  // Phase 7: rename, mkdir, delete, permissions. The four `startX` actions
  // only ever reach `state/store.ts` when no overlay is already open (each
  // `startX` method re-checks that itself, since a key can still slip
  // through here between "an overlay opened" and "the next repaint" — see
  // their comments). Every other action below is only ever emitted while
  // the matching overlay is open — see `resolvePromptKey`/
  // `resolveConfirmKey`/`resolvePermissionsKey`, which `resolveAction`
  // dispatches to before it ever reaches the plain-navigation table at the
  // bottom of this file, exactly like Escape's precedence table already
  // short-circuits everything else.
  | { type: "startRename" }
  | { type: "startMkdir" }
  | { type: "startDelete" }
  | { type: "startPermissions" }
  // ui/overlay/prompt.ts's one-line editor (rename, mkdir).
  | { type: "promptChar"; ch: string }
  | { type: "promptBackspace" }
  | { type: "promptDeleteForward" }
  | { type: "promptLeft" }
  | { type: "promptRight" }
  | { type: "promptHome" }
  | { type: "promptEnd" }
  | { type: "promptWordDelete" }
  | { type: "promptClearToStart" }
  | { type: "promptSubmit" }
  // ui/overlay/confirm.ts's delete confirmation. `confirmYes` fires only for
  // a literal `y`/`Y` — never Enter, per the plan ("a stray keypress must
  // never destroy anything").
  | { type: "confirmYes" }
  | { type: "confirmCancel" }
  // ui/overlay/permissions.ts's chmod grid.
  | { type: "permMoveFocus"; dir: "up" | "down" | "left" | "right" }
  | { type: "permToggle" }
  | { type: "permDigit"; digit: number }
  | { type: "permApply" };

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

// ── Phase 7 overlay input capture ──
//
// While a prompt/confirm/permissions overlay is open, it captures *every*
// key except Escape (handled above, unconditionally, before any of this
// runs) — including ones that mean something in the plain navigation table
// below, like `r` or `q`. That is deliberate: typing "rename" into the
// rename prompt must type the letters "r", "e", "n", "a", "m", "e", not
// re-trigger `startRename` or quit the app. `resolveAction` checks
// `state.overlay?.kind` for exactly this reason, ahead of the ctrl+c/ctrl+a
// checks and the main switch.

// Named keys a prompt field never types literally — everything else with
// `ctrl: false, alt: false` is treated as a printable grapheme to insert
// (see the `default` case in `resolvePromptKey`), which is what makes
// CJK/emoji input "just work": `term/input.ts` hands each codepoint through
// as `key.name` with no special casing needed here.
const PROMPT_NON_TEXT_NAMES = new Set([
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "insert",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

function resolvePromptKey(key: Key): Action | null {
  if (key.ctrl && key.name === "w") return { type: "promptWordDelete" };
  if (key.ctrl && key.name === "u") return { type: "promptClearToStart" };
  if (key.ctrl || key.alt) return null; // swallow other ctrl/alt combos while typing
  switch (key.name) {
    case "enter":
      return { type: "promptSubmit" };
    case "backspace":
      return { type: "promptBackspace" };
    case "delete":
      return { type: "promptDeleteForward" };
    case "left":
      return { type: "promptLeft" };
    case "right":
      return { type: "promptRight" };
    case "home":
      return { type: "promptHome" };
    case "end":
      return { type: "promptEnd" };
    case "space":
      return { type: "promptChar", ch: " " };
    case "tab":
      return null; // no multi-field tabbing in a single-line prompt
    default:
      if (PROMPT_NON_TEXT_NAMES.has(key.name)) return null;
      return { type: "promptChar", ch: key.name };
  }
}

/**
 * `y`/`Y` confirms; literally everything else — Enter very much included —
 * cancels. Escape is handled before this is ever called (see the Escape
 * precedence table), so this never has to special-case it.
 */
function resolveConfirmKey(key: Key): Action {
  if (!key.ctrl && !key.alt && (key.name === "y" || key.name === "Y")) {
    return { type: "confirmYes" };
  }
  return { type: "confirmCancel" };
}

function resolvePermissionsKey(key: Key): Action | null {
  if (key.ctrl || key.alt) return null;
  switch (key.name) {
    case "up":
      return { type: "permMoveFocus", dir: "up" };
    case "down":
      return { type: "permMoveFocus", dir: "down" };
    case "left":
      return { type: "permMoveFocus", dir: "left" };
    case "right":
      return { type: "permMoveFocus", dir: "right" };
    case "space":
      return { type: "permToggle" };
    case "enter":
      return { type: "permApply" };
    default:
      if (/^[0-7]$/.test(key.name)) {
        return { type: "permDigit", digit: Number(key.name) };
      }
      return null;
  }
}

// ── the rest of the bindings ──

/**
 * Map one keypress to an action, or `null` when the key means nothing right
 * now. `state` is consulted for Escape's precedence table above and for
 * which overlay (if any) is open — every other binding is a static lookup.
 */
export function resolveAction(key: Key, state: AppState): Action | null {
  if (key.name === "escape") return resolveEscape(state);
  if (state.overlay?.kind === "prompt") return resolvePromptKey(key);
  if (state.overlay?.kind === "confirm") return resolveConfirmKey(key);
  if (state.overlay?.kind === "permissions") return resolvePermissionsKey(key);
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
    case "p":
      return { type: "paste" };
    case "r":
      return { type: "startRename" };
    case "n":
      return { type: "startMkdir" };
    case "d":
    case "delete":
      return { type: "startDelete" };
    case "m":
      return { type: "startPermissions" };
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
