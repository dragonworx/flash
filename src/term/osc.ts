// term/osc.ts — OSC 7 cwd reports and OSC 0 window-title, emitted on every
// directory change. herdr reads both and shows them in its sidebar (see the
// plan's "Running inside herdr"), so this earns flash about twenty lines of
// code for a first-class pane label. These are structural escape sequences
// like the cursor/screen-mode builders in ansi.ts, not SGR color, so they
// are emitted unconditionally — never gated by the `--no-color` switch.

import { hostname } from "node:os";

const OSC = "\x1b]";
const ST = "\x1b\\";

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

/** OSC 7: report the current working directory as a `file://` URL. */
export function reportCwd(path: string): string {
  return `${OSC}7;file://${safeHostname()}${encodeURI(path)}${ST}`;
}

/** OSC 0: set the window/pane title. */
export function setTitle(title: string): string {
  return `${OSC}0;${title}${ST}`;
}

/**
 * OSC 52: set the *local* clipboard to `text` (base64-encoded UTF-8 payload,
 * per the spec). This is the only clipboard mechanism that works on a
 * headless server: the sequence travels back over SSH like any other output
 * and the terminal emulator on the *client* machine intercepts it and writes
 * its own clipboard — nothing runs on the server beyond this one write.
 * Terminals that don't support OSC 52 (or have it disabled) silently ignore
 * it, so emitting it is always safe; `xclip`/`xsel`/`wl-copy` are
 * deliberately not tried — there is no X11/Wayland on the servers this
 * targets, and shelling out would break the zero-runtime-dependency rule.
 */
export function setClipboard(text: string): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  return `${OSC}52;c;${payload}${ST}`;
}

/** Emit `setClipboard(text)` directly to stdout — the other side effect in this file. */
export function copyTextToClipboard(text: string): void {
  process.stdout.write(setClipboard(text));
}

/** Emit both for `path` directly to stdout — the one side effect in this file. */
export function announceDirectory(path: string): void {
  process.stdout.write(reportCwd(path) + setTitle(`flash — ${path}`));
}
