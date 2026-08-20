// tests/progress.test.ts — ui/overlay/progress.ts: the pure bar/box math,
// plus a --dump-frame-style snapshot of the rendered overlay.
//
// main.ts's real `--dump-frame` flag renders whatever `store.load()`
// produces for a directory on disk — it has no hook for injecting an
// in-flight paste, and adding test-only state-seeding to main.ts's CLI
// surface for this one overlay isn't worth the scope. This test does
// exactly what `--dump-frame` itself does under the hood (construct a
// `Screen`, draw into it, call `renderPlainText()`) directly against
// `renderProgressOverlay`, which is the actual unit that needs snapshot
// coverage — main.ts's own dump-frame path is already covered by
// tests/dump-frame.test.ts.

import { describe, expect, it } from "bun:test";
import { Screen } from "../src/term/screen.ts";
import {
  computeProgressBox,
  formatByteCounts,
  renderBar,
  renderProgressOverlay,
} from "../src/ui/overlay/progress.ts";

describe("renderBar", () => {
  it("fills proportionally to the fraction", () => {
    expect(renderBar(0, 10, false)).toBe("░".repeat(10));
    expect(renderBar(1, 10, false)).toBe("█".repeat(10));
    expect(renderBar(0.5, 10, false)).toBe("█".repeat(5) + "░".repeat(5));
  });

  it("clamps out-of-range and non-finite fractions", () => {
    expect(renderBar(-1, 10, false)).toBe("░".repeat(10));
    expect(renderBar(2, 10, false)).toBe("█".repeat(10));
    expect(renderBar(Number.NaN, 10, false)).toBe("░".repeat(10));
  });

  it("substitutes ascii-safe characters when ascii is set", () => {
    expect(renderBar(0.5, 4, true)).toBe("##--");
  });

  it("returns empty for a non-positive width", () => {
    expect(renderBar(0.5, 0, false)).toBe("");
  });
});

describe("formatByteCounts", () => {
  it("formats both sides with formatSize's binary units", () => {
    expect(formatByteCounts(0, 0)).toBe("0 / 0");
    expect(formatByteCounts(1536, 1024 * 1024)).toBe("1.5K / 1.0M");
  });
});

describe("computeProgressBox", () => {
  it("centers within the screen and clamps to the preferred width range", () => {
    const box = computeProgressBox(100, 40);
    expect(box.width).toBeLessThanOrEqual(64);
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(100);
  });

  it("never exceeds the screen even when the screen is tiny", () => {
    const box = computeProgressBox(10, 5);
    expect(box.width).toBeLessThanOrEqual(10);
    expect(box.height).toBeLessThanOrEqual(5);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });
});

describe("renderProgressOverlay snapshot", () => {
  it("renders a mid-copy frame at 80x24, box centered with the expected layout", () => {
    const screen = new Screen(80, 24, () => {});
    screen.clear();
    renderProgressOverlay(
      screen,
      80,
      24,
      {
        label: "Copying",
        done: 42,
        total: 100,
        currentPath: "/home/dev/github/fs/src/some/deeply/nested/file.ts",
        bytesDone: 4_200_000,
        bytesTotal: 10_000_000,
      },
      false,
    );
    const lines = screen.renderPlainText().split("\n");

    // computeProgressBox(80, 24) -> width 64, height 8, x 8, y 8 (see the
    // computeProgressBox tests above for the general formula) — this
    // snapshot pins the exact rows so a layout regression shows up here
    // without a live terminal, the same job --dump-frame does for the
    // other views.
    expect(lines[8]).toBe(`        ┌${"─".repeat(62)}┐`);
    expect(lines[9]).toContain("Copying");
    expect(lines[11]).toContain("42%");
    expect(lines[11]).toContain("█");
    expect(lines[11]).toContain("░");
    expect(lines[12]).toContain("42/100 items · 4.0M / 9.5M");
    expect(lines[13]).toContain(
      "/home/dev/github/fs/src/some/deeply/nested/file.ts",
    );
    expect(lines[14]).toContain("Esc to cancel");
    expect(lines[15]).toBe(`        └${"─".repeat(62)}┘`);
  });

  it("renders under --icons=ascii with substituted bar characters", () => {
    const screen = new Screen(60, 20, () => {});
    screen.clear();
    renderProgressOverlay(
      screen,
      60,
      20,
      {
        label: "Copying",
        done: 5,
        total: 10,
        currentPath: "report.txt",
        bytesDone: 500,
        bytesTotal: 1000,
      },
      true,
    );
    const text = screen.renderPlainText();
    expect(text).toContain("#");
    expect(text).not.toContain("█");
    expect(text).not.toContain("░");
  });

  it("degrades gracefully rather than throwing on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() =>
      renderProgressOverlay(
        screen,
        15,
        6,
        {
          label: "Copying",
          done: 1,
          total: 2,
          currentPath: "x",
          bytesDone: 1,
          bytesTotal: 2,
        },
        false,
      ),
    ).not.toThrow();
  });
});
