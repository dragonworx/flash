// term/theme.ts — semantic colors and the three icon columns (unicode /
// nerd / ascii). This is the one place either is allowed to live: views
// (ui/listView.ts and ui/gridView.ts) look up a color or an icon here by
// entry kind/category and never branch on `--icons` themselves, per the
// plan's "Icons default to plain Unicode" decision.
//
// Colors are packed 0xRRGGBB truecolor values, the same representation
// `term/screen.ts`'s `Style.fg`/`Style.bg` expects — nothing here touches
// SGR directly, `Screen.flush()` still owns that and still honors the
// `--no-color`/`NO_COLOR`/non-TTY kill switch in `ansi.ts`.
//
// Beyond the base kind (dir/file/symlink/other), a *file* additionally gets
// classified into a `FileCategory` (archive / image / executable / plain)
// purely from its extension and permission bits, so "colour with meaning"
// (the visual-design pass) can give each a genuinely distinct color and, in
// the unicode/nerd icon sets, a distinct glyph — matching SPEC.md's ask for
// directories, executables, symlinks, archives, images, and broken links to
// each read as visually distinct at a glance.

import type { Entry } from "../fsapi/entry.ts";
import type { GitStatus } from "../fsapi/gitStatus.ts";

// ── colors ──

export const colors = {
  dir: 0x6cb6ff,
  symlink: 0x5fd7c2,
  brokenSymlink: 0xff6b6b,
  error: 0xff6b6b,
  dim: 0x808080,
  accent: 0xe8c179,
  // File subtypes, distinguished by extension/permission bits (see
  // `fileCategory` below).
  executable: 0x8ce99a,
  archive: 0xffa94d,
  image: 0xe599f7,
  // Chrome: borders, rules, and column headers drawn by ui/chrome.ts and
  // ui/listView.ts — deliberately muted so they read as structure, not
  // content.
  chrome: 0x4a5568,
  header: 0x9aa5b1,
  // The current directory's own name in the breadcrumb is emphasised over
  // its ancestors (see ui/chrome.ts's renderBreadcrumb).
  titleEmphasis: 0xf5f5f5,
  // Subtle background highlight for the cursor row, used instead of full
  // reverse-video so a row's file-type color stays visible while it is
  // selected. The `›` marker remains the color-independent cue for
  // `--no-color`/plain-text output — see ui/listView.ts's file header.
  cursorBg: 0x243447,
  // A faint band under the status bar so it reads as a footer rather than a
  // stray last line.
  footerBg: 0x1b2430,
  // Selection/clipboard status glyph colors (see `rowMarkState` below) —
  // deliberately distinct from every file-category color above so a marked,
  // cut, or copied row is never mistaken for a file type.
  marked: 0xf6c945,
  cut: 0xff8c42,
  copied: 0xa78bfa,
  // Git status marker colors (see `gitStatusColor` below) — green for a
  // clean repo, orange for a dirty one.
  gitClean: 0x8ce99a,
  gitDirty: 0xffa94d,
} as const;

// ── file categorisation ──

const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz2",
  "xz",
  "txz",
  "7z",
  "rar",
  "zst",
  "jar",
  "war",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "svg",
  "ico",
  "tiff",
  "tif",
  "avif",
  "heic",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isExecutableFile(entry: Entry): boolean {
  return entry.kind === "file" && (entry.mode & 0o111) !== 0;
}

export type FileCategory = "plain" | "archive" | "image" | "executable";

/**
 * Subclassify a `kind === "file"` entry by extension first (a `.zip` that
 * happens to be `chmod +x`'d is still visually an archive, not a stray
 * executable), then by permission bits. Directories, symlinks, and errors
 * never reach this — callers only consult it after ruling those out.
 */
export function fileCategory(entry: Entry): FileCategory {
  if (entry.kind !== "file") return "plain";
  const ext = extensionOf(entry.name);
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (isExecutableFile(entry)) return "executable";
  return "plain";
}

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
  archive: string;
  image: string;
  executable: string;
};

const ICONS: Record<IconSet, IconTable> = {
  unicode: {
    dir: "📁",
    file: "📄",
    symlink: "🔗",
    brokenSymlink: "⚠",
    other: "❔",
    error: "✖",
    archive: "📦",
    image: "🖼",
    executable: "⚙",
  },
  nerd: {
    dir: "", // nf-fa-folder
    file: "", // nf-fa-file
    symlink: "", // nf-fa-link
    brokenSymlink: "", // nf-fa-chain_broken
    other: "", // nf-fa-question
    error: "", // nf-fa-warning
    archive: "", // nf-fa-file_archive_o
    image: "", // nf-fa-file_image_o
    executable: "", // nf-fa-cog
  },
  ascii: {
    dir: "d",
    file: "-",
    symlink: "l",
    brokenSymlink: "!",
    other: "?",
    error: "x",
    archive: "a",
    image: "i",
    executable: "*",
  },
};

/** Look up the glyph for `entry` under `set`. Views never index ICONS themselves. */
export function iconFor(set: IconSet, entry: Entry): string {
  const table = ICONS[set];
  if (entry.error) return table.error;
  if (entry.kind === "symlink")
    return entry.broken ? table.brokenSymlink : table.symlink;
  if (entry.kind === "dir") return table.dir;
  if (entry.kind === "file") {
    switch (fileCategory(entry)) {
      case "archive":
        return table.archive;
      case "image":
        return table.image;
      case "executable":
        return table.executable;
      default:
        return table.file;
    }
  }
  return table.other;
}

/** Foreground color for `entry`, or `undefined` for the terminal's default. */
export function colorFor(entry: Entry): number | undefined {
  if (entry.error) return colors.error;
  if (entry.kind === "symlink")
    return entry.broken ? colors.brokenSymlink : colors.symlink;
  if (entry.kind === "dir") return colors.dir;
  switch (fileCategory(entry)) {
    case "archive":
      return colors.archive;
    case "image":
      return colors.image;
    case "executable":
      return colors.executable;
    default:
      return undefined;
  }
}

export function isIconSet(value: string): value is IconSet {
  return (ICON_SETS as string[]).includes(value);
}

// ── selection & clipboard status ──
//
// The single status glyph ui/listView.ts and ui/gridView.ts draw in the
// column immediately after the cursor marker (previously always blank —
// see those files' MARKER_WIDTH) — independent of `--icons`, exactly like
// the cursor's `›`, so it renders identically under any icon set. Clipboard
// membership wins over a plain mark: once a path is staged for copy or cut
// that is the more actionable thing to show on the row, and the aggregate
// "N marked" / "M cut" counts in the status bar (ui/chrome.ts) still tell
// the whole story for marks that fall outside the staged range.

export type RowMarkState = "none" | "marked" | "cut" | "copied";

/**
 * Combined mark/clipboard status for one entry's absolute path. Takes the
 * clipboard as a small structural type rather than importing
 * `state/store.ts`'s `AppState` — this file has no state-layer dependency,
 * and `state/store.ts`'s own file header is explicit that avoiding that
 * kind of cross-import is what keeps the module graph acyclic.
 */
export function rowMarkState(
  path: string,
  marked: ReadonlySet<string>,
  clipboard: { mode: "copy" | "cut"; paths: string[] } | null,
): RowMarkState {
  if (clipboard?.paths.includes(path)) {
    return clipboard.mode === "cut" ? "cut" : "copied";
  }
  return marked.has(path) ? "marked" : "none";
}

/**
 * The status glyph itself: ASCII-safe and visually distinct from the
 * cursor's `›`, so it survives `--no-color` and `--icons=ascii` alike —
 * and mnemonic where possible ('x' cut, '+' copied) to match the key that
 * put the entry there.
 */
export const MARK_GLYPH: Record<RowMarkState, string> = {
  none: " ",
  marked: "*",
  cut: "x",
  copied: "+",
};

/** Foreground color for the status glyph; `undefined` (terminal default) for "none". */
export function markColor(state: RowMarkState): number | undefined {
  switch (state) {
    case "marked":
      return colors.marked;
    case "cut":
      return colors.cut;
    case "copied":
      return colors.copied;
    default:
      return undefined;
  }
}

// ── goto bookmarks ──
//
// The suffix appended to a directory's displayed name when its path is a
// goto bookmark (fsapi/goto.ts) — the breadcrumb (ui/chrome.ts) and both
// list/grid rows (ui/listView.ts/ui/gridView.ts) all share this one glyph
// and color. Deliberately an emoji (not gated by --icons), so it renders
// in its own color regardless of `bookmarkColor` below.

export const BOOKMARK_GLYPH = " ⭐";
export const bookmarkColor = colors.accent;

// ── git status markers ──
//
// A directory that is itself a git repo root (fsapi/gitStatus.ts's
// `isGitRepoRoot`) gets a small suffix appended after its name, same
// position as `BOOKMARK_GLYPH` above — but drawn with `gitStatusColor()`
// below rather than the row's own color, so a clean repo's `✓` reads green
// and a dirty one's `✗<n>` reads orange. Dirty vs. clean is still carried
// primarily by the glyph's *shape* (✓ vs ✗ plus a count), so it survives
// `--no-color` and any `--icons` set exactly like the cursor's `›` — color
// is a bonus for a real terminal, never the only signal, same reasoning as
// `cursorBg` (see ui/listView.ts's file header). ui/listView.ts and
// ui/gridView.ts only split the suffix into its own colored `screen.put`
// when truncation leaves it fully intact; a suffix clipped by a narrow
// column falls back to rendering in the row's plain color.

const GIT_STATUS_CAP = 99;

/**
 * `""` for every "no marker" case at once — `status` is `null`/`undefined`
 * because the directory isn't a repo, `git` is missing, or (most commonly)
 * its background check just hasn't resolved yet. A count past
 * `GIT_STATUS_CAP` renders as `99+` rather than growing the column
 * unboundedly for a repo with thousands of changed paths.
 */
export function gitStatusSuffix(status: GitStatus | null | undefined): string {
  if (!status) return "";
  if (!status.dirty) return " ✓";
  const n =
    status.changes > GIT_STATUS_CAP
      ? `${GIT_STATUS_CAP}+`
      : String(status.changes);
  return ` ✗${n}`;
}

/** Color for `gitStatusSuffix()`'s glyph — `undefined` (no marker) mirrors `""`. */
export function gitStatusColor(
  status: GitStatus | null | undefined,
): number | undefined {
  if (!status) return undefined;
  return status.dirty ? colors.gitDirty : colors.gitClean;
}
