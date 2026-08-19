// ui/chrome.ts — the breadcrumb banner and the status bar: the one line of
// "where am I" above the list and the one line of "what am I looking at"
// below it. Both are pure functions over primitives (a path, a width, a
// count) wrapping a small amount of `Screen.put()` — the collapsing logic
// itself (`formatBreadcrumb`) is exported separately so it can be unit
// tested without a Screen at all.

import type { Message } from "../state/store.ts";
import type { Screen, Style } from "../term/screen.ts";
import { colors } from "../term/theme.ts";
import { pad, stringWidth, truncate } from "../term/width.ts";

// ── breadcrumb ──

const CHEVRON = " › ";
const COLLAPSE = "…";

/** Split an absolute path into breadcrumb segments: `/a/b` -> `["/", "a", "b"]`. */
export function pathSegments(cwd: string): string[] {
  const parts = cwd.split("/").filter((p) => p.length > 0);
  return ["/", ...parts];
}

/**
 * Render `cwd` as a breadcrumb string that fits in `maxWidth` columns.
 * When the full path fits, it is shown as-is (`/ › home › dev › fs`).
 * Otherwise the first segment is kept, the middle collapses to `…`, and as
 * many trailing segments (the ones nearest the current directory) are kept
 * as still fit — so the segment the user is actually inside is always the
 * last thing to be cut.
 */
export function formatBreadcrumb(cwd: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const segments = pathSegments(cwd);
  const full = segments.join(CHEVRON);
  if (stringWidth(full) <= maxWidth) return full;

  const first = segments[0] ?? "/";
  let tail: string[] = [];
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const candidateTail = [seg, ...tail];
    const candidate = [first, COLLAPSE, ...candidateTail].join(CHEVRON);
    if (stringWidth(candidate) > maxWidth) break;
    tail = candidateTail;
  }
  if (tail.length === 0) {
    // Not even `first › … › lastSegment` fits — fall back to a bare
    // truncation of just the last segment so something legible shows.
    const last = segments[segments.length - 1] ?? "";
    return truncate(last, maxWidth);
  }
  return [first, COLLAPSE, ...tail].join(CHEVRON);
}

export function renderBreadcrumb(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  cwd: string,
  style: Style = {},
): void {
  const text = formatBreadcrumb(cwd, width);
  screen.put(x, y, pad(text, width), {
    ...style,
    fg: style.fg ?? colors.accent,
  });
}

// ── status bar ──

export function formatItemCount(itemCount: number): string {
  return `${itemCount} item${itemCount === 1 ? "" : "s"}`;
}

export type StatusInfo = {
  itemCount: number;
  markedCount?: number;
  message?: Message | null;
};

export function renderStatusBar(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  info: StatusInfo,
  style: Style = {},
): void {
  const marked = info.markedCount ?? 0;
  const left =
    marked > 0
      ? `${formatItemCount(info.itemCount)}, ${marked} marked`
      : formatItemCount(info.itemCount);
  screen.put(x, y, pad(left, width), style);

  if (info.message) {
    const msgStyle: Style = {
      ...style,
      fg:
        info.message.kind === "error"
          ? colors.error
          : (style.fg ?? colors.accent),
    };
    const text = truncate(info.message.text, width);
    const startX = x + Math.max(width - stringWidth(text), 0);
    screen.put(startX, y, text, msgStyle);
  }
}
