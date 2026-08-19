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
//     process can stop: `exit`, `uncaughtException`, `unhandledRejection`,
//     SIGINT, SIGTERM, SIGHUP, and SIGQUIT. The terminal is always restored
//     *before* anything else happens (printing the error, choosing an exit
//     code).
//   - Verified on this machine: `process.on("exit")` does **not** fire when
//     Bun is killed by SIGTERM, so `leaveSession()` cannot be left to that
//     handler alone. Every terminating signal calls it directly and then
//     exits itself; `exit` stays wired as a last-resort net for exit paths
//     this file didn't anticipate, and stays idempotent so that's safe.
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
  // herdr turns bracketed paste on for every pane it spawns; flash has no
  // use for it and disables it defensively rather than trusting it stays
  // off (see ansi.ts and term/input.ts).
  write(ansi.disableBracketedPaste());
  sessionActive = true;
}

/**
 * Leave the full-screen session, in the exact reverse order of entry.
 * Idempotent: calling this when no session is active does nothing.
 */
export function leaveSession(): void {
  if (!sessionActive) return;
  sessionActive = false;

  write(ansi.disableBracketedPaste());
  write(ansi.disableFocusReporting());
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false);
  }
  // Reset SGR state before leaving the alt screen — otherwise a colored
  // cell left active at crash time can bleed into the restored shell.
  write(ansi.reset());
  write(ansi.showCursor());
  write(ansi.exitAltScreen());
}

// ── crash guards ──

let guardsInstalled = false;

/**
 * Register terminal restoration on every path this process can stop: a
 * normal `exit`, an uncaught exception or rejection, and SIGINT/SIGTERM/
 * SIGHUP/SIGQUIT. Safe to call more than once — only the first call wires
 * anything up.
 *
 * Every signal below restores the terminal and exits itself, rather than
 * relying on the `exit` handler to do it — `process.on("exit")` does not
 * fire when Bun is killed by SIGTERM (verified on this machine), so a
 * SIGTERM'd flash would otherwise strand the user with a hidden cursor in
 * the alternate screen. `exit` stays registered as a last-resort net for
 * any exit path this file didn't anticipate.
 */
export function installCrashGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  const terminatingSignal = (signal: NodeJS.Signals, code: number) => {
    process.on(signal, () => {
      leaveSession();
      process.exit(code);
    });
  };

  // Exit codes follow the usual 128+signal convention.
  terminatingSignal("SIGINT", 130);
  terminatingSignal("SIGTERM", 143);
  terminatingSignal("SIGHUP", 129);
  terminatingSignal("SIGQUIT", 131);

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

  process.on("unhandledRejection", (reason) => {
    leaveSession();
    process.stderr.write(
      `flash: unhandled rejection\n${errorDetail(reason)}\n`,
    );
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
const MIN_DIMENSION = 1;

function envDimension(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Current terminal size, read primarily from the pty (herdr does not export
 * `$COLUMNS`/`$LINES` at all). `process.stdout.columns`/`.rows` have been
 * observed as both `undefined` (piped stdout) and `0` (one pty
 * configuration) on this machine, so a non-positive reading falls through
 * to `$COLUMNS`/`$LINES` when set, then to 80x24. The result is always
 * floored at 1 so a degenerate terminal can never produce a negative
 * layout width downstream.
 */
export function size(): Size {
  const columns = process.stdout.columns;
  const rows = process.stdout.rows;
  const resolvedColumns =
    (typeof columns === "number" && columns > 0 ? columns : undefined) ??
    envDimension("COLUMNS") ??
    FALLBACK_SIZE.columns;
  const resolvedRows =
    (typeof rows === "number" && rows > 0 ? rows : undefined) ??
    envDimension("LINES") ??
    FALLBACK_SIZE.rows;
  return {
    columns: Math.max(MIN_DIMENSION, resolvedColumns),
    rows: Math.max(MIN_DIMENSION, resolvedRows),
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
