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

/** Emit both for `path` directly to stdout — the one side effect in this file. */
export function announceDirectory(path: string): void {
  process.stdout.write(reportCwd(path) + setTitle(`flash — ${path}`));
}
