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
// All four arms are reachable as of Phase 8: Phase 5a's progress overlay and
// Phase 7's prompt/confirm/permissions overlays all set `state.overlay`;
// marks have been real since Phase 4; arm 3 (`isArchiveRoot`, below) is real
// as of Phase 8, once `state/store.ts`'s `enter()` can actually set
// `state.archive`. The table was written in full back in Phase 2 so each
// later phase slotted in by editing one guard function, never by
// restructuring this file — Phase 4 needed no change here at all
// (`s.marked.size > 0` was already the guard), and Phase 8 only needed
// `isArchiveRoot()` to stop being a stub that could never return true.
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
  // Phase 9: the `?` help overlay. `helpScroll` is only ever emitted while
  // `state.overlay?.kind === "help"` (see `resolveHelpKey` below) — `delta`
  // is a line count, with Home/End sending an oversized delta that
  // `Store.helpScroll`'s clamp reduces to "jump to the very top/bottom."
  | { type: "helpScroll"; delta: number }
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
  // Phase 8: archives. `startArchive` (`z`) opens the same `prompt`
  // overlay rename/mkdir use, just with `mode: "archive"` — see
  // state/store.ts's `Overlay` type. `startExtract` (`u`) has no overlay
  // of its own at all; it goes straight to the progress overlay, same as
  // `paste`/`confirmDelete` do once their own setup is done.
  | { type: "startArchive" }
  | { type: "startExtract" }
  // ui/overlay/prompt.ts's one-line editor (rename, mkdir, archive).
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

// ── the bindings table ──
//
// Single source of truth for every plain (non-overlay, non-Escape) key
// binding: a human-readable label, a one-line description, a category, and
// — via `matches`/`action` — what `resolveAction`'s final fallback actually
// dispatches to. That fallback (at the bottom of this file) does nothing
// but scan this array and return the first match; `ui/overlay/help.ts`
// renders the very same array grouped by `category`. There is exactly one
// list, so the `?` help screen cannot silently drift from what a key
// actually does: a binding that isn't added here doesn't work, and one
// added here without a `description` fails `tsc` (the field is required),
// which is what tests/help.test.ts leans on to fail loudly if a future
// binding forgets one.
//
// Escape and the three overlay-capture resolvers just below
// (`resolvePromptKey`/`resolveConfirmKey`/`resolvePermissionsKey`, joined
// by `resolveHelpKey`) are deliberately NOT folded into this table — each
// is already its own single source of truth for a state-dependent or
// modal-only slice of the key surface (Escape's precedence table; a
// prompt's line editor; etc.), so folding them in would just be drift risk
// in the other direction. `ui/overlay/help.ts` documents Escape by hand
// (`ESCAPE_HELP` below) for exactly this reason.
export type BindingCategory =
  | "navigation"
  | "selection"
  | "file operations"
  | "archives"
  | "view"
  | "app";

export type KeyBinding = {
  /** Human-readable key labels, in the order shown in the help overlay. */
  display: string[];
  description: string;
  category: BindingCategory;
  matches: (key: Key) => boolean;
  action: (key: Key) => Action;
};

/** A key with this `name`, and neither modifier held — most of the table. */
function bare(...names: string[]): (key: Key) => boolean {
  return (key: Key) => !key.ctrl && !key.alt && names.includes(key.name);
}

/** An arrow key specifically *without* Shift — Shift+↑/↓ is its own entry. */
function plainArrow(name: string): (key: Key) => boolean {
  return (key: Key) => !key.ctrl && !key.alt && !key.shift && key.name === name;
}

function withCtrl(name: string): (key: Key) => boolean {
  return (key: Key) => key.ctrl && !key.alt && key.name === name;
}

function shiftArrow(name: "up" | "down"): (key: Key) => boolean {
  return (key: Key) => key.shift && key.name === name;
}

export const BINDINGS: KeyBinding[] = [
  // ── selection ── (checked ahead of the plain arrow entries below so a
  // Shift+↑/↓ can never fall through to the bare "move cursor" binding)
  {
    display: ["Shift+↑", "Shift+↓"],
    description: "Extend the marked range from the cursor",
    category: "selection",
    matches: (key) => shiftArrow("up")(key) || shiftArrow("down")(key),
    action: (key) => ({
      type: "extendSelection",
      dir: key.name === "up" ? "up" : "down",
    }),
  },
  {
    display: ["Ctrl+A"],
    description: "Mark every entry in the current directory",
    category: "selection",
    matches: withCtrl("a"),
    action: () => ({ type: "markAll" }),
  },
  {
    display: ["Tab"],
    description: "Toggle the mark on the entry under the cursor",
    category: "selection",
    matches: bare("tab"),
    action: () => ({ type: "toggleMark" }),
  },

  // ── navigation ──
  {
    display: ["↑"],
    description: "Move up (list) · move up a row (grid)",
    category: "navigation",
    matches: plainArrow("up"),
    action: () => ({ type: "navigate", dir: "up" }),
  },
  {
    display: ["↓"],
    description: "Move down (list) · move down a row (grid)",
    category: "navigation",
    matches: plainArrow("down"),
    action: () => ({ type: "navigate", dir: "down" }),
  },
  {
    display: ["←"],
    description: "Go up a directory (list) · move left (grid)",
    category: "navigation",
    matches: plainArrow("left"),
    action: () => ({ type: "navigate", dir: "left" }),
  },
  {
    display: ["→"],
    description: "Open (list) · move right (grid)",
    category: "navigation",
    matches: plainArrow("right"),
    action: () => ({ type: "navigate", dir: "right" }),
  },
  {
    display: ["k"],
    description: "Move cursor up",
    category: "navigation",
    matches: bare("k"),
    action: () => ({ type: "moveCursor", delta: -1 }),
  },
  {
    display: ["j"],
    description: "Move cursor down",
    category: "navigation",
    matches: bare("j"),
    action: () => ({ type: "moveCursor", delta: 1 }),
  },
  {
    display: ["Enter", "Space", "l"],
    description: "Open the selected entry (enter dir / view file)",
    category: "navigation",
    matches: bare("enter", "space", "l"),
    action: () => ({ type: "enter" }),
  },
  {
    display: ["h", "Backspace"],
    description: "Go up a directory, regardless of view",
    category: "navigation",
    matches: bare("h", "backspace"),
    action: () => ({ type: "up" }),
  },
  {
    display: ["PgUp"],
    description: "Page up",
    category: "navigation",
    matches: bare("pageup"),
    action: () => ({ type: "pageMove", direction: "up" }),
  },
  {
    display: ["PgDn"],
    description: "Page down",
    category: "navigation",
    matches: bare("pagedown"),
    action: () => ({ type: "pageMove", direction: "down" }),
  },
  {
    display: ["Home"],
    description: "Jump to the first entry",
    category: "navigation",
    matches: bare("home"),
    action: () => ({ type: "moveCursorTo", pos: "home" }),
  },
  {
    display: ["End"],
    description: "Jump to the last entry",
    category: "navigation",
    matches: bare("end"),
    action: () => ({ type: "moveCursorTo", pos: "end" }),
  },

  // ── file operations ──
  {
    display: ["c"],
    description: "Copy marked entries (or the entry under the cursor)",
    category: "file operations",
    matches: bare("c"),
    action: () => ({ type: "copy" }),
  },
  {
    display: ["x"],
    description: "Cut marked entries (or the entry under the cursor)",
    category: "file operations",
    matches: bare("x"),
    action: () => ({ type: "cut" }),
  },
  {
    display: ["p"],
    description: "Paste the clipboard into the current directory",
    category: "file operations",
    matches: bare("p"),
    action: () => ({ type: "paste" }),
  },
  {
    display: ["r"],
    description: "Rename the entry under the cursor",
    category: "file operations",
    matches: bare("r"),
    action: () => ({ type: "startRename" }),
  },
  {
    display: ["n"],
    description: "Create a new directory",
    category: "file operations",
    matches: bare("n"),
    action: () => ({ type: "startMkdir" }),
  },
  {
    display: ["d", "Delete"],
    description: "Delete marked entries (or the entry under the cursor)",
    category: "file operations",
    matches: bare("d", "delete"),
    action: () => ({ type: "startDelete" }),
  },
  {
    display: ["m"],
    description: "Edit permissions (chmod)",
    category: "file operations",
    matches: bare("m"),
    action: () => ({ type: "startPermissions" }),
  },

  // ── archives ──
  {
    display: ["z"],
    description: "Zip marked entries (or the cursor entry) into a new archive",
    category: "archives",
    matches: bare("z"),
    action: () => ({ type: "startArchive" }),
  },
  {
    display: ["u"],
    description: "Extract the archive under the cursor here",
    category: "archives",
    matches: bare("u"),
    action: () => ({ type: "startExtract" }),
  },

  // ── view ──
  {
    display: ["v"],
    description: "Toggle list/grid view",
    category: "view",
    matches: bare("v"),
    action: () => ({ type: "toggleView" }),
  },
  {
    display: ["."],
    description: "Toggle hidden files",
    category: "view",
    matches: bare("."),
    action: () => ({ type: "toggleHidden" }),
  },
  {
    display: ["s"],
    description: "Cycle sort order (name / size / mtime / extension)",
    category: "view",
    matches: bare("s"),
    action: () => ({ type: "cycleSort" }),
  },
  {
    display: ["S"],
    description: "Reverse the sort order",
    category: "view",
    matches: bare("S"),
    action: () => ({ type: "toggleSortReverse" }),
  },

  // ── app ──
  {
    display: ["?"],
    description: "Show this help",
    category: "app",
    matches: bare("?"),
    action: () => ({ type: "help" }),
  },
  {
    display: ["q", "Ctrl+C"],
    description: "Quit flash",
    category: "app",
    matches: (key) => bare("q")(key) || withCtrl("c")(key),
    action: () => ({ type: "quit" }),
  },
];

/**
 * Escape isn't in `BINDINGS` above (see that array's file comment) — its
 * dispatch lives entirely in `ESCAPE_PRECEDENCE`/`resolveEscape` below,
 * which is already its own single source of truth. This is just the
 * human-readable description `ui/overlay/help.ts` renders alongside it, in
 * the "navigation" category.
 */
export const ESCAPE_HELP: {
  display: string[];
  description: string;
  category: BindingCategory;
} = {
  display: ["Esc"],
  description: "Close overlay > clear marks > leave archive > go up",
  category: "navigation",
};

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

// A scroll step big enough that clamping it against any real content length
// is equivalent to "jump to the very top/bottom" — Home/End reuse the same
// `helpScroll` action as ↑/↓/j/k/PgUp/PgDn rather than needing their own
// Action variant, since `Store.helpScroll`'s clamp (see state/store.ts)
// already has to saturate at both ends for the plain scroll keys anyway.
const HELP_SCROLL_JUMP = 1_000_000;

/**
 * The `?` help overlay captures every key except Escape (handled
 * unconditionally before this ever runs, same as every other overlay) —
 * scrolling keys move it, `?` toggles it closed again (a help screen that
 * only Escape can dismiss is a common enough paper cut to avoid for free),
 * and everything else is swallowed rather than leaking through to
 * copy/cut/delete/etc. running behind it.
 */
function resolveHelpKey(key: Key): Action | null {
  if (key.ctrl || key.alt) return null;
  switch (key.name) {
    case "up":
    case "k":
      return { type: "helpScroll", delta: -1 };
    case "down":
    case "j":
      return { type: "helpScroll", delta: 1 };
    case "pageup":
      return { type: "helpScroll", delta: -10 };
    case "pagedown":
      return { type: "helpScroll", delta: 10 };
    case "home":
      return { type: "helpScroll", delta: -HELP_SCROLL_JUMP };
    case "end":
      return { type: "helpScroll", delta: HELP_SCROLL_JUMP };
    case "?":
      return { type: "closeOverlay" };
    default:
      return null;
  }
}

// ── the rest of the bindings: driven entirely by `BINDINGS` above ──

/**
 * Map one keypress to an action, or `null` when the key means nothing right
 * now. `state` is consulted for Escape's precedence table above and for
 * which overlay (if any) is open — every other binding is a lookup into
 * `BINDINGS`, scanned in order for the first entry whose `matches` accepts
 * this key.
 */
export function resolveAction(key: Key, state: AppState): Action | null {
  if (key.name === "escape") return resolveEscape(state);
  if (state.overlay?.kind === "prompt") return resolvePromptKey(key);
  if (state.overlay?.kind === "confirm") return resolveConfirmKey(key);
  if (state.overlay?.kind === "permissions") return resolvePermissionsKey(key);
  if (state.overlay?.kind === "help") return resolveHelpKey(key);
  for (const binding of BINDINGS) {
    if (binding.matches(key)) return binding.action(key);
  }
  return null;
}
