// term/bgColor.ts — OSC 11 background-color query/reply, so term/theme.ts can
// derive a cursor/footer highlight that reads correctly on both light and
// dark terminals instead of guessing dark.
//
// The reply is parsed by `term/input.ts` itself (see its `consumeOSC`),
// not read off a side-channel stdin listener here — a terminal theme switch
// (e.g. macOS dark/light, or an iTerm2 profile change) can happen at any
// point during a session, with no notification event of its own, so main.ts
// re-sends `BG_QUERY` periodically and needs Input's regular listener (the
// one already attached for keystrokes) to recognize the reply whenever it
// lands, exactly like it already special-cases `\x1b[I`/`\x1b[O` focus
// events rather than surfacing them as keypresses. This file only owns the
// query string and the pure parse.

export const BG_QUERY = "\x1b]11;?\x1b\\";

// Matches the color part of a reply (both `rgb:` and rxvt's `rgba:`); the
// BEL/ST terminator that follows is whatever ended the OSC sequence
// `consumeOSC` already scanned for, so it doesn't need to appear here too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC byte is the point
const REPLY = /\x1b\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i;

/**
 * Each channel is 1-4 hex digits scaled to that width (xterm spec); only
 * the high byte matters at 8-bit output depth, so pad a single digit by
 * doubling it and otherwise take the first two digits.
 */
function channelByte(hex: string): number {
  const two = hex.length >= 2 ? hex.slice(0, 2) : hex + hex;
  return Number.parseInt(two, 16);
}

/**
 * `oscBody` is one complete OSC sequence (`ESC ] ... ` up to and including
 * its BEL/ST terminator) that `term/input.ts` didn't recognize as anything
 * else. Returns the packed 0xRRGGBB color for an OSC 11 reply, or `null` for
 * literally anything else — an unrelated OSC (7, 0, 52, ...) an unsolicited
 * terminal emits, or garbage, both of which are the common case and not an
 * error.
 */
export function parseBackgroundReply(oscBody: string): number | null {
  const match = REPLY.exec(oscBody);
  if (!match) return null;
  return (
    (channelByte(match[1] ?? "0") << 16) |
    (channelByte(match[2] ?? "0") << 8) |
    channelByte(match[3] ?? "0")
  );
}
