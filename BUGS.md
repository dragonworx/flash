# Upstream bugs found while building flash

Four defects in Bun, found by building a file manager on top of it. Each was hit
in ordinary use, not by fuzzing or by reaching for exotic APIs — in every case the
*obvious* way to write the code was the broken way, which is what makes them worth
writing down.

Every reproduction below was run on this machine and its output pasted verbatim.
Where Node does the right thing, the Node result is included as the control.

```
Bun    1.3.14 (0d9b296a)
Node   v24.18.1
Kernel Linux 7.0.0-28-generic x86_64
FS     ext4 on /dev/sda1
```

Severity is rated by consequence to a user of the program, not by how hard the bug
is to hit.

---

## 1. `fs.promises.cp` segfaults copying a directory into its own descendant

**Severity: critical.** Crashes the process, fills the disk on the way, and cannot
be caught.

Node rejects this call with a clean error. Bun instead recurses forever, creating
`a/b/copy/b/copy/b/…` until it dies with SIGSEGV.

```ts
// repro.ts
import { cp } from "node:fs/promises";
await cp(`${W}/a`, `${W}/a/b/copy`, { recursive: true });
```

```console
$ mkdir -p $W/a/b && echo x > $W/a/f.txt
$ bun repro.ts
  bun exit code: 139          # 139 = SIGSEGV
  dirs created under a/: 466
  disk used by repro: 1.9M    # in under 3 seconds

$ node repro.ts
  node: ERR_FS_CP_EINVAL - Invalid src or dest: cp returned EINVAL
        (cannot copy /home/dev/…/a to a subdirectory of self /home/dev/…/a/b/copy)
  node exit code: 0
```

**Expected:** reject with `ERR_FS_CP_EINVAL`, as Node does and as the containment
check in Node's own `cp` implementation is designed to.

**Actual:** unbounded recursion, then SIGSEGV. The 466 directories above were
created in under three seconds; left unbounded this exhausts the filesystem.

**Why it matters beyond the crash:** SIGSEGV bypasses every JavaScript handler —
`process.on("exit")`, `uncaughtException`, signal handlers, all of it. For a
full-screen terminal application that means the alternate screen buffer is never
exited, the cursor is never restored, and raw mode is never released. The user is
left with an unusable shell on top of a partially filled disk. There is no
in-process mitigation, because no in-process code runs after the crash.

**Workaround in flash:** `fs.promises.cp` is banned outright
(`src/fsapi/ops/guard.ts` documents why, and `src/fsapi/ops/copy.ts` implements
recursive copy by hand). A containment guard runs before any copy or move,
`realpath`ing both sides so a symlinked destination cannot launder its way back
into the source.

---

## 2. `fs.chmod` silently discards setuid, setgid, and the sticky bit

**Severity: high.** Silent, permanent, and invisible from inside Bun.

Both `fs.chmodSync` and `fs.promises.chmod` mask the mode to its low nine bits
before the syscall. The call reports success. Nothing warns.

```console
$ bun  -e 'require("fs").chmodSync(F, 0o4755)'
  stat -> 755          # setuid silently dropped

$ node -e 'require("fs").chmodSync(F, 0o4755)'
  stat -> 4755         # correct
```

**Expected:** `chmod(path, 0o4755)` sets mode `04755`, matching `chmod(2)`,
`/bin/chmod`, and Node.

**Actual:** mode `0755` is written. The high three bits are dropped for every
value, every time.

**Why it is easy to miss:** only the *write* path is affected. `lstat` reads
special bits back correctly when they were set by some other means, so a
round-trip test written entirely in Bun — set the bits, read them back — can look
fine while the bits were never persisted. Catching it requires checking against
something outside Bun, such as `/usr/bin/stat`.

**Consequence:** any tool that offers a permissions editor will silently strip the
setgid bit from a group-shared directory, or the sticky bit from a shared temp
directory, the first time a user adjusts an unrelated permission. The directory
keeps working until someone notices new files have the wrong group.

**Workaround in flash:** `src/fsapi/ops/chmod.ts` calls POSIX `chmod(2)` directly
through `bun:ffi`, dynamically imported so the module still loads under plain Node
(where `chmod` is correct and `bun:ffi` does not exist). Verified to survive
`bun build --compile` into a standalone binary:

```console
# run from the compiled binary, not `bun run`
plain Bun fs.chmodSync(4755) -> 755
chmodPreserving(7755)        -> 7755
external /usr/bin/stat       -> 7755
```

The first version of that workaround had a hole worth recording, because it is the
shape of mistake this whole bug invites. When `dlopen` failed it fell straight back
to `fs.promises.chmod` — silently reintroducing the defect. That was not a
theoretical path: the libc soname is guessed, and `libc.so.6` does not exist on
musl, so every Bun build on Alpine would have taken it.

The fix is to stop trying to predict *why* the fast path might be unavailable.
When special bits are actually requested, the result is read back from disk; if
they did not stick, it escalates to `/bin/chmod`, and if that also fails it throws
rather than reporting a success that did not happen. Confirmed inside a compiled
binary with FFI forcibly disabled:

```console
compiled binary, FFI disabled -> 4755
external stat confirms        -> 4755
```

`tests/chmod-fallback.test.ts` covers the degraded paths through a test seam, since
they are otherwise unreachable on a glibc machine. Four of its six tests fail if
the verification step is removed.

---

## 3. `Bun.build()`'s `banner` does not replace an entrypoint's shebang

**Severity: medium.** Ships a broken executable, with no error at build time.

When the entrypoint begins with a shebang, Bun copies that shebang to line 1 of
the bundle and places the requested `banner` on line 3 — leaving two shebangs in
the file, of which the *effective* one is the source's rather than the one asked
for.

```ts
await Bun.build({
  entrypoints: ["e.ts"],           // e.ts starts with #!/usr/bin/env bun
  outdir: "out",
  target: "node",
  banner: "#!/usr/bin/env node",
});
```

```console
$ grep -n 'env node\|env bun' out/e.js
1:#!/usr/bin/env bun     ← line 1, so this is the one the kernel uses
3:#!/usr/bin/env node    ← the requested banner, inert

# with no shebang in the source, the banner lands correctly:
$ head -1 out2/e2.js
#!/usr/bin/env node
```

**Expected:** either the banner replaces the copied shebang, or the combination is
rejected. A bundle explicitly targeting `node` should not be left with a `bun`
shebang.

**Actual:** two shebangs; the source's wins.

**Consequence:** the npm-distributed `bin` entry would have demanded Bun on
machines installing the package precisely because they *don't* have Bun. It fails
at exec time, not build time, so nothing catches it until a user hits it.

**Workaround in flash:** `build.ts` strips any leading shebang from the bundle and
prepends the correct one by hand.

---

## 4. `--bytecode` reports a misleading parse error on top-level `await`

**Severity: low.** Correct refusal, actively misleading diagnostic.

```console
$ printf 'await Promise.resolve();\nconsole.log("hi");\n' > tla.ts
$ bun build tla.ts --compile --bytecode --outfile tlabin
                 ^
error: Unexpected .
    at tla.ts:1:14
```

**Expected:** something naming the actual constraint — that bytecode compilation
requires a CommonJS-compatible module and does not support top-level `await`.

**Actual:** `Unexpected .` pointing into the middle of `Promise.resolve()`, which
reads as a syntax error in valid code. The word "bytecode" does not appear.

Bytecode's incompatibility with top-level `await` is a documented limitation, so
the refusal is correct; only the diagnostic is the defect. Without knowing the
limitation in advance, the error sends you hunting for a syntax problem that isn't
there.

**Workaround in flash:** `build.ts` uses `--minify` without `--bytecode`, with a
comment recording why.

---

## Not a bug: `process.on("exit")` and SIGTERM

Recorded here because it was initially reported to me as Bun-specific, and it is
not — I checked, and Node behaves identically:

```console
bun  on SIGTERM: 0 exit-handler run(s)
node on SIGTERM: 0 exit-handler run(s)
```

Default SIGTERM disposition terminates the process without unwinding, so `exit`
handlers do not run in either runtime. This is standard POSIX behaviour, not a
defect. The mitigation is the same everywhere: install an explicit `SIGTERM`
handler that performs cleanup and then calls `process.exit()`.

It is worth stating plainly because the practical consequence for a full-screen
application is real — a SIGTERM'd process leaves the terminal in the alternate
screen with a hidden cursor — even though the cause is not a Bun bug. flash
installs handlers for `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGINT`,
`uncaughtException`, and `unhandledRejection`, all routed through one idempotent
`restore()`.

---

## Appendix: non-Bun findings

Two defects in [`fflate`](https://github.com/101arrowz/fflate) 0.8.x, included for
completeness since they shaped the same codebase. Neither is a Bun bug — the first
reproduces under Node as well.

**The async callback API is broken in both runtimes.** `unzip(buf, cb)` throws
`"undefined is not an object (evaluating 'dat.length')"` under Bun and
`"u8 is not defined"` under Node 24. `gzip` and `deflate` async fail likewise.
Only the synchronous and streaming APIs work, so streaming is the only viable
non-blocking path.

**The central-directory reader ignores external file attributes.** `fflate` writes
the field when creating an archive but never parses it when reading one, so unix
permissions are lost on a round trip through its own format. flash reads mode and
mtime from the central directory directly.

Also worth recording as a limitation rather than a bug: `fflate` supports neither
ZIP64 nor encryption, so archives above 4 GB or 65,535 entries are out of scope.
flash fails these with a clear message rather than producing a corrupt archive.
