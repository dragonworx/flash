// tests/confirm.test.ts — ui/overlay/confirm.ts: the box-sizing math and a
// --dump-frame-style snapshot of the rendered overlay, same pattern as
// tests/progress.test.ts and tests/prompt.test.ts.

import { describe, expect, it } from "bun:test";
import { Screen } from "../src/term/screen.ts";
import {
  computeConfirmBox,
  renderConfirmOverlay,
} from "../src/ui/overlay/confirm.ts";

describe("computeConfirmBox", () => {
  it("centers within the screen and clamps to the preferred width range", () => {
    const box = computeConfirmBox(100, 40);
    expect(box.width).toBeLessThanOrEqual(64);
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(100);
  });

  it("never exceeds the screen even when the screen is tiny", () => {
    const box = computeConfirmBox(10, 5);
    expect(box.width).toBeLessThanOrEqual(10);
    expect(box.height).toBeLessThanOrEqual(5);
  });
});

describe("renderConfirmOverlay snapshot", () => {
  it("renders the exact blast-radius sentence and the y-only footer", () => {
    const screen = new Screen(80, 24, () => {});
    screen.clear();
    renderConfirmOverlay(
      screen,
      80,
      24,
      "Delete 3 items, including directory 'build/' (412 files)?",
    );
    const text = screen.renderPlainText();
    expect(text).toContain(
      "Delete 3 items, including directory 'build/' (412 files)?",
    );
    expect(text).toContain("y deletes forever");
    // Enter must never be advertised as an accept key here.
    expect(text.toLowerCase()).not.toContain("enter to confirm");
    expect(text.toLowerCase()).not.toContain("press enter");
  });

  it("truncates an overlong message rather than throwing or wrapping", () => {
    const screen = new Screen(40, 20, () => {});
    screen.clear();
    const longName = "x".repeat(200);
    expect(() =>
      renderConfirmOverlay(screen, 40, 20, `Delete '${longName}'?`),
    ).not.toThrow();
  });

  it("degrades gracefully rather than throwing on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() =>
      renderConfirmOverlay(screen, 15, 6, "Delete this?"),
    ).not.toThrow();
  });
});
