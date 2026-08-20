#!/usr/bin/env bun
// build.ts — flash's bundler, driven through the Bun.build() API rather
// than a bare `bun build` CLI line (house style — modeled on
// /home/dev/github/kb/build.ts).
//
// Two genuinely different outputs, because they target two different
// runtimes:
//
//   - npm (`dist/flash.js`, `buildNpm` below): a single Node-compatible
//     bundle, `target: "node"`. This is exactly why term/width.ts carries a
//     `Bun.stringWidth` fallback and fsapi/ops/chmod.ts falls back to
//     `fs.promises.chmod` when `bun:ffi` can't be loaded — dist/flash.js
//     runs under plain `node`, where neither exists. Not a nicety; it's a
//     packaging requirement (see the plan's "Phase 9" and README's install
//     instructions).
//
//   - binary (`dist/flash`, `buildBinary` below): a self-contained
//     executable via `bun build --compile`. As of Bun 1.3.14, `--compile`
//     has no equivalent in the `Bun.build()` JS API at all, so this shells
//     out to the real `bun` CLI instead of calling into the bundler
//     programmatically — the one place in this file that isn't "just"
//     Bun.build(). No other project on this machine uses --compile, so:
//     this is new territory here, not a copy-paste of an established
//     pattern. Expect roughly 95MB on linux-x64 and 63MB on darwin-arm64 —
//     that's an embedded Bun runtime baked into the executable, not a bug —
//     the app's own code is a rounding error next to it, so no flag here
//     moves the needle much on size. `--minify` is wired up below as the
//     one lever that's actually safe to flip; `--bytecode` (which the plan
//     names as the other half of that lever, for faster startup rather
//     than size) is deliberately NOT used — verified on this machine,
//     `bun build --compile --bytecode` fails outright on this codebase
//     with "await can only be used inside an async function" at
//     src/main.ts's top-level `await loadConfig()`. Bun's bytecode
//     compilation does not support top-level await as of 1.3.14. Fixing
//     that would mean wrapping main.ts's whole body in an async IIFE,
//     which is a real restructure or entry point, not a build-script
//     change — left alone rather than done as a packaging afterthought.
//
// Usage:
//   bun build.ts                                   # npm bundle -> dist/flash.js
//   bun build.ts --clean                            # rm -rf dist first
//   bun build.ts --binary                           # compile for the current platform -> dist/flash
//   bun build.ts --binary --target bun-linux-x64     # cross-compile (downloads that
//   bun build.ts --binary --target bun-darwin-arm64  # target's runtime on first use — needs network)
//   bun build.ts --binary --minify                  # smaller/slower-to-parse output; see the --bytecode note above
//   bun build.ts --all                               # npm bundle + a current-platform binary

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("./", import.meta.url).pathname;
const ENTRY = join(ROOT, "src", "main.ts");
const DIST = join(ROOT, "dist");

function ensureDist(): void {
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
}

// ── npm bundle: dist/flash.js, runs under `node` ──

/**
 * Bundle `src/main.ts` into a single Node-compatible ESM file at
 * `dist/flash.js`, shebang'd `#!/usr/bin/env node` (not `#!/usr/bin/env
 * bun`, which src/main.ts itself carries for the clone-and-run path — this
 * output is the one npm actually installs and chmods executable via
 * package.json's `bin` field) so it runs correctly wherever the `flash`
 * command ends up: a machine with only Node installed, not Bun.
 */
export async function buildNpm(minify = false): Promise<boolean> {
  ensureDist();
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: DIST,
    target: "node",
    format: "esm",
    minify,
    sourcemap: minify ? "none" : "linked",
    naming: "flash.js",
  });
  if (!result.success) {
    console.error("npm build failed:");
    for (const log of result.logs) console.error(String(log));
    return false;
  }

  // Bun's bundler auto-copies the entrypoint's own shebang
  // (`#!/usr/bin/env bun` — src/main.ts needs that one for the
  // clone-and-run path) as the bundle's first line. A shebang only means
  // anything on line 1, so `Bun.build()`'s `banner` option is no good
  // here: it inserts *after* that auto-copied line, silently producing a
  // file whose real (line-1) shebang still launches `bun`, with a second,
  // inert `#!/usr/bin/env node` line beneath it doing nothing. Fixed by
  // hand instead: strip whatever shebang line Bun copied over and prepend
  // the one this output actually needs.
  const outfile = join(DIST, "flash.js");
  const bundled = readFileSync(outfile, "utf8");
  const rewritten = `#!/usr/bin/env node\n${bundled.replace(/^#!.*\n/, "")}`;
  writeFileSync(outfile, rewritten, "utf8");

  // package.json's `bin` field only makes npm chmod this on *install*;
  // chmod it here too so `./dist/flash.js` is directly runnable right after
  // a local build, same as the compiled binary below.
  chmodSync(outfile, 0o755);
  return true;
}

// ── standalone binary: dist/flash (or dist/flash-<target>), no runtime needed ──

export type BuildBinaryOptions = {
  /** e.g. "bun-linux-x64" or "bun-darwin-arm64" — omit for the host platform. */
  target?: string;
  /**
   * `--minify` only — NOT `--bytecode` too, despite the plan naming
   * `--minify --bytecode` as one lever. See this file's header: `--bytecode`
   * fails to compile this codebase at all (top-level await in main.ts).
   */
  minify?: boolean;
};

function binaryOutfile(target: string | undefined): string {
  if (!target) return join(DIST, "flash");
  // "bun-linux-x64" -> "flash-linux-x64"; strips the redundant "bun-"
  // prefix `--target` itself requires, since it's implied by the fact this
  // is a compiled binary at all.
  const suffix = target.replace(/^bun-/, "");
  return join(DIST, `flash-${suffix}`);
}

export async function buildBinary(
  options: BuildBinaryOptions = {},
): Promise<boolean> {
  ensureDist();
  const outfile = binaryOutfile(options.target);
  const args = ["build", ENTRY, "--compile", `--outfile=${outfile}`];
  if (options.target) args.push(`--target=${options.target}`);
  if (options.minify) args.push("--minify");

  const proc = Bun.spawn(["bun", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  return code === 0;
}

// ── clean ──

export function cleanDist(): void {
  rmSync(DIST, { recursive: true, force: true });
}

// ── CLI ──

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      clean: { type: "boolean", default: false },
      binary: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      target: { type: "string" },
      minify: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.clean) {
    console.log("Cleaning dist/ ...");
    cleanDist();
  }

  let ok = true;
  if (values.binary || values.all) {
    console.log(
      values.target
        ? `Compiling binary for ${values.target} ...`
        : "Compiling binary for the current platform ...",
    );
    ok =
      (await buildBinary({ target: values.target, minify: values.minify })) &&
      ok;
  }
  if (!values.binary || values.all) {
    console.log("Building npm bundle -> dist/flash.js ...");
    ok = (await buildNpm(values.minify)) && ok;
  }

  if (ok) {
    console.log("Build succeeded.");
  } else {
    console.error("Build failed.");
    process.exit(1);
  }
}
