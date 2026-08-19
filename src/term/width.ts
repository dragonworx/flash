// term/width.ts — display width for terminal rendering: stringWidth,
// truncate-with-ellipsis, and pad.
//
// Terminal columns are not the same as UTF-16 code units or codepoints:
// combining marks and zero-width joiners take no columns, most CJK and
// emoji take two. Every place in this codebase that measures or truncates a
// string for the screen must route through here — never through
// `String.length` (see the plan's "Risks to watch" / Wide characters). This
// file is the single call site for width measurement.
//
// `stringWidth()` wraps `Bun.stringWidth()`, a native binding, rather than
// a hand-rolled Intl.Segmenter walk over a Unicode range table — measured
// on this machine, the native version is roughly three orders of magnitude
// faster (5,000 mixed CJK/emoji names in ~3ms vs. seconds for a JS
// segmenter loop), and this runs in a per-cell hot path. A small fallback
// below covers the plain-Node/npm distribution path, where the `Bun`
// global does not exist.
//
// `truncate()` still needs `Intl.Segmenter`: there is no built-in "cut to N
// columns without splitting a grapheme cluster" primitive to lean on here,
// so it walks graphemes itself and measures each one with `stringWidth()`
// above. Truncation runs once per rendered line rather than per character,
// so the segmenter's cost is not the concern it would be in `stringWidth`.
// The instance is cached at module scope — constructing one per call is
// expensive.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// ── width ──

/** Column width of `s` as it would render in a terminal. */
export function stringWidth(s: string): number {
  if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") {
    return Bun.stringWidth(s);
  }
  return fallbackWidth(s);
}

/** Split `s` into user-perceived characters (grapheme clusters). */
export function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(s)) out.push(segment);
  return out;
}

// ── fallback (no `Bun` global — the plain-Node distribution path) ──
// Not on the hot path under Bun, so a straightforward per-grapheme walk is
// fine here. Compact range table: East Asian Wide/Fullwidth + common emoji
// blocks count 2, combining marks and zero-width joiners count 0.

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals .. CJK Symbols/Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji: symbols, pictographs, emoticons
  [0x1f680, 0x1f9ff], // emoji: transport, supplemental symbols
  [0x20000, 0x3fffd], // CJK Extension B and beyond
];

const ZERO_WIDTH_RANGES: [number, number][] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM/RLM
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // BOM
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function fallbackGraphemeWidth(g: string): 0 | 1 | 2 {
  const cp = g.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20 || cp === 0x7f) return 0;
  if (g.includes("\u200d")) return 2; // ZWJ sequence, e.g. an emoji family
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

function fallbackWidth(s: string): number {
  let total = 0;
  for (const g of graphemes(s)) total += fallbackGraphemeWidth(g);
  return total;
}

// ── truncate ──

/**
 * Cut `s` to at most `maxWidth` columns, appending `ellipsis` when
 * anything was cut. Never splits a grapheme cluster, and never overflows
 * `maxWidth` even when the last grapheme that would fit is 2 columns wide.
 */
export function truncate(s: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(s) <= maxWidth) return s;

  const ellipsisWidth = stringWidth(ellipsis);
  const budget = maxWidth - ellipsisWidth;
  if (budget < 0) return truncate(s, maxWidth, "");

  let width = 0;
  let out = "";
  for (const g of graphemes(s)) {
    const w = stringWidth(g);
    if (width + w > budget) break;
    out += g;
    width += w;
  }
  return out + ellipsis;
}

// ── pad ──

/** Pad (or truncate) `s` to exactly `width` columns. */
export function pad(
  s: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  if (width <= 0) return "";

  let text = s;
  let w = stringWidth(text);
  if (w > width) {
    text = truncate(text, width, "");
    w = stringWidth(text);
  }

  const gap = width - w;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return " ".repeat(left) + text + " ".repeat(right);
  }
  return text + " ".repeat(gap);
}
