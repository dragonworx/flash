// fsapi/preview.ts — text file preview: pipe a file through `bat` for
// syntax-highlighted output when it's on PATH, otherwise fall back to
// `cat` for plain text, per the feature's own spec. Both run as real
// subprocesses via `node:child_process` — not `Bun.spawn` — for the same
// reason `fsapi/ops/chmod.ts`'s fallback reaches for `execFile` instead of
// `bun:ffi`: it has to keep working on the plain-Node/npm distribution path
// (see term/width.ts's file header for the same constraint). Running the
// real binaries means bat's syntax highlighting, theme selection, and
// binary-file detection all come for free instead of being reimplemented
// here.
//
// Never called on anything but a regular file (or a symlink resolving to
// one) — state/store.ts's `startPreview` is the only caller and already
// filters out directories, archives, and device/socket/fifo entries before
// this ever runs, which matters because piping a FIFO or character device
// through `cat` can block forever.

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

export type PreviewResult =
  | { ok: true; raw: string; colored: boolean; truncated: boolean }
  | { ok: false; error: string };

// Stdout collected before a preview is cut off — generous for any real
// source file, small enough that a huge (or still-growing) file can't
// stall the app or blow up memory just because Enter was pressed on it.
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

let batAvailable: boolean | null = null;

/**
 * Search `PATH` by hand rather than shelling out to `which`/`command -v`
 * (a second subprocess just to decide which subprocess to run) or
 * `Bun.which` (unavailable on the plain-Node distribution path). Cached —
 * `PATH` doesn't change over the life of the process.
 */
function commandExists(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      // Not in this directory — keep looking.
    }
  }
  return false;
}

function hasBat(): boolean {
  if (batAvailable === null) batAvailable = commandExists("bat");
  return batAvailable;
}

/** Test-only: force the next `previewFile()` call to re-probe PATH for `bat`. */
export function resetBatProbeForTests(): void {
  batAvailable = null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `bat`/`cat` against `path`, collecting stdout (capped at
 * `MAX_PREVIEW_BYTES` — the subprocess is killed the moment the cap is
 * hit) and stderr. `signal` cancels by killing the subprocess, the same
 * shape as every other cancellable job in fsapi/ops/queue.ts.
 */
export function previewFile(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PreviewResult> {
  const colored = hasBat();
  const cmd = colored ? "bat" : "cat";
  const args = colored
    ? [
        "--color=always",
        "--style=numbers",
        "--paging=never",
        "--wrap=never",
        "--",
        path,
      ]
    : ["--", path];

  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: errorMessage(err) });
      return;
    }

    let settled = false;
    const onAbort = () => proc.kill();
    const finish = (result: PreviewResult) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    opts.signal?.addEventListener("abort", onAbort);

    const outChunks: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    const errChunks: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (outBytes + chunk.length > MAX_PREVIEW_BYTES) {
        outChunks.push(
          chunk.subarray(0, Math.max(MAX_PREVIEW_BYTES - outBytes, 0)),
        );
        outBytes = MAX_PREVIEW_BYTES;
        truncated = true;
        proc.kill(); // nothing past the cap will ever be read
        return;
      }
      outChunks.push(chunk);
      outBytes += chunk.length;
    });
    proc.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

    proc.once("error", (err) => {
      // ENOENT etc. — the binary vanished from PATH between the
      // commandExists() probe and now, or isn't actually executable.
      finish({ ok: false, error: errorMessage(err) });
    });

    proc.once("close", (code) => {
      if (opts.signal?.aborted) {
        finish({ ok: false, error: "cancelled" });
        return;
      }
      const raw = Buffer.concat(outChunks).toString("utf8");
      if (!truncated && code !== 0 && raw.length === 0) {
        const stderrText = Buffer.concat(errChunks).toString("utf8").trim();
        finish({ ok: false, error: stderrText || `exited ${code}` });
        return;
      }
      finish({ ok: true, raw, colored, truncated });
    });
  });
}
