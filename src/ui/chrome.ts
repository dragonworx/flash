// ui/chrome.ts — the framed banner, the frame layout math, and the status
// bar: the "where am I" region above the list and the footer strip below
// it. SPEC.md asks for a real banner ("render visually beautifully, using
// color and extended characters ... to create windows, lines, columns") and
// for the breadcrumb to sit in it "before any path contents is rendered" —
// so the banner here is a genuine box-drawn window when there is room for
// one, not a bare line of text.
//
// `computeFrame()` is the one function that decides, given a terminal size
// and the active view, which chrome elements exist this frame and which row
// each lives on. It is pure and unit-tested (tests/chrome.test.ts) so a
// layout regression at some particular (width, height) shows up without a
// live terminal. Everything else in this file either formats a string
// (`formatBreadcrumb`, `formatItemCount`, `formatStatusLeft` — also pure,
// also tested) or draws with a `Screen` at coordinates a caller already
// computed.
//
// Phase 4 extends the status bar (`formatStatusLeft`/`renderStatusBar`)
// rather than replacing it: mark count was already a field on `StatusInfo`
// (`markedCount`), so only the clipboard summary — "N marked · M cut" — is
// new.
//
// Phase 8 (archives) extends the breadcrumb the same way: `formatBreadcrumb`/
// `renderBreadcrumb`/`renderBanner` all grow an optional trailing `archive`
// parameter. `cwd` never changes while browsing inside a zip (see
// state/store.ts's file header) — only `state.archive.innerPath` does — so
// the archive's own segments (its basename, then each inner path component)
// are appended on top of the ordinary cwd segments rather than replacing
// them, and the whole thing still collapses as one path. `ArchiveBreadcrumb`
// is structural, not imported from state/store.ts, same reasoning as
// `ClipboardLike` below and in ui/listView.ts.

import { basename } from "node:path";
import type { Message } from "../state/store.ts";
import { ATTR_BOLD, type Screen, type Style } from "../term/screen.ts";
import { colors } from "../term/theme.ts";
import { pad, stringWidth, truncate } from "../term/width.ts";

// ── breadcrumb ──

const CHEVRON = " › ";
const COLLAPSE = "…";

export type ArchiveBreadcrumb = { zipPath: string; innerPath: string };

/** Split an absolute path into breadcrumb segments: `/a/b` -> `["/", "a", "b"]`. */
export function pathSegments(cwd: string): string[] {
  const parts = cwd.split("/").filter((p) => p.length > 0);
  return ["/", ...parts];
}

type Segment = { text: string; isArchive: boolean };

/** `pathSegments(cwd)` plus, when browsing an archive, its own segments —
 * the zip's basename followed by each `innerPath` component — tagged so
 * `renderBreadcrumb` can style them distinctly from the real filesystem
 * path they're appended to. */
function toSegments(
  cwd: string,
  archive?: ArchiveBreadcrumb | null,
): Segment[] {
  const real = pathSegments(cwd).map((text) => ({ text, isArchive: false }));
  if (!archive) return real;
  const inner = archive.innerPath
    ? archive.innerPath.split("/").filter((p) => p.length > 0)
    : [];
  const archiveParts = [basename(archive.zipPath), ...inner];
  return [...real, ...archiveParts.map((text) => ({ text, isArchive: true }))];
}

/**
 * The segments actually shown, post-collapse, in display order — shared by
 * `formatBreadcrumb` (joins them with a plain chevron, for plain-text
 * rendering and tests) and `renderBreadcrumb` (styles each one separately so
 * the current directory's own name — and, inside an archive, the archive
 * segments — can be emphasised over the rest). When the full path fits,
 * this is just `toSegments(cwd, archive)`. Otherwise the first segment is
 * kept, the middle collapses to a single `"…"` entry, and as many trailing
 * segments as fit are kept — so the segment the user is actually inside is
 * always the last thing to be cut.
 */
function collapseSegments(segments: Segment[], maxWidth: number): Segment[] {
  if (maxWidth <= 0) return [];
  const full = segments.map((s) => s.text).join(CHEVRON);
  if (stringWidth(full) <= maxWidth) return segments;

  const first = segments[0] ?? { text: "/", isArchive: false };
  let tail: Segment[] = [];
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const candidateTail = [seg, ...tail];
    const candidate = [
      first,
      { text: COLLAPSE, isArchive: false },
      ...candidateTail,
    ]
      .map((s) => s.text)
      .join(CHEVRON);
    if (stringWidth(candidate) > maxWidth) break;
    tail = candidateTail;
  }
  if (tail.length === 0) {
    // Not even `first › … › lastSegment` fits — fall back to a bare
    // truncation of just the last segment so something legible shows.
    const last = segments[segments.length - 1];
    return [
      {
        text: truncate(last?.text ?? "", maxWidth),
        isArchive: last?.isArchive ?? false,
      },
    ];
  }
  return [first, { text: COLLAPSE, isArchive: false }, ...tail];
}

/**
 * Render `cwd` (and, when given, the archive currently being browsed inside
 * it) as a breadcrumb string that fits in `maxWidth` columns — plain text,
 * no styling, used by `--dump-frame`'s plain-text path and by tests. See
 * `collapseSegments` for the collapsing rule.
 */
export function formatBreadcrumb(
  cwd: string,
  maxWidth: number,
  archive?: ArchiveBreadcrumb | null,
): string {
  return collapseSegments(toSegments(cwd, archive), maxWidth)
    .map((s) => s.text)
    .join(CHEVRON);
}

/**
 * Draw the breadcrumb into the banner: ancestor segments dim, chevrons
 * dimmer still (chrome, not content), the current directory's own name —
 * always the last real-filesystem part — bold and bright, and, when
 * browsing inside an archive, its segments in `colors.archive` (the same
 * color the file-type coloring already uses for `.zip` files elsewhere, so
 * "you're inside an archive" reads as the same visual language) with the
 * innermost one bold. This is the "emphasise where you are" half of the
 * visual design pass; `formatBreadcrumb` above stays byte-for-byte the
 * plain-text equivalent for snapshots.
 */
export function renderBreadcrumb(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  cwd: string,
  archive?: ArchiveBreadcrumb | null,
): void {
  const parts = collapseSegments(toSegments(cwd, archive), width);
  if (parts.length === 0) return;
  const lastIdx = parts.length - 1;

  let cx = x;
  let remaining = width;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || remaining <= 0) break;

    const isLast = i === lastIdx;
    const isCollapse = part.text === COLLAPSE;
    const style: Style = isCollapse
      ? { fg: colors.chrome }
      : part.isArchive
        ? { fg: colors.archive, attr: isLast ? ATTR_BOLD : 0 }
        : isLast
          ? { fg: colors.titleEmphasis, attr: ATTR_BOLD }
          : { fg: colors.dim };

    const w = Math.min(stringWidth(part.text), remaining);
    screen.put(cx, y, part.text, style);
    cx += w;
    remaining -= w;

    if (!isLast && remaining > 0) {
      const chevronW = Math.min(stringWidth(CHEVRON), remaining);
      screen.put(cx, y, CHEVRON, { fg: colors.chrome });
      cx += chevronW;
      remaining -= chevronW;
    }
  }
}

// ── frame layout ──
//
// The banner is a genuine box (┌─┐ / │ text │ / └─┘) when the terminal is
// roomy enough, its bottom border doing double duty as "the horizontal rule
// separating banner from body" the design pass asks for. Column headers
// only make sense for the list view (grid has no Size/Mode/Owner/Group/
// Modified columns to label), so they — and their own separating rule — are
// only reserved when `view === "list"` and there is room. Everything
// degrades a tier at a time as height shrinks, and `listHeight` is always
// clamped at 0 rather than going negative, so a caller never has to guard
// against a degenerate terminal itself.

const MIN_WIDTH_FOR_BORDER = 24;
const MIN_HEIGHT_FOR_BORDER = 9;
const MIN_HEIGHT_FOR_HEADER = 9;

export type Frame = {
  /** Whether the banner is drawn as a bordered box (┌─┐/│…│/└─┘) this frame. */
  border: boolean;
  /** Row of the top border, only set when `border` is true. */
  bannerTopY: number | null;
  /** Row the breadcrumb text itself is drawn on — always present. */
  breadcrumbY: number;
  /**
   * Row separating the banner from the body: the box's bottom border when
   * `border` is true, a plain rule otherwise. `null` only when the terminal
   * is too short to spare even this one row.
   */
  bannerRuleY: number | null;
  /** Column header row (Name / Size / Mode / …), list view only. */
  headerY: number | null;
  /** Rule under the column headers, present iff `headerY` is. */
  headerRuleY: number | null;
  listY: number;
  listHeight: number;
  /** Rule separating the body from the footer status bar. */
  footerRuleY: number | null;
  statusY: number | null;
};

export function computeFrame(
  width: number,
  height: number,
  view: "list" | "grid",
): Frame {
  const h = Math.max(height, 1);
  const border = width >= MIN_WIDTH_FOR_BORDER && h >= MIN_HEIGHT_FOR_BORDER;
  const header = view === "list" && h >= MIN_HEIGHT_FOR_HEADER;

  let y = 0;
  let bannerTopY: number | null = null;
  if (border) {
    bannerTopY = y;
    y++;
  }
  const breadcrumbY = y;
  y++;

  let bannerRuleY: number | null = null;
  if (h > y) {
    bannerRuleY = y;
    y++;
  }

  let headerY: number | null = null;
  let headerRuleY: number | null = null;
  if (header && h > y + 1) {
    headerY = y;
    y++;
    headerRuleY = y;
    y++;
  }

  let footerRuleY: number | null = null;
  let statusY: number | null = null;
  let bottomReserved = 0;
  if (h - y >= 2) {
    statusY = h - 1;
    bottomReserved++;
    if (h - y >= 3) {
      footerRuleY = h - 2;
      bottomReserved++;
    }
  }

  const listY = y;
  const listHeight = Math.max(h - y - bottomReserved, 0);

  return {
    border,
    bannerTopY,
    breadcrumbY,
    bannerRuleY,
    headerY,
    headerRuleY,
    listY,
    listHeight,
    footerRuleY,
    statusY,
  };
}

/** A plain horizontal rule, full width, in the muted chrome color. */
export function renderRule(screen: Screen, y: number, width: number): void {
  if (width <= 0) return;
  screen.put(0, y, "─".repeat(width), { fg: colors.chrome });
}

/**
 * Draw the banner: a bordered box around the breadcrumb when `frame.border`
 * is set (its bottom edge is the banner/body rule), or the breadcrumb as a
 * plain line followed by a plain rule otherwise. Either way, the breadcrumb
 * is on screen "before any path contents is rendered" per SPEC.md, and a
 * rule always separates it from the body when there is room for one.
 */
export function renderBanner(
  screen: Screen,
  width: number,
  frame: Frame,
  cwd: string,
  archive?: ArchiveBreadcrumb | null,
): void {
  if (frame.border && frame.bannerTopY !== null) {
    screen.box(0, frame.bannerTopY, width, 3, { fg: colors.chrome });
    renderBreadcrumb(
      screen,
      2,
      frame.breadcrumbY,
      Math.max(width - 4, 0),
      cwd,
      archive,
    );
    return;
  }
  renderBreadcrumb(screen, 0, frame.breadcrumbY, width, cwd, archive);
  if (frame.bannerRuleY !== null) renderRule(screen, frame.bannerRuleY, width);
}

// ── status bar ──

export function formatItemCount(itemCount: number): string {
  return `${itemCount} item${itemCount === 1 ? "" : "s"}`;
}

export type StatusInfo = {
  itemCount: number;
  markedCount?: number;
  /** Structural, not imported from state/store.ts — see ui/listView.ts's file header. */
  clipboard?: { mode: "copy" | "cut"; paths: string[] } | null;
  message?: Message | null;
};

/**
 * The left-hand status text — "N items[, M marked][ · K cut/copied]" — as a
 * pure string, so a layout/wording regression shows up in a plain unit test
 * (tests/chrome.test.ts) without a `Screen`. `renderStatusBar` below is a
 * thin wrapper that paints this plus the transient message.
 */
export function formatStatusLeft(info: StatusInfo): string {
  const marked = info.markedCount ?? 0;
  const base =
    marked > 0
      ? `${formatItemCount(info.itemCount)}, ${marked} marked`
      : formatItemCount(info.itemCount);
  const clip = info.clipboard;
  if (!clip || clip.paths.length === 0) return base;
  const clipWord = clip.mode === "cut" ? "cut" : "copied";
  return `${base} · ${clip.paths.length} ${clipWord}`;
}

/**
 * The status bar as a footer: painted with `colors.footerBg` across the
 * full width (even where no text reaches) so it reads as a strip, not a
 * stray last line — `renderRule` above already separates it from the body
 * when `frame.footerRuleY` is set.
 */
export function renderStatusBar(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  info: StatusInfo,
): void {
  const style: Style = { bg: colors.footerBg };
  const left = formatStatusLeft(info);
  screen.put(x, y, pad(left, width), { ...style, fg: colors.dim });

  if (info.message) {
    const msgStyle: Style = {
      ...style,
      fg: info.message.kind === "error" ? colors.error : colors.accent,
    };
    const text = truncate(info.message.text, width);
    const startX = x + Math.max(width - stringWidth(text), 0);
    screen.put(startX, y, text, msgStyle);
  }
}
