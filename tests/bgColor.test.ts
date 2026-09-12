// tests/bgColor.test.ts — term/bgColor.ts's pure OSC 11 reply parser.

import { describe, expect, it } from "bun:test";
import { parseBackgroundReply } from "../src/term/bgColor.ts";

describe("parseBackgroundReply", () => {
  it("parses a 4-hex-digit-per-channel rgb: reply", () => {
    expect(parseBackgroundReply("\x1b]11;rgb:1e1e/1e1e/2b2b\x07")).toBe(
      0x1e1e2b,
    );
  });

  it("parses a 2-hex-digit-per-channel rgb: reply", () => {
    expect(parseBackgroundReply("\x1b]11;rgb:ff/80/00\x07")).toBe(0xff8000);
  });

  it("parses rxvt's rgba: variant", () => {
    expect(parseBackgroundReply("\x1b]11;rgba:ffff/ffff/ffff/ffff\x07")).toBe(
      0xffffff,
    );
  });

  it("accepts either BEL or ST as the terminator", () => {
    expect(parseBackgroundReply("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe(0);
  });

  it("returns null for an unrelated OSC sequence", () => {
    expect(parseBackgroundReply("\x1b]0;window title\x07")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseBackgroundReply("not an OSC sequence at all")).toBeNull();
  });
});
