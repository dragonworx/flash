// term/input.ts — raw stdin bytes -> Key events, plus focus in/out events.
//
// Feed it bytes (via `feed()` directly, in tests, or through `start()` on a
// real stdin) and it emits parsed `Key` objects through `onKey`. Handles
// CSI sequences for arrows, Home/End, PgUp/PgDn, Insert/Delete, F1-F12, and
// modified variants (`\x1b[1;5A` = ctrl+up). No mouse parsing — the plan
// forbids it outright, so grabbing the mouse never breaks click-drag
// selection in herdr or tmux.
//
// A lone ESC (0x1b) is ambiguous: it might be the Escape key on its own, or
// the first byte of a multi-byte sequence still arriving. `caps.ts` already
// enables focus reporting, and herdr enables bracketed paste for every pane
// it spawns, so both `\x1b[I`/`\x1b[O` and `\x1b[200~`/`\x1b[201~` will show
// up on stdin unannounced:
//   - `\x1b[I` / `\x1b[O` are parsed and dispatched through `onFocus`, never
//     as an `I`/`O` keypress.
//   - `\x1b[200~` / `\x1b[201~` (bracketed-paste markers — `caps.ts` also
//     disables bracketed paste on entry, this is the defensive second
//     layer) and any other CSI/SS3 sequence this parser does not recognize
//     are silently discarded rather than surfaced as a phantom keypress —
//     otherwise a paste into a future text prompt could inject a literal
//     escape sequence into whatever the user is typing.
//
// A lone ESC with nothing following within ~50ms is the Escape key;
// otherwise it begins a sequence. herdr's own binary references flushing a
// lone escape after an input timeout, i.e. the host multiplexer already
// delays escapes in flight — 50ms leaves room for that rather than racing
// it (an earlier 25ms budget did not).

export type Key = {
  name: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  raw: string;
};

type Event = { kind: "key"; key: Key } | { kind: "focus"; focused: boolean };

/** A parse step consumed `length` bytes; `event` is null for a discard. */
type Consumed = { length: number; event: Event | null };

const INCOMPLETE = Symbol("incomplete");
const AMBIGUOUS_ESCAPE = Symbol("ambiguous-escape");
type ParseOutcome = Consumed | typeof INCOMPLETE | typeof AMBIGUOUS_ESCAPE;

const ESC = 0x1b;
const ESCAPE_TIMEOUT_MS = 50;

// ── plain (non-escape) bytes ──

function consumePlain(buf: string): Consumed {
  const cp = buf.codePointAt(0) ?? buf.charCodeAt(0);
  const chars = String.fromCodePoint(cp);
  const raw = buf.slice(0, chars.length);

  if (cp === 0x03)
    return keyResult(raw, {
      name: "c",
      ctrl: true,
      shift: false,
      alt: false,
      raw,
    });
  if (cp === 0x0d)
    return keyResult(raw, {
      name: "enter",
      ctrl: false,
      shift: false,
      alt: false,
      raw,
    });
  if (cp === 0x09)
    return keyResult(raw, {
      name: "tab",
      ctrl: false,
      shift: false,
      alt: false,
      raw,
    });
  if (cp === 0x7f)
    return keyResult(raw, {
      name: "backspace",
      ctrl: false,
      shift: false,
      alt: false,
      raw,
    });
  if (cp === 0x20)
    return keyResult(raw, {
      name: "space",
      ctrl: false,
      shift: false,
      alt: false,
      raw,
    });
  if (cp > 0 && cp < 0x20) {
    // Other C0 control chars map to ctrl+letter: 0x01 -> ctrl+a, etc.
    const letter = String.fromCharCode(cp + 0x60);
    return keyResult(raw, {
      name: letter,
      ctrl: true,
      shift: false,
      alt: false,
      raw,
    });
  }
  return keyResult(raw, {
    name: chars,
    ctrl: false,
    shift: false,
    alt: false,
    raw,
  });
}

function keyResult(raw: string, key: Key): Consumed {
  return { length: raw.length, event: { kind: "key", key } };
}

// ── escape sequences ──

function modFlags(mod: number): {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
} {
  const m = Math.max(0, mod - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 };
}

function modKey(
  raw: string,
  name: string,
  modParam: number | undefined,
): Consumed {
  const { ctrl, shift, alt } = modFlags(modParam ?? 1);
  return {
    length: raw.length,
    event: { kind: "key", key: { name, ctrl, shift, alt, raw } },
  };
}

const ARROW_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
};

const TILDE_NAMES: Record<number, string> = {
  1: "home",
  7: "home",
  2: "insert",
  3: "delete",
  4: "end",
  8: "end",
  5: "pageup",
  6: "pagedown",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
  // 200/201 are bracketed-paste start/end markers — deliberately absent so
  // they fall through to the discard case below.
};

const SS3_NAMES: Record<string, string> = {
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

function csiToEvent(params: string, final: string, raw: string): Consumed {
  if (final === "I")
    return { length: raw.length, event: { kind: "focus", focused: true } };
  if (final === "O")
    return { length: raw.length, event: { kind: "focus", focused: false } };

  const tokens = params.length > 0 ? params.split(";").map(Number) : [];

  const arrow = ARROW_NAMES[final];
  if (arrow) return modKey(raw, arrow, tokens[1]);

  if (final === "H") return modKey(raw, "home", tokens[1]);
  if (final === "F") return modKey(raw, "end", tokens[1]);

  if (final === "~") {
    const code = tokens[0];
    const name = code !== undefined ? TILDE_NAMES[code] : undefined;
    if (!name) return { length: raw.length, event: null }; // e.g. bracketed paste 200~/201~
    return modKey(raw, name, tokens[1]);
  }

  const ss3Name = SS3_NAMES[final];
  if (ss3Name) return modKey(raw, ss3Name, tokens[1]);

  // Any other CSI final byte: unrecognized, discard rather than surface a
  // phantom keypress.
  return { length: raw.length, event: null };
}

function consumeCSI(buf: string): ParseOutcome {
  // buf[0] = ESC, buf[1] = "["
  for (let i = 2; i < buf.length; i++) {
    const code = buf.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      const params = buf.slice(2, i);
      const final = buf[i] ?? "";
      const raw = buf.slice(0, i + 1);
      return csiToEvent(params, final, raw);
    }
  }
  return INCOMPLETE;
}

function consumeSS3(buf: string): ParseOutcome {
  // buf[0] = ESC, buf[1] = "O"
  if (buf.length < 3) return INCOMPLETE;
  const final = buf[2] ?? "";
  const raw = buf.slice(0, 3);
  const name = SS3_NAMES[final];
  if (!name) return { length: raw.length, event: null };
  return {
    length: raw.length,
    event: {
      kind: "key",
      key: { name, ctrl: false, shift: false, alt: false, raw },
    },
  };
}

function consumeOne(buf: string): ParseOutcome {
  const c0 = buf.charCodeAt(0);
  if (c0 !== ESC) return consumePlain(buf);
  if (buf.length === 1) return AMBIGUOUS_ESCAPE;

  const c1 = buf[1];
  if (c1 === "[") return consumeCSI(buf);
  if (c1 === "O") return consumeSS3(buf);

  // ESC followed by anything else: the common terminal convention for
  // Alt+<key>.
  const inner = consumePlain(buf.slice(1));
  const raw = buf.slice(0, 1 + inner.length);
  if (inner.event && inner.event.kind === "key") {
    return {
      length: raw.length,
      event: { kind: "key", key: { ...inner.event.key, alt: true, raw } },
    };
  }
  return { length: raw.length, event: null };
}

// ── Input ──

export class Input {
  private buffer = "";
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private keyHandlers: Array<(key: Key) => void> = [];
  private focusHandlers: Array<(focused: boolean) => void> = [];
  private stdin: NodeJS.ReadableStream;
  private listening = false;
  private readonly handleData = (chunk: Buffer | string) => this.feed(chunk);

  constructor(stdin: NodeJS.ReadableStream = process.stdin) {
    this.stdin = stdin;
  }

  onKey(cb: (key: Key) => void): void {
    this.keyHandlers.push(cb);
  }

  onFocus(cb: (focused: boolean) => void): void {
    this.focusHandlers.push(cb);
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.stdin.on("data", this.handleData);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.stdin.off("data", this.handleData);
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  /** Feed raw bytes directly — used by `start()` on real stdin and by tests. */
  feed(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.drain();
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      const result = consumeOne(this.buffer);
      if (result === INCOMPLETE) return; // wait for more bytes, no timer
      if (result === AMBIGUOUS_ESCAPE) {
        this.armEscapeTimer();
        return;
      }
      this.clearEscapeTimer();
      this.buffer = this.buffer.slice(result.length);
      if (result.event) this.dispatch(result.event);
    }
  }

  private armEscapeTimer(): void {
    if (this.escTimer !== null) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.buffer.length > 0 && this.buffer.charCodeAt(0) === ESC) {
        this.buffer = this.buffer.slice(1);
        this.dispatch({
          kind: "key",
          key: {
            name: "escape",
            ctrl: false,
            shift: false,
            alt: false,
            raw: "\x1b",
          },
        });
        this.drain();
      }
    }, ESCAPE_TIMEOUT_MS);
  }

  private clearEscapeTimer(): void {
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  private dispatch(event: Event): void {
    if (event.kind === "key") {
      for (const cb of this.keyHandlers) cb(event.key);
    } else {
      for (const cb of this.focusHandlers) cb(event.focused);
    }
  }
}
