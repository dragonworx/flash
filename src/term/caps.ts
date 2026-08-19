// term/caps.ts — enter/leave the full-screen terminal session, and survive
// crashing while inside it.
//
// This is the most important file in the scaffold. Every phase after this
// one repaints the whole screen while stdin is in raw mode; if the process
// dies without undoing that, the user is left with an unusable shell — no
// cursor, no scrollback discipline, raw keystrokes going nowhere. So:
//
//   - `enterSession()` / `leaveSession()` are exact opposites, and
//     `leaveSession()` is idempotent — safe to call twice, safe to call
//     before `enterSession()` ever ran.
//   - `installCrashGuards()` wires `leaveSession()` into every way this
//     process can stop: SIGINT, SIGTERM, a plain `exit`, and an uncaught
//     exception. The terminal is always restored *before* anything else
//     happens (printing the error, choosing an exit code).
//   - `process.stdin.setRawMode` is `undefined` when stdin is not a TTY
//     (piped input, CI, this very environment). Calling it would throw
//     "setRawMode is not a function"; instead `enterSession()` checks first
//     and exits with a clear message.
//
// Usage:
//   import { enterSession, leaveSession, installCrashGuards, size, onResize } from "./caps.ts";
//   installCrashGuards();
//   enterSession();
//   // ... draw, read input ...
//   leaveSession();

import * as ansi from "./ansi.ts";

// ── session state ──

let sessionActive = false;

function write(seq: string): void {
  process.stdout.write(seq);
}

/**
 * Enter the full-screen session: alternate screen, hidden cursor, raw stdin,
 * focus reporting on. Exits the process with a clear message if stdin is not
 * a TTY, rather than crashing on a missing `setRawMode`.
 */
export function enterSession(): void {
  if (sessionActive) return;

  if (typeof process.stdin.setRawMode !== "function") {
    process.stderr.write(
      "flash: stdin is not a TTY, so it cannot enter an interactive session.\n" +
        "Run flash directly in a terminal (not piped or redirected).\n",
    );
    process.exit(1);
  }

  write(ansi.enterAltScreen());
  write(ansi.hideCursor());
  process.stdin.setRawMode(true);
  write(ansi.enableFocusReporting());
  sessionActive = true;
}

/**
 * Leave the full-screen session, in the exact reverse order of entry.
 * Idempotent: calling this when no session is active does nothing.
 */
export function leaveSession(): void {
  if (!sessionActive) return;
  sessionActive = false;

  write(ansi.disableFocusReporting());
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false);
  }
  write(ansi.showCursor());
  write(ansi.exitAltScreen());
}

// ── crash guards ──

let guardsInstalled = false;

/**
 * Register terminal restoration on every path this process can stop:
 * SIGINT, SIGTERM, a normal `exit`, and an uncaught exception. Safe to call
 * more than once — only the first call wires anything up.
 */
export function installCrashGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  process.on("SIGINT", () => {
    leaveSession();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    leaveSession();
    process.exit(0);
  });

  process.on("exit", () => {
    leaveSession();
  });

  process.on("uncaughtException", (err) => {
    leaveSession();
    // Restore the terminal first, then report — otherwise the stack trace
    // scrolls off inside the alternate screen buffer and the user never
    // sees it.
    process.stderr.write(`flash: uncaught exception\n${errorDetail(err)}\n`);
    process.exit(1);
  });
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// ── size + resize ──

export type Size = { columns: number; rows: number };

const FALLBACK_SIZE: Size = { columns: 80, rows: 24 };

/**
 * Current terminal size, read from the pty (never from `$COLUMNS`/`$LINES`,
 * which multiplexers like herdr do not export). Falls back to 80x24 when
 * stdout is not a TTY, where `.columns`/`.rows` are `undefined`.
 */
export function size(): Size {
  const columns = process.stdout.columns;
  const rows = process.stdout.rows;
  return {
    columns:
      typeof columns === "number" && columns > 0
        ? columns
        : FALLBACK_SIZE.columns,
    rows: typeof rows === "number" && rows > 0 ? rows : FALLBACK_SIZE.rows,
  };
}

/**
 * Subscribe to terminal resizes (SIGWINCH). Fires for every pty resize, not
 * just a real window resize — pane splits, zoom toggles, sidebar collapse
 * under herdr all count. Callers that repaint on every event should debounce.
 * Returns an unsubscribe function.
 */
export function onResize(cb: (size: Size) => void): () => void {
  const handler = () => cb(size());
  process.on("SIGWINCH", handler);
  return () => {
    process.off("SIGWINCH", handler);
  };
}
