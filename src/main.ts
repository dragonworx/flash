#!/usr/bin/env bun
// src/main.ts — flash entry point.
//
// Parses CLI flags, installs terminal crash guards, enters the full-screen
// session, and — for this phase — draws a bordered placeholder box with the
// current directory and a hint line, redrawing on resize and every
// keypress, quitting cleanly on `q` or Ctrl+C. Real navigation, views, and
// state wiring land in later phases; see
// /home/dev/.claude/plans/expressive-discovering-squid.md.
//
// The render loop is event-driven, not a fixed-rate tick: input, resize,
// and (in later phases) filesystem/progress events all just call
// `requestRepaint()`, which sets a dirty flag and schedules a single
// `draw()` on the next macrotask via `setImmediate`. Multiple triggers
// inside the same tick collapse into one repaint. This is deliberate now,
// not just here for style — Phase 5's copy/paste progress reporting fires
// many events per second from an async job, and the loop needs to already
// be "coalesce and redraw when idle" rather than "block and paint" for that
// to stay responsive. Do not replace this with `while (true) { ... }`.
//
// Usage:
//   flash [-d|--dir <path>] [--view list|grid] [--icons unicode|nerd|ascii]
//         [--hidden] [--no-color] [--dump-frame --size WxH] [--help] [--version]

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { setEnabled as setColorEnabled } from "./term/ansi.ts";
import * as caps from "./term/caps.ts";
import { Input, type Key } from "./term/input.ts";
import { ATTR_DIM, Screen } from "./term/screen.ts";
import { truncate } from "./term/width.ts";

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

// Only --dir is wired up for real in this phase. --view, --icons, --hidden,
// --no-color, --dump-frame, and --size are accepted and stored below so the
// flag surface matches the plan; later phases read them.
const config = {
  dir: resolve(process.cwd(), values.dir ?? "."),
  view: values.view,
  icons: values.icons,
  hidden: values.hidden ?? false,
  noColor: values["no-color"] ?? false,
  dumpFrame: values["dump-frame"] ?? false,
  size: values.size,
};

if (config.dumpFrame) {
  process.stderr.write(
    "flash: --dump-frame is not implemented yet (it lands with the renderer, in a later phase).\n",
  );
  process.exit(1);
}

// --no-color, NO_COLOR, and a non-TTY stdout all disable SGR the same way,
// through the one kill switch in ansi.ts — Screen checks it too, so the
// whole render path produces plain output on this branch.
if (
  config.noColor ||
  process.env.NO_COLOR !== undefined ||
  !process.stdout.isTTY
) {
  setColorEnabled(false);
}

// ── session ──

caps.installCrashGuards();
caps.enterSession();

// ── render loop: screen + input, event-driven with a coalesced repaint ──

const initialSize = caps.size();
const screen = new Screen(initialSize.columns, initialSize.rows);
const input = new Input();

function draw(): void {
  const w = Math.max(screen.columns, 1);
  const h = Math.max(screen.rows, 1);

  screen.clear();
  screen.box(0, 0, w, h, {});

  const innerWidth = Math.max(w - 4, 0);
  if (h > 1) {
    screen.put(2, 1, truncate(`flash — ${config.dir}`, innerWidth), {});
  }
  if (h > 2) {
    screen.put(2, 2, truncate("press q or Ctrl+C to quit", innerWidth), {
      attr: ATTR_DIM,
    });
  }

  screen.flush();
}

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
    draw();
  });
}

// ── input: quit on q or Ctrl+C, redraw on everything else ──
// Raw mode disables signal-generating control characters, so SIGINT is not
// delivered for Ctrl+C while the session is active — term/input.ts detects
// it in the byte stream instead (0x03 -> {name:"c", ctrl:true}).

function quit(): void {
  input.stop();
  caps.leaveSession();
  process.exit(0);
}

input.onKey((key: Key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    quit();
    return;
  }
  requestRepaint();
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
