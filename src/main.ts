#!/usr/bin/env bun
// src/main.ts — flash entry point.
//
// Parses CLI flags, hardens `-d`, and either renders a single frame as plain
// text (`--dump-frame`) or enters the full-screen session and runs the
// read-only directory browser: input -> keymap -> Store -> render, wired
// into the event-driven dirty-flag loop from Phase 1. See
// /home/dev/.claude/plans/expressive-discovering-squid.md, "Phase 2".
//
// The render loop is still async and event-driven, not a fixed-rate tick —
// see the Phase 1 comment below for why that invariant matters for Phase 5.
//
// Usage:
//   flash [-d|--dir <path>] [--view list|grid] [--icons unicode|nerd|ascii]
//         [--hidden] [--no-color] [--dump-frame --size WxH] [--help] [--version]

import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { resolveAction } from "./keymap.ts";
import { Store } from "./state/store.ts";
import { setEnabled as setColorEnabled } from "./term/ansi.ts";
import * as caps from "./term/caps.ts";
import { Input, type Key } from "./term/input.ts";
import * as osc from "./term/osc.ts";
import { ATTR_DIM, Screen } from "./term/screen.ts";
import { type IconSet, colors, isIconSet } from "./term/theme.ts";
import { truncate } from "./term/width.ts";
import { renderBreadcrumb, renderStatusBar } from "./ui/chrome.ts";
import { renderListView } from "./ui/listView.ts";

// ── flag parsing ──

const USAGE = `flash [-d|--dir <path>] [--view list|grid] [--icons unicode|nerd|ascii]
      [--hidden] [--no-color] [--dump-frame --size WxH] [--help] [--version]

  -d, --dir <path>    directory to open; defaults to the current directory
      --view <mode>   initial view mode: list | grid
      --icons <set>   icon set: unicode | nerd | ascii
      --hidden        show dotfiles from the start
      --no-color      disable color (also implied by NO_COLOR or a non-TTY stdout)
      --dump-frame    render one frame as text and exit (requires --size)
      --size <WxH>    terminal size to assume for --dump-frame
  -h, --help          show this message
  -v, --version       print the version number
`;

function parseFlags() {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        dir: { type: "string", short: "d" },
        view: { type: "string" },
        icons: { type: "string" },
        hidden: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
        "dump-frame": { type: "boolean", default: false },
        size: { type: "string" },
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

const config = {
  dir: values.dir ?? ".",
  hidden: values.hidden ?? false,
  noColor: values["no-color"] ?? false,
  dumpFrame: values["dump-frame"] ?? false,
  size: values.size,
};

const viewMode: "list" | "grid" = values.view === "grid" ? "grid" : "list";

// --no-color, NO_COLOR, and a non-TTY stdout all disable SGR the same way,
// through the one kill switch in ansi.ts — Screen checks it too, so the
// whole render path produces plain output on this branch. This must run
// before anything renders, dump-frame included.
if (
  config.noColor ||
  process.env.NO_COLOR !== undefined ||
  !process.stdout.isTTY
) {
  setColorEnabled(false);
}

function fail(message: string): never {
  process.stderr.write(`flash: ${message}\n`);
  process.exit(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

const initialDir = resolveInitialDir(config.dir);

const iconsFlag = values.icons ?? "unicode";
if (!isIconSet(iconsFlag)) {
  fail(
    `invalid --icons value '${iconsFlag}' (expected unicode, nerd, or ascii)`,
  );
}
const iconSet: IconSet = iconsFlag;

const store = new Store({
  cwd: initialDir,
  showHidden: config.hidden,
  view: viewMode,
});

// ── shared layout + draw ──
// listY is fixed at row 1 (breadcrumb owns row 0); statusY is the last row.
// Both draw() and the interactive PgUp/PgDn page size below share this so
// scrolling and rendering never disagree about how tall the list is.

function computeLayout(h: number): {
  listY: number;
  listHeight: number;
  statusY: number | null;
} {
  const height = Math.max(h, 1);
  if (height === 1) return { listY: 1, listHeight: 0, statusY: null };
  const statusY = height - 1;
  const listY = 1;
  return { listY, listHeight: Math.max(statusY - listY, 0), statusY };
}

function draw(screen: Screen): void {
  const w = Math.max(screen.columns, 1);
  const h = Math.max(screen.rows, 1);
  screen.clear();

  const state = store.getState();
  renderBreadcrumb(screen, 0, 0, w, state.cwd);

  const { listY, listHeight, statusY } = computeLayout(h);
  if (listHeight > 0) {
    if (state.scanError) {
      screen.put(0, listY, truncate(`error: ${state.scanError}`, w), {
        fg: colors.error,
      });
      screen.put(
        0,
        listY + 1,
        listHeight > 1 ? truncate("press ← to go up", w) : "",
        { attr: ATTR_DIM },
      );
    } else {
      store.ensureVisible(listHeight);
      const after = store.getState();
      renderListView(
        screen,
        0,
        listY,
        w,
        listHeight,
        store.visibleEntries(),
        after.cursor,
        after.scrollTop,
        iconSet,
      );
    }
  }

  if (statusY !== null) {
    renderStatusBar(screen, 0, statusY, w, {
      itemCount: store.itemCount(),
      markedCount: state.marked.size,
      message: state.message,
    });
  }

  screen.flush();
}

// ── --dump-frame: render exactly one frame as plain text, no TTY needed ──

if (config.dumpFrame) {
  const sizeMatch = /^(\d+)x(\d+)$/.exec(config.size ?? "");
  if (!sizeMatch) fail("--dump-frame requires --size WxH, e.g. --size 80x24");
  const columns = Number(sizeMatch[1]);
  const rows = Number(sizeMatch[2]);
  if (columns <= 0 || rows <= 0)
    fail("--size must be positive, e.g. --size 80x24");

  await store.load(initialDir);
  const screen = new Screen(columns, rows, () => {}); // never actually written to
  draw(screen);
  process.stdout.write(`${screen.renderPlainText()}\n`);
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

/**
 * Mark the screen dirty and schedule exactly one `draw()` on the next
 * macrotask. Safe to call any number of times per tick — every call after
 * the first is free. See the file header for why this is event-driven
 * rather than a fixed-rate loop.
 */
function requestRepaint(): void {
  dirty = true;
  if (repaintScheduled) return;
  repaintScheduled = true;
  setImmediate(() => {
    repaintScheduled = false;
    if (!dirty) return;
    dirty = false;
    draw(screen);
  });
}

// Re-announce OSC 7/0 only when cwd actually changes, not on every repaint.
let lastAnnouncedCwd: string | null = null;
store.subscribe(() => {
  const cwd = store.getState().cwd;
  if (cwd !== lastAnnouncedCwd) {
    lastAnnouncedCwd = cwd;
    osc.announceDirectory(cwd);
  }
  requestRepaint();
});

store.load(initialDir).catch((err) => {
  store.setMessage(`failed to load directory: ${errorMessage(err)}`, "error");
});

// ── input ──

function quit(): void {
  input.stop();
  caps.leaveSession();
  process.exit(0);
}

input.onKey((key: Key) => {
  const action = resolveAction(key, store.getState());
  if (!action) return;

  switch (action.type) {
    case "moveCursor":
      store.moveCursor(action.delta);
      break;
    case "moveCursorTo":
      store.moveCursorTo(action.pos);
      break;
    case "pageMove": {
      const { listHeight } = computeLayout(screen.rows);
      store.pageMove(action.direction, Math.max(listHeight, 1));
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
    case "toggleHidden":
      store.toggleHidden();
      break;
    case "cycleSort":
      store.cycleSort();
      break;
    case "toggleSortReverse":
      store.toggleSortReverse();
      break;
    case "help":
      // Full help overlay is Phase 9 (?, generated from the keymap table);
      // this phase just confirms the key does something.
      store.setMessage("help overlay not implemented yet");
      break;
    case "quit":
      quit();
      break;
    case "closeOverlay":
    case "clearMarks":
    case "leaveArchive":
      // Unreachable in Phase 2 — no overlays, marks, or archives exist yet.
      // See keymap.ts's Escape precedence table.
      break;
  }
});

input.onFocus(() => {
  // Nothing to coalesce yet in this phase. Later phases stop repainting on
  // filesystem events while unfocused and redraw once on focus return.
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
