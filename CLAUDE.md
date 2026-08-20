# CLAUDE.md

Guidance for agents working on **flash** — a full-screen, keyboard-driven terminal file manager (command `flash`, npm package `flash-tui`; the repo directory stays `fs`).

## Stack

- **Runtime & tooling:** Bun (1.3.14 on this machine) — runtime, test runner (`bun:test`), bundler (`build.ts` calls `Bun.build()`), and `bun build --compile` for standalone binaries.
- **Zero runtime dependencies except `fflate`** (zip). No chalk/picocolors/ansi-escapes, no Ink/React/blessed — the renderer, ANSI, and input parsing are all hand-rolled. This is deliberate, not an oversight; see "Match the house conventions" in the plan below before reaching for a library.
- **Full plan:** `/home/dev/.claude/plans/expressive-discovering-squid.md` — read it before touching anything non-trivial. It documents *why*, not just *what*, for every decision below.

## Architecture

Data flows one way: **input → action → state → render**. `term/input.ts` turns raw stdin bytes into `Key` events; `keymap.ts` maps a `Key` (plus, for Escape, the current `AppState`) to an `Action` — the only place key bindings live, via a single `BINDINGS` table that both dispatches and feeds the generated `?` help overlay. `state/store.ts`'s `Store` is the only thing that mutates `AppState` (cwd, entries, cursor, marks, clipboard, overlay, archive); it notifies subscribers, and `main.ts`'s `requestRepaint()` schedules one `draw()` on the next microtask — never a fixed-rate loop. `draw()` computes layout (`ui/chrome.ts`'s `computeFrame`) and writes cells into a `Screen` (`term/screen.ts`), which diffs against the previous frame and emits only the changed runs. Nothing outside `Screen` ever writes to stdout directly. `fsapi/` is the filesystem layer (scan, watch, copy/move/delete, chmod, zip) and never imports from `ui/` or `state/`; `ui/` renders whatever `state/` hands it and never touches the filesystem itself.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run start` / `bun run dev` | Run flash (`--hot` for dev) |
| `bun test` | Full test suite (`tests/*.test.ts`) |
| `bun run typecheck` | `tsc --noEmit` — the real quality gate |
| `bunx biome check src/ tests/` | Lint + format check |
| `bun run build` | `build.ts` → `dist/flash.js` (npm/Node target) |
| `bun run reset` | `stty sane` + leave-alt-screen/show-cursor, for when a crash leaves your terminal wedged |

## Invariants a future contributor must not break

- **Width is measured in exactly one place: `term/width.ts`.** It wraps `Bun.stringWidth()` (with a Node-compatible fallback for the npm distribution path) and is the only module allowed to call it. `String.length` is wrong for CJK, emoji, and combining marks — every row-rendering and truncation call site routes through here. If you find yourself measuring a string's on-screen width anywhere else, that's the bug.
- **`fs.promises.cp` is banned.** Bun 1.3.14 segfaults copying a directory into its own descendant — it recurses forever creating `a/b/a/b/a/b/…` until the disk fills, and a segfault bypasses every JS handler and takes the terminal down with it. `fsapi/ops/copy.ts` walks the tree itself; `fsapi/ops/guard.ts` rejects copy-into-self (and copy-into-descendant) *before* a job is ever queued, after `realpath`ing both sides so a symlink can't launder the check.
- **Delete-after-verify consumes `copiedSources`, structurally.** `copyAll()` (`fsapi/ops/copy.ts`) returns the list of sources it *verifiably* copied; `fsapi/ops/move.ts`'s cut-across-filesystems fallback only deletes paths that appear in that list. An aborted or partially-failed copy yields a shorter (or empty) list, so a mid-copy failure structurally deletes nothing — this is not a "be careful" comment, it's the actual mechanism. Don't refactor this into "copy, then delete everything the job intended to copy."
- **Bun's `chmod` masks high bits — use `fsapi/ops/chmod.ts`, never `node:fs`'s `chmod`/`chmodSync` directly.** Verified on this machine: `fs.promises.chmod(path, 0o4755)` silently writes `0o755`, dropping setuid every time. `chmodPreserving()` calls real POSIX `chmod(2)` via `bun:ffi`/`dlopen`, falling back to `fs.promises.chmod` only when FFI is unavailable (plain Node, `dlopen` failure). If you're setting permissions, this is the only correct entry point — and if you're reviewing a permissions change, check that setuid/setgid/sticky bits are being preserved via `(st.mode & ~0o777) | rwxBits`, not clobbered.
- **Never read an `fs.watch` event payload.** A verified rename (`a` → `b`) delivered only `["rename", "a.txt"]` — the arrival of `b` was simply lost. `fsapi/watch.ts` treats every event as an opaque "something changed, rescan" signal; do not try to apply an event incrementally based on its filename or event type.

Two more worth knowing even though nothing above depends on you personally re-breaking them: never resolve config or asset paths from `import.meta.dir` (it's `/$bunfs/root` inside a `--compile` binary — use `os.homedir()`), and never emit mouse-reporting escape sequences (no mouse support is a deliberate product decision, not a gap — see the plan).

## Testing

`bun test` runs everything in `tests/*.test.ts` (not colocated `__tests__`). Filesystem-touching tests use a temp fixture directory, never the repo or home directory. `tests/dump-frame.test.ts` spawns the real CLI with `--dump-frame --size WxH` to snapshot a rendered frame as plain text with no PTY required — the fastest way to catch a layout regression; reach for it before squinting at a live terminal. `bun run typecheck` and `bunx biome check src/ tests/` are both expected to be clean before a commit.
