// term/theme.ts — semantic colors and the three icon columns (unicode /
// nerd / ascii). This is the one place either is allowed to live: views
// (ui/listView.ts and later ui/gridView.ts) look up a color or an icon here
// by entry kind and never branch on `--icons` themselves, per the plan's
// "Icons default to plain Unicode" decision.
//
// Colors are packed 0xRRGGBB truecolor values, the same representation
// `term/screen.ts`'s `Style.fg`/`Style.bg` expects — nothing here touches
// SGR directly, `Screen.flush()` still owns that and still honors the
// `--no-color`/`NO_COLOR`/non-TTY kill switch in `ansi.ts`.

import type { Entry } from "../fsapi/entry.ts";

// ── colors ──

export const colors = {
  dir: 0x6cb6ff,
  symlink: 0x5fd7c2,
  brokenSymlink: 0xff6b6b,
  error: 0xff6b6b,
  dim: 0x808080,
  accent: 0xe8c179,
} as const;

// ── icons ──

export type IconSet = "unicode" | "nerd" | "ascii";

export const ICON_SETS: IconSet[] = ["unicode", "nerd", "ascii"];

type IconTable = {
  dir: string;
  file: string;
  symlink: string;
  brokenSymlink: string;
  other: string;
  error: string;
};

const ICONS: Record<IconSet, IconTable> = {
  unicode: {
    dir: "📁",
    file: "📄",
    symlink: "🔗",
    brokenSymlink: "⚠",
    other: "❔",
    error: "✖",
  },
  nerd: {
    dir: "", // nf-fa-folder
    file: "", // nf-fa-file
    symlink: "", // nf-fa-link
    brokenSymlink: "", // nf-fa-chain_broken
    other: "", // nf-fa-question
    error: "", // nf-fa-warning
  },
  ascii: {
    dir: "d",
    file: "-",
    symlink: "l",
    brokenSymlink: "!",
    other: "?",
    error: "x",
  },
};

/** Look up the glyph for `entry` under `set`. Views never index ICONS themselves. */
export function iconFor(set: IconSet, entry: Entry): string {
  const table = ICONS[set];
  if (entry.error) return table.error;
  if (entry.kind === "symlink")
    return entry.broken ? table.brokenSymlink : table.symlink;
  if (entry.kind === "dir") return table.dir;
  if (entry.kind === "file") return table.file;
  return table.other;
}

/** Foreground color for `entry`, or `undefined` for the terminal's default. */
export function colorFor(entry: Entry): number | undefined {
  if (entry.error) return colors.error;
  if (entry.kind === "symlink")
    return entry.broken ? colors.brokenSymlink : colors.symlink;
  if (entry.kind === "dir") return colors.dir;
  return undefined;
}

export function isIconSet(value: string): value is IconSet {
  return (ICON_SETS as string[]).includes(value);
}
