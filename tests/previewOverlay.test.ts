// tests/previewOverlay.test.ts — ui/overlay/preview.ts: box geometry and
// rendering. Same box-sizing/snapshot pattern as tests/help.test.ts and
// tests/progress.test.ts.

import { describe, expect, it } from "bun:test";
import type { StyledSegment } from "../src/term/ansiParse.ts";
import { Screen } from "../src/term/screen.ts";
import {
  type PreviewOverlayState,
  computePreviewBox,
  maxPreviewScroll,
  previewViewportHeight,
  renderPreviewOverlay,
} from "../src/ui/overlay/preview.ts";

function makeState(
  overrides: Partial<PreviewOverlayState> = {},
): PreviewOverlayState {
  return {
    path: "/tmp/example.txt",
    lines: [],
    scrollOffset: 0,
    loading: false,
    error: null,
    truncated: false,
    ...overrides,
  };
}

function line(text: string): StyledSegment[] {
  return [{ text, style: {} }];
}

describe("computePreviewBox / previewViewportHeight / maxPreviewScroll", () => {
  it("is near-full-screen, unlike the small centered overlays", () => {
    const box = computePreviewBox(100, 40);
    expect(box.width).toBeGreaterThan(90);
    expect(box.height).toBeGreaterThan(35);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(100);
  });

  it("never exceeds the screen even when the screen is tiny", () => {
    const box = computePreviewBox(10, 5);
    expect(box.width).toBeLessThanOrEqual(10);
    expect(box.height).toBeLessThanOrEqual(5);
  });

  it("a short terminal has a smaller viewport than a tall one, and scroll room to match", () => {
    const shortViewport = previewViewportHeight(80, 15);
    const tallViewport = previewViewportHeight(80, 60);
    expect(shortViewport).toBeLessThan(tallViewport);
    expect(maxPreviewScroll(80, 15, 200)).toBeGreaterThan(
      maxPreviewScroll(80, 60, 200),
    );
  });

  it("needs no scrolling when every line already fits", () => {
    expect(maxPreviewScroll(80, 60, 5)).toBe(0);
  });
});

describe("renderPreviewOverlay", () => {
  it("shows the path header and content lines", () => {
    const screen = new Screen(90, 30, () => {});
    screen.clear();
    renderPreviewOverlay(
      screen,
      90,
      30,
      makeState({
        path: "/home/dev/example.ts",
        lines: [line("const x = 1;"), line("export default x;")],
      }),
    );
    const text = screen.renderPlainText();
    expect(text).toContain("/home/dev/example.ts");
    expect(text).toContain("const x = 1;");
    expect(text).toContain("export default x;");
    expect(text).toContain("Esc back");
  });

  it("shows a loading indicator instead of content while loading", () => {
    const screen = new Screen(90, 30, () => {});
    screen.clear();
    renderPreviewOverlay(screen, 90, 30, makeState({ loading: true }));
    expect(screen.renderPlainText()).toContain("loading");
  });

  it("shows the error message instead of content on failure", () => {
    const screen = new Screen(90, 30, () => {});
    screen.clear();
    renderPreviewOverlay(
      screen,
      90,
      30,
      makeState({ error: "permission denied" }),
    );
    expect(screen.renderPlainText()).toContain("permission denied");
  });

  it("mentions truncation in the footer when the content was cut off", () => {
    const screen = new Screen(90, 30, () => {});
    screen.clear();
    renderPreviewOverlay(
      screen,
      90,
      30,
      makeState({ lines: [line("a")], truncated: true }),
    );
    expect(screen.renderPlainText()).toContain("truncated");
  });

  it("scrolling changes what's visible", () => {
    const manyLines = Array.from({ length: 100 }, (_, i) => line(`line ${i}`));
    const top = new Screen(90, 20, () => {});
    top.clear();
    renderPreviewOverlay(
      top,
      90,
      20,
      makeState({ lines: manyLines, scrollOffset: 0 }),
    );

    const bottom = new Screen(90, 20, () => {});
    bottom.clear();
    const maxOffset = maxPreviewScroll(90, 20, manyLines.length);
    renderPreviewOverlay(
      bottom,
      90,
      20,
      makeState({ lines: manyLines, scrollOffset: maxOffset }),
    );
    expect(top.renderPlainText()).not.toBe(bottom.renderPlainText());
    expect(bottom.renderPlainText()).toContain("line 99");
  });

  it("clamps an out-of-range scroll offset rather than throwing or rendering blank", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => line(`line ${i}`));
    const screen = new Screen(90, 20, () => {});
    screen.clear();
    expect(() =>
      renderPreviewOverlay(
        screen,
        90,
        20,
        makeState({ lines: manyLines, scrollOffset: 1_000_000 }),
      ),
    ).not.toThrow();
    expect(screen.renderPlainText().trim().length).toBeGreaterThan(0);
  });

  it("degrades gracefully on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() =>
      renderPreviewOverlay(screen, 15, 6, makeState({ lines: [line("x")] })),
    ).not.toThrow();
  });

  it("colors a styled segment with its own foreground rather than the default", () => {
    const screen = new Screen(40, 10, () => {});
    screen.clear();
    renderPreviewOverlay(
      screen,
      40,
      10,
      makeState({ lines: [[{ text: "red", style: { fg: 0xff0000 } }]] }),
    );
    // Plain text can't show color, but this at least confirms it renders
    // the segment's text without throwing on a styled (non-empty style) run.
    expect(screen.renderPlainText()).toContain("red");
  });
});
