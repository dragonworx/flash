#!/usr/bin/env bun
// src/main.ts — flash entry point.
//
// Parses CLI flags, hardens `-d`, and either renders a single frame as plain
// text or real ANSI (`--dump-frame`) or enters the full-screen session and
// runs the browser: input -> keymap -> Store -> render, wired into the
// event-driven dirty-flag loop from Phase 1. See
// /home/dev/.claude/plans/expressive-discovering-squid.md, "Phase 3" and the
// visual-design/grid/config-persistence expansion of it, plus "Phase 4"
// (selection and clipboard) for the mark/copy/cut wiring below.
//
// The render loop is still async and event-driven, not a fixed-rate tick —
// see the Phase 1 comment below for why that invariant matters for Phase 5.
//
// Usage:
//   flash [-d|--dir <path>] [--view list|grid] [--icons unicode|nerd|ascii]
//         [--hidden] [--no-color] [--dump-frame --size WxH [--color]]
//         [--help] [--version]

import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import {
  type Config,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
} from "./config.ts";
import { isBusy } from "./fsapi/ops/queue.ts";
import { FsWatcher } from "./fsapi/watch.ts";
import { resolveAction } from "./keymap.ts";
import type { ViewMode } from "./state/store.ts";
import { Store } from "./state/store.ts";
import { setEnabled as setColorEnabled } from "./term/ansi.ts";
import * as caps from "./term/caps.ts";
import { Input, type Key } from "./term/input.ts";
import * as osc from "./term/osc.ts";
import { ATTR_DIM, Screen } from "./term/screen.ts";
import { type IconSet, colors, isIconSet } from "./term/theme.ts";
import { truncate } from "./term/width.ts";
import {
  computeFrame,
  renderBanner,
  renderRule,
  renderStatusBar,
} from "./ui/chrome.ts";
import {
  clampGridScroll,
  computeGridLayout,
  gridRowCount,
  moveGridCursor,
  renderGridView,
} from "./ui/gridView.ts";
import {
  computeListLayout,
  renderListHeader,
  renderListView,
} from "./ui/listView.ts";
import { renderConfirmOverlay } from "./ui/overlay/confirm.ts";
import { maxHelpScroll, renderHelpOverlay } from "./ui/overlay/help.ts";
import { renderPermissionsOverlay } from "./ui/overlay/permissions.ts";
import { renderProgressOverlay } from "./ui/overlay/progress.ts";
import { renderPromptOverlay } from "./ui/overlay/prompt.ts";

// ── flag parsing ──

const USAGE = `flash [-d|--dir <path>] [--view list|grid] [--icons unicode|nerd|ascii]
      [--hidden] [--no-color] [--dump-frame --size WxH [--color] [--open <name>]]
      [--help] [--version]

  -d, --dir <path>    directory to open; defaults to the current directory
      --view <mode>   initial view mode: list | grid
      --icons <set>   icon set: unicode | nerd | ascii
      --hidden        show dotfiles from the start
      --no-color      disable color (also implied by NO_COLOR or a non-TTY stdout)
      --dump-frame    render one frame as text and exit (requires --size)
      --size <WxH>    terminal size to assume for --dump-frame
      --color         with --dump-frame, emit real ANSI instead of plain text
      --open <name>   with --dump-frame, enter() the named child before rendering —
                       e.g. a .zip fixture, so the frame captures browsing inside it
  -h, --help          show this message
  -v, --version       print the version number
`;

function parseFlags() {
  try {
    const { values } = parseArgs({
      // `process.argv`, not `Bun.argv` — identical under Bun, but `Bun` is
      // not a global under the npm/Node distribution path `dist/flash.js`
      // targets (see build.ts), and this line runs before anything has had
      // a chance to fall back.
      args: process.argv.slice(2),
      options: {
        dir: { type: "string", short: "d" },
        view: { type: "string" },
        icons: { type: "string" },
        // No `default: false` here: `undefined` means "not passed", which
        // is what lets a config-file value show through when the flag was
        // never given (see `resolveEffectiveConfig` below). `--hidden` can
        // still only ever *set* the flag true from the CLI — there is no
        // `--no-hidden` — so undefined-vs-true is all that's needed.
        hidden: { type: "boolean" },
        "no-color": { type: "boolean", default: false },
        "dump-frame": { type: "boolean", default: false },
        size: { type: "string" },
        color: { type: "boolean", default: false },
        open: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    return values;
  } catch (err) {
    process.stderr.write(
      `flash: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`,
    );
    process.exit(1);
  }
}

const values = parseFlags();

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (values.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const cliConfig = {
  dir: values.dir ?? ".",
  noColor: values["no-color"] ?? false,
  dumpFrame: values["dump-frame"] ?? false,
  size: values.size,
  color: values.color ?? false,
  open: values.open,
};

function fail(message: string): never {
  process.stderr.write(`flash: ${message}\n`);
  process.exit(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── config: file <- CLI flags, per the plan's "flags win" rule ──
//
// `--dump-frame` deliberately never touches the real config file — it is
// used heavily by the test suite (tests/dump-frame.test.ts spawns the real
// CLI repeatedly) and reading or writing `~/.config/flash/config.json` from
// there would make snapshot output depend on whatever is on the machine
// running the tests, and would leave writes behind. It gets `DEFAULT_CONFIG`
// merged with flags only, same shape, zero disk I/O.
const fileConfig: Config = cliConfig.dumpFrame
  ? { ...DEFAULT_CONFIG }
  : await loadConfig();

const effectiveView: ViewMode =
  values.view === "grid" || values.view === "list"
    ? values.view
    : fileConfig.view;
const effectiveHidden = values.hidden === true ? true : fileConfig.showHidden;
const iconsFlag = values.icons ?? fileConfig.icons;
if (!isIconSet(iconsFlag)) {
  fail(
    `invalid --icons value '${iconsFlag}' (expected unicode, nerd, or ascii)`,
  );
}
const iconSet: IconSet = iconsFlag;

// --no-color, NO_COLOR, and a non-TTY stdout all disable SGR the same way,
// through the one kill switch in ansi.ts — Screen checks it too, so the
// whole render path produces plain output on this branch. This must run
// before anything renders, dump-frame included. `--dump-frame --color`
// (see Part 1 of the visual-design pass) is the one deliberate override: it
// exists specifically to inspect real ANSI output without a TTY, so it
// skips the non-TTY auto-disable that would otherwise always win here.
const forceColorForDump = cliConfig.dumpFrame && cliConfig.color;
if (
  !forceColorForDump &&
  (cliConfig.noColor ||
    process.env.NO_COLOR !== undefined ||
    !process.stdout.isTTY)
) {
  setColorEnabled(false);
}

/**
 * Harden `-d` per the plan: resolve relative-or-absolute against cwd,
 * `realpath` it (so a dangling symlink or a typo fails here, not three
 * screens deep into the app), and require a readable directory. Any
 * failure prints a clear message and exits non-zero rather than opening
 * something unexpected.
 */
function resolveInitialDir(raw: string): string {
  const resolved = resolve(process.cwd(), raw);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch (err) {
    return fail(`cannot access '${raw}': ${errorMessage(err)}`);
  }
  let isDir: boolean;
  try {
    isDir = statSync(real).isDirectory();
  } catch (err) {
    return fail(`cannot access '${raw}': ${errorMessage(err)}`);
  }
  if (!isDir) return fail(`'${raw}' is not a directory`);
  try {
    accessSync(real, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return fail(`'${raw}' is not readable`);
  }
  return real;
}

const initialDir = resolveInitialDir(cliConfig.dir);

const store = new Store({
  cwd: initialDir,
  showHidden: effectiveHidden,
  view: effectiveView,
  sort: fileConfig.sort,
});

/** Snapshot the store + iconSet into the shape config.ts persists. */
function currentConfig(): Config {
  const state = store.getState();
  return {
    view: state.view,
    sort: state.sort,
    showHidden: state.showHidden,
    icons: iconSet,
  };
}

/**
 * Fire-and-forget config write, called after every in-app change to view,
 * sort, or hidden-file visibility — never on exit, since the process can be
 * SIGKILLed and would never get to run an exit-time save. A write failure
 * (disk full, permissions) surfaces as a transient status message rather
 * than crashing the session.
 */
function persistConfig(): void {
  if (cliConfig.dumpFrame) return; // see the file-config comment above
  saveConfig(currentConfig()).catch((err) =>
    store.setMessage(`failed to save config: ${errorMessage(err)}`, "error"),
  );
}

// A CLI flag that overrode the file (e.g. `--hidden` on a machine whose
// config remembers hidden files off) is remembered for next time, exactly
// like an in-app toggle — flags win this run, but don't get silently
// forgotten if the user runs bare `flash` again next time expecting it.
if (
  !cliConfig.dumpFrame &&
  (effectiveView !== fileConfig.view ||
    effectiveHidden !== fileConfig.showHidden ||
    iconSet !== fileConfig.icons)
) {
  persistConfig();
}

// ── shared layout + draw ──
// `computeFrame` (ui/chrome.ts) decides which chrome elements exist this
// frame and which row each lives on; draw() and the interactive PgUp/PgDn
// page size below both read `frame.listHeight` from it, so scrolling and
// rendering never disagree about how tall the list is.

// Grid scrolling is measured in *grid rows*, not entries (many entries
// share a row) — see ui/gridView.ts's `clampGridScroll`. It lives outside
// Store because Store's `scrollTop` is list-view index space; this is
// view-specific presentation state, reset whenever the directory or view
// changes so a stale offset from a taller grid never leaks into a new one.
let gridScrollRow = 0;

function draw(screen: Screen): void {
  const w = Math.max(screen.columns, 1);
  const h = Math.max(screen.rows, 1);
  screen.clear();

  const state = store.getState();
  const frame = computeFrame(w, h, state.view);

  renderBanner(screen, w, frame, state.cwd, state.archive);
  const listEntries = state.view === "list" ? store.visibleEntries() : [];
  // Computed once and threaded through both the header and the row
  // rendering below — never recomputed separately — so the two can never
  // disagree about where a column starts (see ui/listView.ts's file
  // header).
  const listLayout = state.view === "list" ? computeListLayout(w) : null;
  if (frame.headerY !== null && listLayout !== null) {
    renderListHeader(screen, 0, frame.headerY, listLayout);
  }
  if (frame.headerRuleY !== null) renderRule(screen, frame.headerRuleY, w);

  if (frame.listHeight > 0) {
    if (state.scanError) {
      screen.put(0, frame.listY, truncate(`error: ${state.scanError}`, w), {
        fg: colors.error,
      });
      screen.put(
        0,
        frame.listY + 1,
        frame.listHeight > 1 ? truncate("press ← to go up", w) : "",
        { attr: ATTR_DIM },
      );
    } else if (state.view === "grid") {
      const entries = store.visibleEntries();
      const layout = computeGridLayout(
        w,
        entries.map((e) => e.width),
      );
      const rows = gridRowCount(entries.length, layout.columns);
      const cursorRow = layout.columns > 0 ? state.cursor % rows : 0;
      gridScrollRow = clampGridScroll(
        gridScrollRow,
        cursorRow,
        frame.listHeight,
        rows,
      );
      renderGridView(
        screen,
        0,
        frame.listY,
        w,
        frame.listHeight,
        entries,
        state.cursor,
        gridScrollRow,
        iconSet,
        state.marked,
        state.clipboard,
      );
    } else if (listLayout !== null) {
      store.ensureVisible(frame.listHeight);
      const after = store.getState();
      renderListView(
        screen,
        0,
        frame.listY,
        w,
        frame.listHeight,
        listEntries,
        after.cursor,
        after.scrollTop,
        listLayout,
        iconSet,
        after.marked,
        after.clipboard,
      );
    }
  }

  if (frame.footerRuleY !== null) renderRule(screen, frame.footerRuleY, w);
  if (frame.statusY !== null) {
    renderStatusBar(screen, 0, frame.statusY, w, {
      itemCount: store.itemCount(),
      markedCount: state.marked.size,
      clipboard: state.clipboard,
      message: state.message,
    });
  }

  // Drawn last so it sits on top of the list/chrome underneath, per the
  // plan's "progress overlay drawn over the file list." Only one overlay is
  // ever open at once (`state.overlay` is a single field), so this is an
  // if/else-if chain, not independent checks.
  if (state.overlay?.kind === "progress") {
    renderProgressOverlay(screen, w, h, state.overlay, iconSet === "ascii");
  } else if (state.overlay?.kind === "prompt") {
    const promptTitle =
      state.overlay.mode === "rename"
        ? "Rename"
        : state.overlay.mode === "mkdir"
          ? "New directory"
          : "New archive";
    renderPromptOverlay(screen, w, h, {
      title: promptTitle,
      value: state.overlay.value,
      cursor: state.overlay.cursor,
      error: state.overlay.error,
    });
  } else if (state.overlay?.kind === "confirm") {
    renderConfirmOverlay(screen, w, h, state.overlay.message);
  } else if (state.overlay?.kind === "permissions") {
    const paths = state.overlay.paths;
    const targetLabel =
      paths.length === 1 ? basename(paths[0] ?? "") : `${paths.length} items`;
    renderPermissionsOverlay(screen, w, h, {
      targetLabel,
      rwxBits: state.overlay.rwxBits,
      specialBits: state.overlay.specialBits,
      specialExplicit: state.overlay.specialExplicit,
      focus: state.overlay.focus,
      error: state.overlay.error,
    });
  } else if (state.overlay?.kind === "help") {
    renderHelpOverlay(screen, w, h, state.overlay.scrollOffset);
  }

  screen.flush();
}

// ── --dump-frame: render exactly one frame and exit, no TTY needed ──
//
// Plain text by default (`Screen.renderPlainText()`), or the real ANSI
// frame with `--color` (see the visual-design pass's Part 1) — the same
// collector-sink pattern `tests/screen.test.ts` already uses to keep raw
// escapes out of the test runner's own output, just used here to capture
// them on purpose instead of discarding them.

if (cliConfig.dumpFrame) {
  const sizeMatch = /^(\d+)x(\d+)$/.exec(cliConfig.size ?? "");
  if (!sizeMatch) fail("--dump-frame requires --size WxH, e.g. --size 80x24");
  const columns = Number(sizeMatch[1]);
  const rows = Number(sizeMatch[2]);
  if (columns <= 0 || rows <= 0)
    fail("--size must be positive, e.g. --size 80x24");

  await store.load(initialDir);
  if (cliConfig.open) {
    const idx = store
      .visibleEntries()
      .findIndex((e) => e.name === cliConfig.open);
    if (idx < 0)
      fail(`--open '${cliConfig.open}': no such entry in '${initialDir}'`);
    store.setCursorIndex(idx);
    await store.enter();
  }
  const chunks: string[] = [];
  const screen = new Screen(
    columns,
    rows,
    forceColorForDump ? (chunk: string) => chunks.push(chunk) : () => {},
  );
  draw(screen);
  const output = forceColorForDump ? chunks.join("") : screen.renderPlainText();
  process.stdout.write(`${output}\n`);
  process.exit(0);
}

// ── interactive session ──

caps.installCrashGuards();
caps.enterSession();

const initialSize = caps.size();
const screen = new Screen(initialSize.columns, initialSize.rows);
const input = new Input();

let dirty = false;
let repaintScheduled = false;
// Phase 6: herdr enables focus reporting for every pane it spawns and
// optimizes against panes that repaint while hidden (see the plan's herdr
// section). `paneFocused` starts true — herdr's own initial focus event, if
// any, only ever narrows this, and a plain terminal that never sends focus
// events at all should behave exactly as before (always paint).
let paneFocused = true;

/**
 * Mark the screen dirty and schedule exactly one `draw()` on the next
 * macrotask. Safe to call any number of times per tick — every call after
 * the first is free. See the file header for why this is event-driven
 * rather than a fixed-rate loop.
 *
 * While the pane is unfocused the scheduled callback below leaves `dirty`
 * set instead of clearing it, so any number of filesystem-triggered
 * repaints while hidden collapse into the single `draw()` that runs the
 * moment focus returns (see `input.onFocus` below), rather than each firing
 * its own wasted write to a pane nobody can see.
 */
function requestRepaint(): void {
  dirty = true;
  if (repaintScheduled) return;
  repaintScheduled = true;
  setImmediate(() => {
    repaintScheduled = false;
    if (!dirty || !paneFocused) return;
    dirty = false;
    draw(screen);
  });
}

// Re-announce OSC 7/0 only when cwd actually changes, not on every repaint,
// and reset the grid scroll offset then too — a stale offset from the
// previous directory's (possibly much taller) grid must not leak in. The
// watcher (below) also only needs re-arming on a real cwd change, so this
// same check drives its `retarget()` call.
let lastAnnouncedCwd: string | null = null;
store.subscribe(() => {
  const cwd = store.getState().cwd;
  if (cwd !== lastAnnouncedCwd) {
    lastAnnouncedCwd = cwd;
    gridScrollRow = 0;
    osc.announceDirectory(cwd);
    watcher.retarget(cwd);
  }
  requestRepaint();
});

// ── live updates (Phase 6) ──
//
// One fs.watch on the directory currently on screen, never recursive — see
// fsapi/watch.ts's file header for the three verified failure modes this
// wraps around. `suppressed` is checked by the watcher itself before every
// settle: a running paste/cut job generates its own storm of events in the
// destination directory, and state/store.ts's paste()/runCut() already
// reload the directory once the job finishes, so there is nothing this
// watcher needs to do while one is in flight.
const watcher = new FsWatcher(
  initialDir,
  {
    onSettle(dir, walkedUp) {
      if (walkedUp) {
        // The directory we were sitting in is gone; `dir` is the nearest
        // surviving ancestor. This is a navigation, not an in-place
        // refresh, so it goes through load() (cursor history, OSC
        // announce via the subscribe block above) exactly like `up()`
        // would, not refresh().
        store.setMessage(
          "this directory no longer exists — moved up to a surviving ancestor",
          "error",
        );
        store.load(dir).catch((err) => {
          store.setMessage(errorMessage(err), "error");
        });
      } else {
        store.refresh(dir).catch((err) => {
          store.setMessage(errorMessage(err), "error");
        });
      }
    },
  },
  { suppressed: () => isBusy() },
);
caps.onTeardown(() => watcher.close());

store.load(initialDir).catch((err) => {
  store.setMessage(`failed to load directory: ${errorMessage(err)}`, "error");
});

// ── input ──

function quit(): void {
  input.stop();
  caps.leaveSession();
  process.exit(0);
}

/**
 * Resolve a `navigate` action against the current view. List mode
 * reproduces Phase 2's original arrow behavior exactly (up/down move the
 * cursor, left goes up a directory, right enters); grid mode moves the
 * cursor geometrically via `moveGridCursor`, which needs the current grid
 * layout — only known here, where terminal width is available (keymap.ts
 * has no access to it, see the Action's comment).
 */
function handleNavigate(dir: "up" | "down" | "left" | "right"): void {
  const state = store.getState();
  if (state.view === "list") {
    if (dir === "up") store.moveCursor(-1);
    else if (dir === "down") store.moveCursor(1);
    else if (dir === "left")
      store.up().catch((err) => store.setMessage(errorMessage(err), "error"));
    else
      store
        .enter()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
    return;
  }

  const entries = store.visibleEntries();
  const layout = computeGridLayout(
    Math.max(screen.columns, 1),
    entries.map((e) => e.width),
  );
  if (layout.columns === 0) return;
  const rows = gridRowCount(entries.length, layout.columns);
  const next = moveGridCursor(
    state.cursor,
    entries.length,
    layout.columns,
    rows,
    dir,
  );
  store.setCursorIndex(next);
}

input.onKey((key: Key) => {
  const action = resolveAction(key, store.getState());
  if (!action) return;

  switch (action.type) {
    case "navigate":
      handleNavigate(action.dir);
      break;
    case "moveCursor":
      store.moveCursor(action.delta);
      break;
    case "moveCursorTo":
      store.moveCursorTo(action.pos);
      break;
    case "pageMove": {
      const frame = computeFrame(
        Math.max(screen.columns, 1),
        Math.max(screen.rows, 1),
        store.getState().view,
      );
      store.pageMove(action.direction, Math.max(frame.listHeight, 1));
      break;
    }
    case "enter":
      store
        .enter()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "up":
      store.up().catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "toggleView":
      store.toggleView();
      persistConfig();
      break;
    case "toggleHidden":
      store.toggleHidden();
      persistConfig();
      break;
    case "cycleSort":
      store.cycleSort();
      persistConfig();
      break;
    case "toggleSortReverse":
      store.toggleSortReverse();
      persistConfig();
      break;
    case "help":
      store.startHelp();
      break;
    case "helpScroll":
      store.helpScroll(
        action.delta,
        maxHelpScroll(Math.max(screen.columns, 1), Math.max(screen.rows, 1)),
      );
      break;
    case "quit":
      quit();
      break;
    case "toggleMark":
      store.toggleMarkAtCursor();
      break;
    case "extendSelection":
      store.extendSelection(action.dir);
      break;
    case "markAll":
      store.markAll();
      break;
    case "copy":
      store.copy();
      break;
    case "cut":
      store.cut();
      break;
    case "paste":
      store
        .paste()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "clearMarks":
      store.clearMarks();
      break;
    case "closeOverlay": {
      // A progress overlay (paste/cut/delete) closing means cancelling the
      // in-flight job, not a bare dismiss — `cancelOperation()` aborts
      // whichever of paste's/delete's AbortControllers `state/store.ts` has
      // staged. Every other overlay just closes.
      const overlay = store.getState().overlay;
      if (overlay?.kind === "progress") store.cancelOperation();
      else if (overlay?.kind === "prompt") store.cancelPrompt();
      else if (overlay?.kind === "confirm") store.cancelDelete();
      else if (overlay?.kind === "permissions") store.cancelPermissions();
      else if (overlay?.kind === "help") store.closeHelp();
      break;
    }
    case "startRename":
      store.startRename();
      break;
    case "startMkdir":
      store.startMkdir();
      break;
    case "promptChar":
      store.promptInsertChar(action.ch);
      break;
    case "promptBackspace":
      store.promptBackspace();
      break;
    case "promptDeleteForward":
      store.promptDeleteForward();
      break;
    case "promptLeft":
      store.promptMoveLeft();
      break;
    case "promptRight":
      store.promptMoveRight();
      break;
    case "promptHome":
      store.promptMoveHome();
      break;
    case "promptEnd":
      store.promptMoveEnd();
      break;
    case "promptWordDelete":
      store.promptDeleteWordBack();
      break;
    case "promptClearToStart":
      store.promptClearToStart();
      break;
    case "promptSubmit":
      store
        .submitPrompt()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "startDelete":
      store
        .startDelete()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "confirmYes":
      store
        .confirmDelete()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "confirmCancel":
      store.cancelDelete();
      break;
    case "startPermissions":
      store.startPermissions();
      break;
    case "permMoveFocus":
      store.permMoveFocus(action.dir);
      break;
    case "permToggle":
      store.permToggle();
      break;
    case "permDigit":
      store.permDigit(action.digit);
      break;
    case "permApply":
      store
        .applyPermissions()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "startArchive":
      store.startArchive();
      break;
    case "startExtract":
      store
        .startExtract()
        .catch((err) => store.setMessage(errorMessage(err), "error"));
      break;
    case "leaveArchive":
      store.leaveArchive();
      break;
  }
});

input.onFocus((focused) => {
  paneFocused = focused;
  // On focus-out this just leaves `dirty` set for whenever focus returns
  // (see requestRepaint's own comment). On focus-in it's what actually
  // flushes a single repaint covering everything that changed underneath
  // the pane while it was hidden.
  requestRepaint();
});

input.start();
process.stdin.resume();

// ── resize ──
// SIGWINCH fires constantly under herdr (pane splits, zoom, sidebar
// toggles), not just on a real window resize, so it is debounced before
// touching the screen buffers.

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

caps.onResize(() => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const size = caps.size();
    screen.resize(size.columns, size.rows);
    requestRepaint();
  }, 50);
});

requestRepaint();
