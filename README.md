# flash

A full-screen, keyboard-driven terminal file manager. `flash` renders a
directory as a list or a grid — icons, sizes, permissions, owner/group,
modified time — lets you navigate, multi-select, copy/cut/paste with
conflict resolution and progress, rename, mkdir, delete, edit permissions,
and browse zip archives as if they were folders, all with live updates when
files change underneath it. No mouse support, on purpose: your terminal's
own click-drag text selection keeps working inside a `flash` pane.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ / › home › dev › github › fs › src                                                       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
     Name                                       Size       Mode    Owner    Group   Modified
────────────────────────────────────────────────────────────────────────────────────────────
  📁 ..                                            - drwxrwxr-x      dev      dev   just now
› 📁 fsapi                                         - drwxrwxr-x      dev      dev     6h ago
  📁 state                                         - drwxrwxr-x      dev      dev     9m ago
  📁 term                                          - drwxrwxr-x      dev      dev    12h ago
  📁 ui                                            - drwxrwxr-x      dev      dev     6h ago
  📄 config.ts                                  4.5K -rw-rw-r--      dev      dev    13h ago
  📄 keymap.ts                                   21K -rw-rw-r--      dev      dev     4m ago
  📄 main.ts                                     26K -rw-rw-r--      dev      dev     7m ago
────────────────────────────────────────────────────────────────────────────────────────────
7 items
```

(That's a real render — `bun run src/main.ts --dump-frame --no-color --size 92x24 -d src`,
which renders exactly one frame as plain text and exits. No PTY required; it's how this
project catches layout regressions in CI instead of squinting at a live terminal.)

`flash` also works well as a panel inside `herdr` or tmux: it reads
its size from the pty (not `$COLUMNS`/`$LINES`), announces the current directory via OSC 7
and the window title via OSC 0, coalesces repaints while its pane is unfocused, and wraps
every frame in synchronized-output escapes so a multiplexer never tears mid-repaint.

## Install

**Clone and run** (needs [Bun](https://bun.sh) ≥ 1.3):

```sh
git clone <repo-url> flash && cd flash
bun install
bun run start                # or: bun run src/main.ts -d ~/some/directory
```

**npm** (package name `flash-tui` — the bare name `flash` was already taken):

```sh
npm install -g flash-tui
flash
```

This package isn't published yet. Until then, build and link it locally to get the same
result: `bun run build && npm link` (from the repo root), which installs the `flash` command
from the Node-compatible `dist/flash.js` build described below.

**Standalone binary** (no Bun or Node required on the target machine):

```sh
bun run build:binary         # dist/flash — see build.ts
./dist/flash
```

Expect roughly 95 MB on linux-x64 (and about 63 MB on darwin-arm64) — that's an embedded
Bun runtime, not a bug. `--minify --bytecode` is the only meaningful size lever, and
`build.ts` documents why cross-compiling (`--target=bun-linux-x64` /
`--target=bun-darwin-arm64`) needs network access the first time it runs.

## Usage

```
flash [-d|--dir <path>]      directory to open; defaults to the current directory
      [--view list|grid]     initial view mode
      [--icons unicode|nerd|ascii]
      [--hidden]             show dotfiles from the start
      [--no-color]           also implied by NO_COLOR or a non-TTY stdout
      [--dump-frame --size WxH]   render one frame as text and exit
      [--help] [--version]
```

Anything settable by a flag is also readable from the config file (below), with flags
winning for that run. Sort order, view mode, and hidden-file visibility are written back to
the config file whenever you change them in-app.

## Keybindings

Press `?` inside flash for the full, always-up-to-date list — it's generated directly from
the same table this section is transcribed from, so it can never drift from what a key
actually does. `Esc` is context-sensitive: it closes an open overlay, else clears marks,
else leaves an archive at its root, else goes up a directory (first match wins). `←`, `h`,
and `Backspace` always go up, regardless of state.

| Keys | Action |
| --- | --- |
| **Navigation** | |
| `Esc` | Close overlay › clear marks › leave archive › go up (first that applies) |
| `↑` `↓` | Move (list) · move a row (grid) |
| `←` `→` | Go up / open (list) · move left/right (grid) |
| `k` `j` | Move cursor up / down |
| `Enter` `Space` `l` | Open the selected entry |
| `h` `Backspace` | Go up a directory, always |
| `PgUp` `PgDn` | Page up / down |
| `Home` `End` | Jump to first / last entry |
| **Selection** | |
| `Tab` | Toggle the mark on the entry under the cursor |
| `Shift+↑` `Shift+↓` | Extend the marked range from the cursor |
| `Ctrl+A` | Mark every entry in the directory |
| **File operations** | |
| `c` / `x` | Copy / cut marked entries (or the entry under the cursor) |
| `p` | Paste the clipboard into the current directory |
| `r` | Rename the entry under the cursor |
| `n` | Create a new directory |
| `d` `Delete` | Delete marked entries (or the entry under the cursor) — confirms with `y` |
| `m` | Edit permissions (chmod) |
| **Archives** | |
| `z` | Zip marked entries (or the cursor entry) into a new archive |
| `u` | Extract the archive under the cursor here |
| **View** | |
| `v` | Toggle list/grid view |
| `.` | Toggle hidden files |
| `s` / `S` | Cycle sort order / reverse it |
| **App** | |
| `?` | Show the help overlay (scrollable; `?` again or `Esc` closes it) |
| `q` `Ctrl+C` | Quit |

## Config file

`$XDG_CONFIG_HOME/flash/config.json`, falling back to `~/.config/flash/config.json`. Written
atomically (temp file + rename) whenever you change view mode, sort order, or hidden-file
visibility in-app; a missing or corrupt file is never fatal — flash falls back to defaults,
per field if needed. Shape:

```json
{
  "view": "list",
  "sort": { "key": "name", "dirsFirst": true, "reverse": false },
  "showHidden": false,
  "icons": "unicode"
}
```

`sort.key` is one of `name` | `size` | `mtime` | `extension`. `icons` is one of `unicode`
(default) | `nerd` (Nerd Font glyphs) | `ascii` (plain ASCII glyphs, for terminals or
captured logs that can't render extended characters at all — independent of color, which
`--no-color`/`NO_COLOR` control separately).

## My terminal is broken

If flash (or anything that crashed while it had the terminal in raw mode / the alternate
screen buffer) leaves your shell looking wrong — invisible cursor, garbled input, a dead
screen — run:

```sh
stty sane; printf '\e[?1049l\e[?25h'
```

or, from inside the repo, `bun run reset`, which does the same thing plus a full SGR reset.
This should never be necessary — flash installs crash guards on `SIGTERM`/`SIGHUP`/
`SIGQUIT`/`SIGINT`/`uncaughtException`/`unhandledRejection` that restore the terminal before
exiting — but `SIGKILL` is unrecoverable by definition, and this is the escape hatch for it.

## Known limitations

- **No single-member copy out of an archive via the clipboard.** `copy`/`cut` refuse while
  browsing inside a `.zip` (there's nothing on the clipboard's other end that would make
  sense for a partial extraction); `u` (extract the whole archive into the current
  directory) is the supported way to get contents out today. This is a deliberate,
  recorded gap, not an oversight.
- **Zip only.** No `.tar`/`.tar.gz`/`.7z`/etc. browsing — see `SPEC.md` and the plan for why
  (`fflate` has no native `.tar` support, and shelling out to system tools was ruled out for
  a self-contained binary). Read-only `.tar.gz` listing is a plausible follow-up.
- **No ZIP64, no encrypted zips** (a `fflate` limitation): archives over 4 GB or with more
  than 65,535 entries, or password-protected zips, aren't supported.
