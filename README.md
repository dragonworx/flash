# Flash

**Your file manager should be as fast as you think. This one is.**

`flash` is a full-screen, keyboard-driven terminal file manager. Every key
lands the instant you press it — no spinner, no redraw lag, no mouse to
reach for. Navigate, multi-select, copy/cut/paste with conflict resolution
and a live progress bar, rename, mkdir, delete, chmod, preview text files in
place, and browse zip archives like folders. List or grid, icons, sizes,
permissions, owner/group, modified time — all live-updated as files change
underneath you.

No mouse support. Not a gap — a decision: your terminal's native
click-drag text selection keeps working inside a `flash` pane.

Install in under a minute. Skim the keybindings below so nothing surprises
you once you're in.

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

*(That's a real render, not a mockup — `bun run src/main.ts --dump-frame
--no-color --size 92x24 -d src` renders one frame as plain text and exits.
No PTY needed, which is exactly how this project catches layout regressions
in CI instead of squinting at a live terminal.)*

Plays nicely as a panel inside `herdr` or tmux, too: reads its size from the
pty, announces cwd via OSC 7 and title via OSC 0, coalesces repaints while
unfocused, and wraps every frame in synchronized-output escapes so your
multiplexer never tears mid-repaint.

## Install

**Clone and run** (needs [Bun](https://bun.sh) ≥ 1.3):

```sh
curl -fsSL https://bun.sh/install | bash   # skip if `bun --version` already prints ≥ 1.3
git clone <repo-url> flash && cd flash
bun install
bun run start                # or: bun run src/main.ts -d ~/some/directory
```

**npm** (package name `flash-tui` — `flash` was taken):

```sh
npm install -g flash-tui
flash
```

Not published yet. Until then: `bun run build && npm link` gets you the
same `flash` command, running from `dist/flash.js`.

**Standalone binary** (no Bun or Node needed on the target machine):

```sh
bun run build:binary         # dist/flash — see build.ts
./dist/flash
```

**One step, on your PATH:**

```sh
bun mount                    # -> ~/.local/bin/flash
flash                        # works from anywhere now
bun unmount                  # removes it again
```

Installs to `~/.local/bin` by default (override with `FLASH_BIN_DIR`, e.g.
`FLASH_BIN_DIR=/usr/local/bin sudo -E bun mount` for all users). It's a
*copy* — `git pull` won't update it, re-run `bun mount` after pulling. Want
it to track your working tree instead? Use `bun run build && npm link`.

Roughly 95 MB on linux-x64 / 63 MB on darwin-arm64 — that's an embedded Bun
runtime, not bloat from `flash` itself. `--minify` is the only lever worth
pulling.

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

Every flag is also a config-file setting (below), with flags winning for
that run. Sort order, view mode, and hidden-file visibility get written
back to the config file whenever you change them in-app.

## Keybindings

Press `?` inside flash for the full, always-current list — generated
straight from the same table below, so it can never drift from what a key
actually does. `Esc` is context-sensitive: closes an overlay › clears marks
› leaves an archive › goes up a directory (first match wins). `←`, `h`, and
`Backspace` always go up.

| Keys | Action |
| --- | --- |
| **Navigation** | |
| `Esc` | Close overlay › clear marks › leave archive › go up (first that applies) |
| `↑` `↓` | Move (list) · move a row (grid) |
| `←` `→` | Go up / open (list) · move left/right (grid) |
| `k` `j` | Move cursor up / down |
| `Enter` `Space` `l` | Open the selected entry — enter a directory, or open text file preview |
| `h` `Backspace` | Go up a directory, always |
| `PgUp` `PgDn` | Page up / down |
| `Home` `End` | Jump to first / last entry |
| `b` | Open goto bookmarks and jump to one |
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

### File preview

`Enter`/`Space`/`l` on a text file opens a near-full-screen, scrollable
preview without ever leaving `flash`. It shells out to
[`bat`](https://github.com/sharkdp/bat) for syntax highlighting when
available, falling back to plain `cat` — real subprocess, real highlighting,
zero reimplemented logic. Directories, archives, and device/socket/fifo
entries just open or enter as usual.

### Goto bookmarks — and why you want `goto` too

Press `b` and jump straight to any bookmark from
[`goto`](https://github.com/dragonworx/goto), the directory-jump shell tool
that ends `cd ../../../projects/thing-i-forgot-the-path-to` forever. `flash`
reads goto's bookmark file (never writes it), re-reading it live so a
bookmark added or removed in another terminal shows up immediately — no
restart. Bookmarked directories get a `★` wherever they appear, in the
breadcrumb and in the file list.

Don't have `goto` installed? You're missing half the reason this feature is
good. It's a tiny, fast, no-dependency way to name a directory once and
warp back to it from any shell, forever — pair it with `flash`'s `b` picker
and you stop typing `cd` altogether. Nothing breaks if you skip it: `b`
just reports no bookmarks found.

## Config file

`$XDG_CONFIG_HOME/flash/config.json`, falling back to `~/.config/flash/config.json`.
Written atomically whenever you change view mode, sort order, or hidden-file
visibility in-app. Missing or corrupt file? Never fatal — falls back to
defaults, per field.

```json
{
  "view": "list",
  "sort": { "key": "name", "dirsFirst": true, "reverse": false },
  "showHidden": false,
  "icons": "unicode"
}
```

`sort.key`: `name` | `size` | `mtime` | `extension`. `icons`: `unicode`
(default) | `nerd` (Nerd Font glyphs) | `ascii` (plain glyphs for terminals
that can't render extended characters).

## My terminal is broken

If flash (or anything that grabbed raw mode / the alternate screen buffer)
crashed and left your shell looking wrong, run:

```sh
stty sane; printf '\e[?1049l\e[?25h'
```

or `bun run reset` from inside the repo (same fix, plus a full SGR reset).
This should never be necessary — flash installs crash guards on every
signal it can catch — but `SIGKILL` is unrecoverable by definition, and this
is the escape hatch for it.

## Known limitations

- **No single-member copy out of an archive.** `copy`/`cut` refuse inside a
  `.zip`; `u` (extract the whole archive) is the supported way out today.
  Deliberate, not an oversight.
- **Zip only** — no `.tar`/`.tar.gz`/`.7z` browsing yet. See `SPEC.md` and
  the plan for why (`fflate` has no native `.tar` support). Read-only
  `.tar.gz` listing is a plausible follow-up.
- **No ZIP64, no encrypted zips** (an `fflate` limitation) — archives over
  4 GB, over 65,535 entries, or password-protected, aren't supported.
