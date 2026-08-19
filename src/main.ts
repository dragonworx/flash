#!/usr/bin/env bun
// src/main.ts — flash entry point.
//
// Parses CLI flags, installs terminal crash guards, enters the full-screen
// session, and — for this scaffold phase — draws a static box with the
// current directory inside it, quitting cleanly on `q` or Ctrl+C. Real
// navigation, rendering, and state wiring land in later phases; see
// /home/dev/.claude/plans/expressive-discovering-squid.md.
//
// Usage:
//   flash [-d|--dir <path>] [--view list|grid] [--icons unicode|nerd|ascii]
//         [--hidden] [--no-color] [--dump-frame --size WxH] [--help] [--version]

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import * as ansi from "./term/ansi.ts";
import * as caps from "./term/caps.ts";

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

// ── session ──

caps.installCrashGuards();
caps.enterSession();

function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`;
  return text.padEnd(width, " ");
}

function render(): void {
  const { columns, rows } = caps.size();
  const w = Math.max(columns, 4);
  const h = Math.max(rows, 3);
  const innerWidth = w - 2;

  const labelLine = fitLine(` flash — ${config.dir} `, innerWidth);
  const hintLine = fitLine(" press q or Ctrl+C to quit ", innerWidth);
  const blankLine = " ".repeat(innerWidth);

  const out: string[] = [ansi.beginSyncOutput(), ansi.eraseScreen()];

  out.push(ansi.moveTo(1, 1), `┌${"─".repeat(innerWidth)}┐`);
  for (let row = 2; row < h; row++) {
    let content = blankLine;
    if (row === 2) content = labelLine;
    else if (row === 3 && h > 4) content = hintLine;
    out.push(ansi.moveTo(row, 1), `│${content}│`);
  }
  out.push(ansi.moveTo(h, 1), `└${"─".repeat(innerWidth)}┘`);

  out.push(ansi.endSyncOutput());
  process.stdout.write(out.join(""));
}

// ── input: quit on q or Ctrl+C ──
// Raw mode disables signal-generating control characters, so SIGINT is not
// delivered for Ctrl+C while the session is active — it has to be detected
// in the byte stream instead. Real key parsing lands in term/input.ts
// (Phase 1); this scaffold only needs to recognize quit.

function quit(): void {
  caps.leaveSession();
  process.exit(0);
}

process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    if (byte === 0x03 /* Ctrl+C */ || byte === 0x71 /* 'q' */) {
      quit();
      return;
    }
  }
});
process.stdin.resume();

// ── resize ──

caps.onResize(() => render());

render();
