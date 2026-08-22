// fsapi/goto.ts — read-only integration with the `goto` directory-jump tool
// (~/github/goto on this machine, or wherever `GOTO_HOME` points). flash
// never writes goto's config or usage files, only reads them.
//
// goto resolves its state directory the same way its own shell wrapper does:
// `GOTO_HOME` when set (goto.sh exports it, derived from wherever the
// sourced script actually lives, every time a shell starts), falling back to
// `~/.goto` otherwise — the same fallback goto.sh itself uses when no valid
// `GOTO_HOME` is available. flash reads the env var once; it has no shell
// script of its own to re-derive a path from the way goto.sh does.
//
// Bookmarks live in `config.json` as a plain `{ name: path }` map; last-used
// timestamps live separately in `.usage.json` as `{ name: epochMillis }`.
// `orderByLastUsed` reimplements goto's own `lib.js` function of the same
// name (most-recently-used first, stable, never-used names keep config's
// insertion order and sort after used ones) rather than importing it — goto
// is a sibling repo, not a dependency of flash. This is the exact order
// goto's own bare `goto` (no args) interactive picker lists bookmarks in.
//
// Every read here is tolerant of a missing or malformed file: no bookmarks
// yet, a GOTO_HOME that doesn't exist, or a hand-edited config.json that
// fails to parse all just yield an empty list rather than throwing.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GotoBookmark = { name: string; path: string };

export function resolveGotoHome(): string {
  return process.env.GOTO_HOME || join(homedir(), ".goto");
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** goto's `lib.js` `orderByLastUsed`, reimplemented — see the file header. */
export function orderByLastUsed(
  names: string[],
  usage: Record<string, number>,
): string[] {
  return [...names].sort((a, b) => (usage[b] || 0) - (usage[a] || 0));
}

/**
 * Every bookmark goto knows about, in the same order `goto` (no args) lists
 * them in. Never throws — see the file header.
 */
export function loadGotoBookmarks(): GotoBookmark[] {
  const home = resolveGotoHome();
  const config = readJsonObject(join(home, "config.json")) as Record<
    string,
    string
  >;
  const usage = readJsonObject(join(home, ".usage.json")) as Record<
    string,
    number
  >;
  const names = orderByLastUsed(Object.keys(config), usage);
  return names.map((name) => ({ name, path: config[name] ?? "" }));
}
