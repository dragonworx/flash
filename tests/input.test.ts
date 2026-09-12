// tests/input.test.ts — raw stdin bytes -> Key/focus events.

import { describe, expect, it } from "bun:test";
import { Input, type Key } from "../src/term/input.ts";

function collect() {
  const input = new Input();
  const keys: Key[] = [];
  const focus: boolean[] = [];
  const bgColors: number[] = [];
  input.onKey((k) => keys.push(k));
  input.onFocus((f) => focus.push(f));
  input.onBgColor((c) => bgColors.push(c));
  return { input, keys, focus, bgColors };
}

describe("Input: plain keys", () => {
  it("parses a printable character", () => {
    const { input, keys } = collect();
    input.feed("q");
    expect(keys).toEqual([
      { name: "q", ctrl: false, shift: false, alt: false, raw: "q" },
    ]);
  });

  it("maps 0x03 to ctrl+c", () => {
    const { input, keys } = collect();
    input.feed("\x03");
    expect(keys[0]).toMatchObject({
      name: "c",
      ctrl: true,
      shift: false,
      alt: false,
    });
  });

  it("maps enter, tab, backspace, space", () => {
    const { input, keys } = collect();
    input.feed("\x0d\x09\x7f\x20");
    expect(keys.map((k) => k.name)).toEqual([
      "enter",
      "tab",
      "backspace",
      "space",
    ]);
  });

  it("maps other C0 control chars to ctrl+letter", () => {
    const { input, keys } = collect();
    input.feed("\x01"); // ctrl+a
    expect(keys[0]).toMatchObject({ name: "a", ctrl: true });
  });
});

describe("Input: CSI sequences", () => {
  it("parses arrow keys", () => {
    const { input, keys } = collect();
    input.feed("\x1b[A\x1b[B\x1b[C\x1b[D");
    expect(keys.map((k) => k.name)).toEqual(["up", "down", "right", "left"]);
    expect(keys.every((k) => !k.ctrl && !k.shift && !k.alt)).toBe(true);
  });

  it("parses ctrl+up as a modified arrow (\\x1b[1;5A)", () => {
    const { input, keys } = collect();
    input.feed("\x1b[1;5A");
    expect(keys[0]).toMatchObject({
      name: "up",
      ctrl: true,
      shift: false,
      alt: false,
    });
  });

  it("parses F5 via CSI 15~", () => {
    const { input, keys } = collect();
    input.feed("\x1b[15~");
    expect(keys[0]).toMatchObject({ name: "f5" });
  });

  it("parses Home/End, PgUp/PgDn, Insert/Delete", () => {
    const { input, keys } = collect();
    input.feed("\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[2~\x1b[3~");
    expect(keys.map((k) => k.name)).toEqual([
      "home",
      "end",
      "pageup",
      "pagedown",
      "insert",
      "delete",
    ]);
  });

  it("parses F1-F4 via SS3", () => {
    const { input, keys } = collect();
    input.feed("\x1bOP\x1bOQ\x1bOR\x1bOS");
    expect(keys.map((k) => k.name)).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("discards an unrecognized CSI sequence instead of emitting a key", () => {
    const { input, keys } = collect();
    input.feed("\x1b[999z"); // no meaning to this parser
    input.feed("q"); // proves the parser recovered and kept consuming
    expect(keys.map((k) => k.name)).toEqual(["q"]);
  });
});

describe("Input: focus events", () => {
  it("emits \\x1b[I / \\x1b[O as focus events, not keypresses", () => {
    const { input, keys, focus } = collect();
    input.feed("\x1b[I\x1b[O");
    expect(keys).toEqual([]);
    expect(focus).toEqual([true, false]);
  });
});

describe("Input: OSC background-color replies", () => {
  it("emits a bgColor event for a BEL-terminated OSC 11 reply, not a keypress", () => {
    const { input, keys, bgColors } = collect();
    input.feed("\x1b]11;rgb:1e1e/1e1e/2b2b\x07");
    expect(keys).toEqual([]);
    expect(bgColors).toEqual([0x1e1e2b]);
  });

  it("emits a bgColor event for an ST-terminated OSC 11 reply", () => {
    const { input, keys, bgColors } = collect();
    input.feed("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    expect(keys).toEqual([]);
    expect(bgColors).toEqual([0xffffff]);
  });

  it("discards an unrelated OSC sequence instead of emitting a phantom key", () => {
    const { input, keys, bgColors } = collect();
    input.feed("\x1b]0;window title\x07q");
    expect(bgColors).toEqual([]);
    expect(keys.map((k) => k.name)).toEqual(["q"]);
  });
});

describe("Input: bracketed paste", () => {
  it("discards the paste markers instead of emitting a phantom key", () => {
    const { input, keys } = collect();
    input.feed("\x1b[200~hi\x1b[201~");
    // No key carries the marker bytes; the plain text between the markers
    // still arrives as ordinary keypresses in this phase.
    expect(keys.every((k) => !k.raw.includes("\x1b"))).toBe(true);
    expect(keys.map((k) => k.name)).toEqual(["h", "i"]);
  });
});

describe("Input: lone Escape", () => {
  it("emits an escape key after the timeout when nothing follows", async () => {
    const { input, keys } = collect();
    input.feed("\x1b");
    expect(keys).toEqual([]); // still ambiguous immediately after
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(keys.map((k) => k.name)).toEqual(["escape"]);
  });

  it("does not misfire the timeout when the escape starts a real sequence", async () => {
    const { input, keys } = collect();
    input.feed("\x1b[A");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(keys.map((k) => k.name)).toEqual(["up"]);
  });
});
