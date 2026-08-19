// config.ts — persisted user preferences: view mode, sort spec, hidden-file
// visibility, and icon set. `main.ts` reads this at startup (CLI flags win
// over the file — see `resolveEffectiveConfig` below) and calls
// `saveConfig()` after each in-app change to one of these four things,
// never on exit, since the process can be SIGKILLed and never gets a
// chance to run exit handlers (see term/caps.ts's file header for the same
// lesson learned the hard way about crash paths).
//
// Path resolution never touches `import.meta.dir`: inside a `bun build
// --compile` binary that path is `/$bunfs/root`, not a real directory on
// disk. `os.homedir()` is the only safe source of "where does this user's
// home directory live" — see the plan's Phase 3 and packaging sections.
//
// A missing or corrupt config file is never fatal. `loadConfig()` falls
// back to `DEFAULT_CONFIG` wholesale on a read/parse failure, and
// `sanitize()` falls back field-by-field on a well-formed-JSON-but-wrong-
// shape file (e.g. a hand edit that typos `"view": "gird"`), so one bad
// field never takes the other three down with it.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SORT, type SortSpec } from "./fsapi/scan.ts";
import type { ViewMode } from "./state/store.ts";
import { type IconSet, isIconSet } from "./term/theme.ts";

// ── shape ──

export type Config = {
  view: ViewMode;
  sort: SortSpec;
  showHidden: boolean;
  icons: IconSet;
};

export const DEFAULT_CONFIG: Config = {
  view: "list",
  sort: DEFAULT_SORT,
  showHidden: false,
  icons: "unicode",
};

// ── path ──
// `$XDG_CONFIG_HOME/flash/config.json`, falling back to `~/.config/flash`.

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "flash");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

// ── validation ──
// Never trust the file blindly — a hand-edited or half-written config.json
// must not crash the app or inject a bogus enum value into AppState.

const SORT_KEY_VALUES = new Set(["name", "size", "mtime", "extension"]);

function isSortSpec(value: unknown): value is SortSpec {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    SORT_KEY_VALUES.has(v.key) &&
    typeof v.dirsFirst === "boolean" &&
    typeof v.reverse === "boolean"
  );
}

function sanitize(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const v = raw as Record<string, unknown>;
  return {
    view: v.view === "grid" || v.view === "list" ? v.view : DEFAULT_CONFIG.view,
    sort: isSortSpec(v.sort) ? v.sort : DEFAULT_CONFIG.sort,
    showHidden:
      typeof v.showHidden === "boolean"
        ? v.showHidden
        : DEFAULT_CONFIG.showHidden,
    icons:
      typeof v.icons === "string" && isIconSet(v.icons)
        ? v.icons
        : DEFAULT_CONFIG.icons,
  };
}

// ── load / save ──

/**
 * Read the config file and return sanitized values, falling back to
 * `DEFAULT_CONFIG` (whole or per-field, via `sanitize`) on any error —
 * missing file, unreadable, or invalid JSON. Never throws.
 */
export async function loadConfig(): Promise<Config> {
  try {
    const text = await readFile(configPath(), "utf8");
    return sanitize(JSON.parse(text));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Write `config` atomically: serialize to a temp file in the same
 * directory, then `rename()` over the real path. A crash or SIGKILL
 * mid-write leaves either the old file intact or the new one complete,
 * never a half-written config.json — `rename()` on the same filesystem is
 * atomic. The temp name includes random bytes so two flash processes
 * racing to save (unlikely, but cheap to make safe) never collide.
 */
export async function saveConfig(config: Config): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  const target = configPath();
  const tmp = join(dir, `.config.json.${randomBytes(6).toString("hex")}.tmp`);
  const json = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(tmp, json, "utf8");
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
