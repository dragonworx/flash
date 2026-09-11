// keymap.ts — key string -> action, the single place key bindings live.
//
// `resolveAction()` is the only function `main.ts` calls on a keypress; it
// never inspects a `Key` directly. That keeps every binding — including
// Escape's context-sensitive precedence — declared in exactly one place, so
// nothing has to be cross-referenced against `main.ts` to know what a key
// does.
//
// Escape has five jobs, resolved in strict precedence order, first match
// wins:
//   1. An overlay is open -> close it.
//   2. The `/` quick filter is open -> close it (query discarded, marks and
//      clipboard left untouched).
//   3. Marks exist, or a copy/cut is staged -> clear marks and the clipboard.
//   4. Browsing an archive at its root -> leave the archive.
//   5. Otherwise -> go up one directory.
// This is deliberate, user-requested layering: filter, then marks, then
// navigation, each needing its own Escape before the next is reachable —
// so a mark placed while filtering survives the filter closing, and only a
// *second* Escape clears it.
// Arm 3 treats a staged clipboard exactly like marks: the first Escape
// clears the selection and the path stays put; only an Escape pressed with
// nothing selected goes up. A staged cut needs this because `rowMarkState`
// (term/theme.ts) checks the clipboard before `marked` — clearing only
// `marked` would leave a lone cut entry (no prior mark, e.g. cut via the
// cursor with nothing selected) showing its "x" glyph forever — and a staged
// copy gets the same treatment so Escape's "clear first, navigate second"
// contract doesn't depend on how the selection was staged. Navigating up
// with a clipboard staged still works via h/Backspace/←, which bypass this
// table entirely, so copy -> navigate -> paste is unaffected.
// All five arms are reachable: Phase 5a's progress overlay and Phase 7's
// prompt/confirm/permissions overlays all set `state.overlay`; marks have
// been real since Phase 4; arm 4 (`isArchiveRoot`, below) is real as of
// Phase 8, once `state/store.ts`'s `enter()` can actually set
// `state.archive`; arm 2 (the quick filter) is the newest. The table was
// written in full back in Phase 2 so each
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
  // `` ` ``: jump straight to the user's home directory — a real navigation,
  // same as picking a bookmark (state/store.ts's `goHome`).
  | { type: "goHome" }
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
  // The text preview overlay (Enter on a plain file — see
  // state/store.ts's `startPreview`). `previewScroll` only ever fires
  // while `state.overlay?.kind === "preview"` (see `resolvePreviewKey`
  // below), same shape as `helpScroll` above including the Home/End
  // oversized-delta convention.
  | { type: "previewScroll"; delta: number }
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
  // Ctrl+C copies the selected entries' full paths to the *system* clipboard
  // (via OSC 52 — see term/osc.ts's `setClipboard`), distinct from `c`,
  // which stages files in flash's own internal clipboard for `p` to paste.
  // `separator` picks the multi-select format: one path per line, or —
  // with Shift+C — a single space-separated line. Shift+C, not a Ctrl or
  // Alt combo: Ctrl+letter doesn't encode Shift at the terminal-protocol
  // level (Ctrl+C and Ctrl+Shift+C are typically the same 0x03 byte, and
  // many emulators intercept Ctrl+Shift+C themselves for native copy before
  // an app ever sees it), and Ctrl+Alt+<letter> is unreliable in practice —
  // verified on iTerm2 over SSH through herdr, holding Option together with
  // Ctrl drops the ESC-prefix Option normally sends and the byte arrives as
  // plain Ctrl+C, silently falling back to the newline binding. A bare
  // Shift+letter has no such ambiguity: every terminal just sends the
  // capital-letter byte, same as the existing `s`/`S` (sort/reverse-sort)
  // pair. This takes Ctrl+C away from "quit" (`q` remains the quit key), a
  // deliberate trade: the OSC 52 path-copy is the only feature here that
  // needs a Ctrl key anyway, since every letter is already spoken for.
  | { type: "copyPath"; separator: "newline" | "space" }
  // Escape-precedence arms. `clearMarks` clears every mark and any staged
  // clipboard (copy *or* cut) — see the file header for why a copy gets the
  // same treatment as a cut.
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
  | { type: "permApply" }
  // The `b` key's goto bookmark picker (state/store.ts's `startBookmarks`).
  // `bookmarksMove`/`bookmarksMoveTo` only ever fire while
  // `state.overlay?.kind === "bookmarks"` (see `resolveBookmarksKey`
  // below), same shape as `helpScroll`'s Home/End oversized-delta
  // convention doesn't apply here — the picker is a discrete row cursor,
  // not free-scrolling text, so Home/End get their own action instead.
  | { type: "startBookmarks" }
  | { type: "bookmarksMove"; delta: number }
  | { type: "bookmarksMoveTo"; pos: "home" | "end" }
  | { type: "selectBookmark" }
  // The `/` quick filter (state/store.ts's `startFilter`). Not gated behind
  // an overlay check the way every other `startX` action above is — see
  // `resolveFilterKey` below and the `filter` field's comment on
  // `AppState` for why it needs its own top-level capture instead.
  | { type: "startFilter" }
  | { type: "filterChar"; ch: string }
  | { type: "filterBackspace" }
  | { type: "closeFilter" };

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
    description: "Open the selected entry (enter dir / preview file)",
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
  {
    display: ["b"],
    description: "Open goto bookmarks and jump to one",
    category: "navigation",
    matches: bare("b"),
    action: () => ({ type: "startBookmarks" }),
  },
  {
    display: ["`"],
    description: "Jump to your home directory",
    category: "navigation",
    matches: bare("`"),
    action: () => ({ type: "goHome" }),
  },
  {
    display: ["/"],
    description: "Filter the current listing by name",
    category: "navigation",
    matches: bare("/"),
    action: () => ({ type: "startFilter" }),
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
    display: ["Ctrl+C"],
    description:
      "Copy the selected entries' full paths to the system clipboard (one per line)",
    category: "file operations",
    matches: withCtrl("c"),
    action: () => ({ type: "copyPath", separator: "newline" }),
  },
  {
    display: ["Shift+C"],
    description: "Same as Ctrl+C, but as a single space-separated line",
    category: "file operations",
    matches: bare("C"),
    action: () => ({ type: "copyPath", separator: "space" }),
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
    // Ctrl+C used to quit here too; it now copies paths to the system
    // clipboard instead (see the `copyPath` Action's comment), leaving `q`
    // as the sole quit key.
    display: ["q"],
    description: "Quit flash",
    category: "app",
    matches: bare("q"),
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
  description: "Close overlay > clear marks/clipboard > leave archive > go up",
  category: "navigation",
};

// ── Escape precedence ──

type EscapeGuard = (state: AppState) => Action | null;

function isArchiveRoot(state: AppState): boolean {
  return state.archive !== null && state.archive.innerPath === "";
}

const ESCAPE_PRECEDENCE: EscapeGuard[] = [
  (s) => (s.overlay ? { type: "closeOverlay" } : null),
  (s) => (s.filter ? { type: "closeFilter" } : null),
  (s) =>
    s.marked.size > 0 || s.clipboard !== null ? { type: "clearMarks" } : null,
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

/**
 * The `b` bookmark picker captures every key except Escape (handled
 * unconditionally before this ever runs, same as every other overlay) —
 * up/down move the row cursor, Enter/Space jumps to it, `b` toggles it
 * closed again (the same "its own open key also closes it" convenience
 * `?` gives the help overlay), everything else is swallowed.
 */
function resolveBookmarksKey(key: Key): Action | null {
  if (key.ctrl || key.alt) return null;
  switch (key.name) {
    case "up":
    case "k":
      return { type: "bookmarksMove", delta: -1 };
    case "down":
    case "j":
      return { type: "bookmarksMove", delta: 1 };
    case "pageup":
      return { type: "bookmarksMove", delta: -10 };
    case "pagedown":
      return { type: "bookmarksMove", delta: 10 };
    case "home":
      return { type: "bookmarksMoveTo", pos: "home" };
    case "end":
      return { type: "bookmarksMoveTo", pos: "end" };
    case "enter":
    case "space":
      return { type: "selectBookmark" };
    case "b":
      return { type: "closeOverlay" };
    default:
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

// Same fixed-size "page" PgUp/PgDn already used before vim bindings existed
// here — not the box's real viewport height (unlike Home/End's jump, which
// deliberately overshoots to whatever the true bottom is; see
// `HELP_SCROLL_JUMP`). Ctrl+F/Ctrl+B (vim/less "full page") reuse it as-is;
// Ctrl+D/Ctrl+U (vim/less "half page") reuse half of it.
const PREVIEW_PAGE_LINES = 10;

/**
 * The text preview overlay captures every key except Escape (handled
 * unconditionally before this ever runs, same as every other overlay) —
 * only scroll keys mean anything here, everything else is swallowed rather
 * than leaking through to the browser behind it. There's no toggle-closed
 * key of its own (unlike help's `?`) since there's no single dedicated key
 * that opens a preview — Enter's behavior depends on what's under the
 * cursor — so Escape is the only way out, per the feature's own spec.
 *
 * The scroll keys are deliberately vim/less's own set — `j`/`k`, `g`/`G`
 * (jump to top/bottom, aliasing Home/End's oversized-delta trick), and
 * Ctrl+D/Ctrl+U/Ctrl+F/Ctrl+B (half/full page) — since this overlay only
 * ever captures raw stdin bytes and renders through `Screen` like the rest
 * of the app (see CLAUDE.md's "nothing outside `Screen` ever writes to
 * stdout" invariant); it does not hand the terminal to a real interactive
 * `bat`/`less` pager, so replicating that pager's own keybindings here is
 * the only way to get its muscle-memory shortcuts without breaking that
 * invariant.
 */
function resolvePreviewKey(key: Key): Action | null {
  if (key.alt) return null;
  if (key.ctrl) {
    switch (key.name) {
      case "d":
        return { type: "previewScroll", delta: PREVIEW_PAGE_LINES / 2 };
      case "u":
        return { type: "previewScroll", delta: -PREVIEW_PAGE_LINES / 2 };
      case "f":
        return { type: "previewScroll", delta: PREVIEW_PAGE_LINES };
      case "b":
        return { type: "previewScroll", delta: -PREVIEW_PAGE_LINES };
      default:
        return null;
    }
  }
  switch (key.name) {
    case "up":
    case "k":
      return { type: "previewScroll", delta: -1 };
    case "down":
    case "j":
      return { type: "previewScroll", delta: 1 };
    case "pageup":
      return { type: "previewScroll", delta: -PREVIEW_PAGE_LINES };
    case "pagedown":
      return { type: "previewScroll", delta: PREVIEW_PAGE_LINES };
    case "home":
    case "g":
      return { type: "previewScroll", delta: -HELP_SCROLL_JUMP };
    case "end":
    case "G":
      return { type: "previewScroll", delta: HELP_SCROLL_JUMP };
    default:
      return null;
  }
}

// ── the `/` quick filter ──
//
// Unlike every overlay-capture resolver above, this one does not swallow
// navigation or marking: up/down/PgUp/PgDn/Home/End move the cursor on the
// filtered list, Tab toggles the mark at the cursor, and Enter opens the
// entry under it — all per the user's explicit ask that those keep working
// while filtering. Everything else printable (letters included, even ones
// that are file-op shortcuts in the plain browser — `c`, `d`, `p`, etc.)
// becomes query text instead, the same "capture typing" precedent
// `resolvePromptKey` already set for the rename/mkdir editor. Escape is
// handled unconditionally before this ever runs (see `ESCAPE_PRECEDENCE`'s
// arm 2 above), so it never reaches here.
const FILTER_SWALLOWED_NAMES = new Set([
  "left",
  "right",
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

function resolveFilterKey(key: Key): Action | null {
  if (key.ctrl || key.alt) return null;
  switch (key.name) {
    case "up":
      return { type: "navigate", dir: "up" };
    case "down":
      return { type: "navigate", dir: "down" };
    case "pageup":
      return { type: "pageMove", direction: "up" };
    case "pagedown":
      return { type: "pageMove", direction: "down" };
    case "home":
      return { type: "moveCursorTo", pos: "home" };
    case "end":
      return { type: "moveCursorTo", pos: "end" };
    case "tab":
      return { type: "toggleMark" };
    case "enter":
      return { type: "enter" };
    case "backspace":
      return { type: "filterBackspace" };
    case "space":
      return { type: "filterChar", ch: " " };
    default:
      if (FILTER_SWALLOWED_NAMES.has(key.name)) return null;
      return { type: "filterChar", ch: key.name };
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
  if (state.filter) return resolveFilterKey(key);
  if (state.overlay?.kind === "prompt") return resolvePromptKey(key);
  if (state.overlay?.kind === "confirm") return resolveConfirmKey(key);
  if (state.overlay?.kind === "permissions") return resolvePermissionsKey(key);
  if (state.overlay?.kind === "help") return resolveHelpKey(key);
  if (state.overlay?.kind === "preview") return resolvePreviewKey(key);
  if (state.overlay?.kind === "bookmarks") return resolveBookmarksKey(key);
  for (const binding of BINDINGS) {
    if (binding.matches(key)) return binding.action(key);
  }
  return null;
}
