// fsapi/archive/zip.ts — create / list / extract zip archives, wrapping
// `fflate`. Three DISTINCT fflate entry points, one per job, per the plan's
// Phase 8 section — do not consolidate them, they exist to fix three
// separate problems.
//
// **Do not use fflate's async callback API** (`unzip(buf, cb)`,
// `zip(data, cb)`). Verified broken on this machine: it throws
// "undefined is not an object (evaluating 'dat.length')" under Bun and
// "u8 is not defined" under Node 24. Only the sync and streaming APIs work.
//
//   - list    -> `unzipSync(buf, { filter })`, returning `false` from the
//                filter so metadata is collected without ever decompressing
//                anything: measured 0.4ms vs 508ms for the same archive.
//                CAREFUL, this is easy to get backwards: in that callback
//                `f.size` is the COMPRESSED size and `f.originalSize` is the
//                uncompressed one.
//   - extract -> the streaming `Unzip` class + `UnzipInflate`, fed chunk by
//                chunk from `fs.createReadStream`, calling `file.start()`
//                only on members actually wanted. This is the only path
//                that gives progress, `AbortSignal` support, and yielding —
//                `unzipSync` freezes the UI for seconds and can OOM on a
//                large archive.
//   - create  -> the streaming `Zip` + `ZipDeflate`, `os: 3` and
//                `attrs: mode << 16` so unix permissions round-trip.
//
// `listZip()` needs the whole file in memory either way (`unzipSync` always
// takes a `Uint8Array`, filter or not — the filter only skips
// *decompression*, not the read), so `extractZip()` below calls it once up
// front for metadata (names, sizes, mode, mtime — cheap, no decompression)
// and then does the actual byte-moving through the streaming path, which
// never holds more than a few chunks of one archive in memory at a time.
// That split is what keeps extraction safe on a large archive while list
// still gets to be the trivial `unzipSync` one-liner the plan asks for.
//
// ── the mode gap fflate doesn't fill ──
//
// fflate's central-directory reader (`zh()` in its own source) never reads
// the external-file-attributes field at all, on either the sync or
// streaming read path — there is no public (or even private) way to get a
// unix mode back out of an archive through fflate's API, even though
// `create()` below dutifully writes one (see `wzh()`: external attrs sit at
// a fixed +38 byte offset in every central directory record, standard
// PKZIP APPNOTE.txt s4.3.12, `os` at +5). So the mode (and mtime — DOS
// date/time live in the same record) round-trip the plan asks for needs a
// few fixed-offset reads done directly against the archive's own central
// directory: `readCentralDirectoryMeta()` below. This is not a general
// zip-container parser — fflate still owns everything else — it is reading
// the two fields fflate's public API happens to omit, verified against a
// real central directory record in this file's own testing.
//
// ── path traversal ──
//
// fflate does NOT reject `../` members — verified: a poisoned archive round-
// trips `../evil.txt` through `unzipSync` completely untouched, no error,
// no rejection. `safeMemberParts()` below is the guard: any member with an
// absolute path or a literal `..` component is rejected outright before any
// directory is ever created or any byte written. `ensureSafeDir()` closes
// the second half of this: a first, otherwise-safe-looking member could in
// principle create a directory that shadows a symlink pointing outside
// `destDir` for a later member to walk through (the classic "zip slip"
// second act) — so every intermediate directory component is walked one
// level at a time, and any component that already exists as anything other
// than a plain directory (symlink included) aborts that member rather than
// being followed.
//
// ── limits ──
//
// No ZIP64 (archives over 4GB or with more than 65,535 entries) and no
// encryption — both fflate limitations, not addressed here. `listZip()`
// detects a ZIP64 archive from its End Of Central Directory record (a
// 0xffffffff sentinel in the size/offset/count fields, or a ZIP64 locator
// immediately before it) and throws a clear error rather than silently
// truncating or misreading anything.

import {
  createReadStream,
  createWriteStream,
  constants as fsConstants,
} from "node:fs";
import {
  type FileHandle,
  chmod as fsChmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Unzip, UnzipInflate, Zip, ZipDeflate, unzipSync } from "fflate";

// ── shared types ──

export type ArchiveProgress = {
  done: number;
  total: number;
  currentPath: string;
  bytesDone: number;
  bytesTotal: number;
};

export type ArchiveError = { path: string; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

class ArchiveAbortedError extends Error {
  constructor() {
    super("archive operation aborted");
    this.name = "AbortError";
  }
}

// ── list ──

export type ZipEntryMeta = {
  /** Full member path within the archive, "/"-separated, no leading slash. */
  name: string;
  /** True for a directory member (the archive's own "/"-suffixed convention). */
  isDir: boolean;
  /** Uncompressed size in bytes — 0 for directories. */
  size: number;
  /** Compressed (on-disk) size in bytes. */
  compressedSize: number;
  /** PKZIP compression method id: 0 = stored, 8 = deflate. */
  compression: number;
  /** Unix mode (including S_IFDIR/S_IFREG type bits) when recoverable from
   * the central directory (`os === 3` — see the file header); a sane
   * default (0o40755 for dirs, 0o100644 for files) otherwise. */
  mode: number;
  mtimeMs: number;
};

const b2 = (d: Uint8Array, b: number): number =>
  (d[b] ?? 0) | ((d[b + 1] ?? 0) << 8);
const b4 = (d: Uint8Array, b: number): number =>
  ((d[b] ?? 0) |
    ((d[b + 1] ?? 0) << 8) |
    ((d[b + 2] ?? 0) << 16) |
    ((d[b + 3] ?? 0) << 24)) >>>
  0;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;

export class ZipUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipUnsupportedError";
  }
}

/** Locate the End Of Central Directory record by scanning backward for its
 * signature, bounded to the maximum possible comment length so this never
 * walks further than it has to on a large buffer. */
function findEocd(buf: Uint8Array): { cdOffset: number; cdSize: number } {
  const scanFrom = Math.max(0, buf.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let e = buf.length - EOCD_MIN_SIZE; e >= scanFrom; e--) {
    if (b4(buf, e) === EOCD_SIGNATURE) {
      const totalEntries = b2(buf, e + 10);
      const cdSize = b4(buf, e + 12);
      const cdOffset = b4(buf, e + 16);
      const precededByZip64Locator =
        e >= 20 && b4(buf, e - 20) === EOCD64_LOCATOR_SIGNATURE;
      if (
        totalEntries === 0xffff ||
        cdSize === 0xffffffff ||
        cdOffset === 0xffffffff ||
        precededByZip64Locator
      ) {
        throw new ZipUnsupportedError(
          "this archive uses ZIP64 (over 65,535 entries or 4GB) — not supported",
        );
      }
      return { cdOffset, cdSize };
    }
  }
  throw new ZipUnsupportedError(
    "not a valid zip archive (no End Of Central Directory record found)",
  );
}

/** DOS date/time (as packed into every central directory record) -> epoch ms. */
function dosToEpochMs(time: number, date: number): number {
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  const second = (time & 0x1f) * 2;
  const minute = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  return new Date(
    year,
    Math.max(month - 1, 0),
    Math.max(day, 1),
    hour,
    minute,
    second,
  ).getTime();
}

const textDecoder = new TextDecoder();

/**
 * Walk the central directory once, returning mode + mtime by member name —
 * the two fields `unzipSync`'s filter never exposes (see the file header).
 * `mode` is present only for `os === 3` (unix) records; callers fall back to
 * a plain default for anything else.
 */
function readCentralDirectoryMeta(
  buf: Uint8Array,
  cdOffset: number,
  cdSize: number,
): Map<string, { mode: number | null; mtimeMs: number }> {
  const out = new Map<string, { mode: number | null; mtimeMs: number }>();
  let b = cdOffset;
  const end = cdOffset + cdSize;
  while (b + 46 <= end && b4(buf, b) === CENTRAL_DIR_SIGNATURE) {
    const os = buf[b + 5] ?? 0;
    const modTime = b2(buf, b + 12);
    const modDate = b2(buf, b + 14);
    const fnl = b2(buf, b + 28);
    const efl = b2(buf, b + 30);
    const cml = b2(buf, b + 32);
    const extAttrs = b4(buf, b + 38);
    const name = textDecoder.decode(buf.subarray(b + 46, b + 46 + fnl));
    out.set(name, {
      mode: os === 3 ? (extAttrs >>> 16) & 0xffff : null,
      mtimeMs: dosToEpochMs(modTime, modDate),
    });
    b += 46 + fnl + efl + cml;
  }
  return out;
}

const DEFAULT_DIR_MODE = 0o040755;
const DEFAULT_FILE_MODE = 0o100644;

/**
 * List every member of `zipPath` without decompressing any of it — the
 * `unzipSync(buf, { filter })` trick from the plan, `filter` always
 * returning `false` so nothing is ever inflated. Merged with a pass over
 * the raw central directory (`readCentralDirectoryMeta`) for mode/mtime,
 * which the filter callback's `UnzipFileInfo` doesn't carry.
 */
export async function listZip(zipPath: string): Promise<ZipEntryMeta[]> {
  const buf = await readFile(zipPath);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const collected: {
    name: string;
    size: number;
    originalSize: number;
    compression: number;
  }[] = [];
  unzipSync(u8, {
    filter: (f) => {
      // TRAP: `f.size` is the COMPRESSED size, `f.originalSize` is the
      // uncompressed one — see the file header.
      collected.push({
        name: f.name,
        size: f.originalSize,
        originalSize: f.size,
        compression: f.compression,
      });
      return false; // never decompress — that's the whole point of list()
    },
  });

  const { cdOffset, cdSize } = findEocd(u8);
  const meta = readCentralDirectoryMeta(u8, cdOffset, cdSize);

  return collected.map((f) => {
    const isDir = f.name.endsWith("/");
    const extra = meta.get(f.name);
    const mode = extra?.mode ?? (isDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE);
    return {
      name: f.name,
      isDir,
      size: f.size,
      compressedSize: f.originalSize,
      compression: f.compression,
      mode,
      mtimeMs: extra?.mtimeMs ?? Date.now(),
    };
  });
}

// ── path safety ──

/**
 * Split a member name into safe path components, or `null` when it must be
 * rejected: absolute (unix or a Windows drive letter — defensive even on a
 * posix host, since the member name is attacker-controlled text, not a real
 * path), empty, or containing a literal `..` component. No lexical `..`
 * survives this, so `join(destRoot, ...parts)` can never resolve outside
 * `destRoot` — the plan's "resolve(dest, member) must start with
 * resolve(dest) + sep" invariant, enforced by construction rather than by a
 * post-hoc string-prefix check.
 */
export function safeMemberParts(member: string): string[] | null {
  if (member.length === 0) return null;
  if (member.startsWith("/") || member.startsWith("\\")) return null;
  if (/^[A-Za-z]:[\\/]/.test(member)) return null;
  const parts = member.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === "..")) return null;
  return parts;
}

/**
 * Walk from `destRootReal` down through `dirParts`, one level at a time,
 * creating each missing directory itself — never a recursive `mkdir` in one
 * call, so this controls exactly what gets created and can inspect each
 * level first. Any component that already exists as something other than a
 * plain directory (a file, or a symlink even to a real directory) aborts
 * and returns `null` rather than being written through or followed — the
 * "any member whose parent resolves through a symlink" guard from the file
 * header. Returns the final absolute directory path on success.
 */
export async function ensureSafeDir(
  destRootReal: string,
  dirParts: string[],
): Promise<string | null> {
  let current = destRootReal;
  for (const part of dirParts) {
    current = join(current, part);
    try {
      const st = await lstat(current);
      if (!st.isDirectory()) return null; // a file or a symlink sits here — refuse
    } catch {
      await mkdir(current, { mode: 0o755 });
    }
  }
  return current;
}

async function applyMode(path: string, mode: number): Promise<void> {
  try {
    await fsChmod(path, mode & 0o7777);
  } catch {
    // Best-effort, same as ops/copy.ts's applyMode — not worth failing an
    // otherwise-successful extraction over.
  }
}

// ── extract ──

export type ExtractOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
  /** Only these members (and, for a directory member, everything nested
   * under it) are extracted. `undefined` extracts everything. */
  members?: string[];
};

export type ExtractOutcome = {
  extractedCount: number;
  errors: ArchiveError[];
  cancelled: boolean;
};

function isWanted(name: string, members: string[] | undefined): boolean {
  if (!members) return true;
  return members.some(
    (m) =>
      name === m || name.startsWith(`${m}/`) || `${name}/`.startsWith(`${m}/`),
  );
}

/**
 * Extract `zipPath` into `destDir`, which must already exist (callers — see
 * `z`/`u` in keymap.ts — create a fresh, conflict-resolved subdirectory
 * before calling this, exactly like `ops/copy.ts`'s callers do). Metadata
 * (names, sizes, mode, mtime) comes from one `listZip()` call up front;
 * actual bytes move through the streaming `Unzip`/`UnzipInflate` path (see
 * `streamExtractFiles` below), so this never holds more than a few chunks
 * of the archive in memory regardless of its total size.
 *
 * Cancellation leaves no partial FILE: a file that was mid-write when
 * `signal` fired is closed and unlinked, same convention as
 * `ops/copy.ts`'s `copyLargeFile`. Files that had already finished before
 * the cancel land are left in place — again matching `ops/copy.ts`, which
 * stops *between* units rather than rolling back everything already done.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  opts: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const { signal, onProgress, members } = opts;
  const allEntries = await listZip(zipPath);
  const wanted = allEntries.filter((e) => isWanted(e.name, members));

  const destRootAbs = resolve(destDir);
  let destRootReal: string;
  try {
    destRootReal = await realpath(destRootAbs);
  } catch (err) {
    return {
      extractedCount: 0,
      errors: [
        {
          path: destDir,
          message: `destination does not exist: ${errorMessage(err)}`,
        },
      ],
      cancelled: false,
    };
  }

  const fileEntries = wanted.filter((e) => !e.isDir);
  const total = wanted.length;
  const bytesTotal = fileEntries.reduce((n, e) => n + e.size, 0);

  const errors: ArchiveError[] = [];
  let done = 0;
  let bytesDone = 0;
  let extractedCount = 0;
  let cancelled = false;

  const dirEntries: { targetDir: string; mode: number }[] = [];
  const fileTargets = new Map<string, { targetPath: string; mode: number }>();

  for (const e of wanted) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const parts = safeMemberParts(e.name);
    if (!parts) {
      errors.push({
        path: e.name,
        message: "rejected: unsafe path (escapes the destination)",
      });
      continue;
    }
    if (e.isDir) {
      const dirRes = await ensureSafeDir(destRootReal, parts);
      if (!dirRes) {
        errors.push({
          path: e.name,
          message: "rejected: path escapes the destination via a symlink",
        });
        continue;
      }
      dirEntries.push({ targetDir: dirRes, mode: e.mode });
      done++;
      extractedCount++;
      onProgress?.({ done, total, currentPath: e.name, bytesDone, bytesTotal });
      continue;
    }
    const dirParts = parts.slice(0, -1);
    const leafName = parts[parts.length - 1] as string;
    const dirRes =
      dirParts.length === 0
        ? destRootReal
        : await ensureSafeDir(destRootReal, dirParts);
    if (!dirRes) {
      errors.push({
        path: e.name,
        message: "rejected: path escapes the destination via a symlink",
      });
      continue;
    }
    fileTargets.set(e.name, {
      targetPath: join(dirRes, leafName),
      mode: e.mode,
    });
  }

  if (!cancelled && fileTargets.size > 0) {
    const streamOutcome = await streamExtractFiles(
      zipPath,
      fileTargets,
      signal,
      (name, n) => {
        bytesDone += n;
        onProgress?.({ done, total, currentPath: name, bytesDone, bytesTotal });
      },
      (name, ok, message) => {
        done++;
        if (ok) extractedCount++;
        else
          errors.push({ path: name, message: message ?? "extraction failed" });
        onProgress?.({ done, total, currentPath: name, bytesDone, bytesTotal });
      },
    );
    cancelled = streamOutcome.cancelled;
  }

  // Directory modes last, once every file underneath has actually been
  // written — same reasoning as ops/copy.ts's dirEntries pass.
  for (const d of dirEntries) {
    await applyMode(d.targetDir, d.mode);
  }

  return { extractedCount, errors, cancelled };
}

/**
 * The streaming half of `extractZip`: feed `zipPath` through fflate's
 * `Unzip` class chunk by chunk from `fs.createReadStream`, calling
 * `file.start()` only for members present in `targets`(fflate skips
 * decompressing everything else). Writes are awaited before the next chunk
 * of the archive is read — the same per-chunk backpressure `ops/copy.ts`
 * applies to a single large file, here applied across however many members
 * are concurrently mid-write — so memory stays bounded to a few chunks
 * regardless of the archive's total size.
 *
 * `Unzip.push()` runs synchronously: a single chunk of the *compressed*
 * archive read off disk can decompress to many multiples of that size, and
 * fflate calls `file.ondata()` once per internal buffer-full, all within
 * that one synchronous call — before any of the async file writes those
 * calls kick off have had a chance to resolve. Without serializing per
 * file, a second `ondata` call for the same member would run its
 * `handles.get()`/`open()` check before the first call's `open()` had
 * finished, racing to open the same destination file twice. `fileChains`
 * below is a small promise-chain-per-member fix for exactly that: each
 * member's writes run strictly in the order fflate delivered them, which
 * also happens to be what makes an abort actually land mid-file rather
 * than only between whole `Unzip.push()` calls — see the cancellation
 * test, which fails without this.
 */
async function streamExtractFiles(
  zipPath: string,
  targets: Map<string, { targetPath: string; mode: number }>,
  signal: AbortSignal | undefined,
  onBytes: (name: string, n: number) => void,
  onFileDone: (name: string, ok: boolean, message?: string) => void,
): Promise<{ cancelled: boolean }> {
  const handles = new Map<string, FileHandle>();
  const fileChains = new Map<string, Promise<void>>();
  let pending: Promise<void>[] = [];
  let cancelled = false;

  const unzip = new Unzip((file) => {
    const target = targets.get(file.name);
    if (!target) return; // never start() -> fflate never decompresses it
    file.ondata = (err, chunk, final) => {
      if (err) {
        onFileDone(file.name, false, errorMessage(err));
        return;
      }
      const prior = fileChains.get(file.name) ?? Promise.resolve();
      const next = prior.then(async () => {
        if (signal?.aborted) return; // leave this chunk unwritten — cleanup below removes the partial file
        let handle = handles.get(file.name);
        try {
          if (!handle) {
            handle = await open(
              target.targetPath,
              fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
            );
            handles.set(file.name, handle);
          }
          if (chunk.length > 0) {
            await handle.write(chunk, 0, chunk.length);
            onBytes(file.name, chunk.length);
          }
          if (final) {
            handles.delete(file.name);
            await handle.close();
            await applyMode(target.targetPath, target.mode);
            onFileDone(file.name, true);
          }
        } catch (writeErr) {
          handles.delete(file.name);
          await handle?.close().catch(() => {});
          onFileDone(file.name, false, errorMessage(writeErr));
        }
      });
      fileChains.set(file.name, next);
      pending.push(next);
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const rs = createReadStream(zipPath);
  try {
    for await (const chunk of rs as AsyncIterable<Buffer>) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      unzip.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        false,
      );
      if (pending.length > 0) {
        await Promise.all(pending);
        pending = [];
      }
    }
    if (!cancelled) {
      unzip.push(new Uint8Array(0), true);
      if (pending.length > 0) await Promise.all(pending);
    }
  } finally {
    rs.destroy();
  }

  if (cancelled) {
    for (const [name, handle] of handles) {
      await handle.close().catch(() => {});
      const target = targets.get(name);
      if (target) await unlink(target.targetPath).catch(() => {});
    }
  }

  return { cancelled };
}

// ── create ──

export type CreateOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
};

export type CreateOutcome = {
  addedCount: number;
  errors: ArchiveError[];
  cancelled: boolean;
};

type PlanEntry = {
  kind: "dir" | "file";
  absSrc: string;
  memberName: string;
  size: number;
  mode: number;
  mtimeMs: number;
};

/** Walk every source tree once (mirrors ops/copy.ts's `planOne`) so the
 * progress bar's denominator is known before the archive is opened for
 * writing. Symlinks are deliberately excluded, recorded as an error rather
 * than followed (would risk a cycle) or stored specially (zip has no
 * native symlink-member concept fflate exposes here, and this codebase
 * never invents its own zip extension). */
async function planCreate(sources: string[]): Promise<{
  entries: PlanEntry[];
  bytes: number;
  errors: ArchiveError[];
}> {
  const entries: PlanEntry[] = [];
  const errors: ArchiveError[] = [];
  let bytes = 0;

  async function visit(absSrc: string, memberName: string): Promise<void> {
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(absSrc);
    } catch (err) {
      errors.push({ path: absSrc, message: errorMessage(err) });
      return;
    }
    if (st.isSymbolicLink()) {
      errors.push({
        path: absSrc,
        message: "symlinks are not included in archives, skipped",
      });
      return;
    }
    if (st.isDirectory()) {
      entries.push({
        kind: "dir",
        absSrc,
        memberName: `${memberName}/`,
        size: 0,
        mode: st.mode,
        mtimeMs: st.mtimeMs,
      });
      let children: string[];
      try {
        children = await readdir(absSrc);
      } catch (err) {
        errors.push({ path: absSrc, message: errorMessage(err) });
        return;
      }
      for (const child of children) {
        await visit(join(absSrc, child), `${memberName}/${child}`);
      }
      return;
    }
    if (st.isFile()) {
      entries.push({
        kind: "file",
        absSrc,
        memberName,
        size: st.size,
        mode: st.mode,
        mtimeMs: st.mtimeMs,
      });
      bytes += st.size;
      return;
    }
    errors.push({ path: absSrc, message: "unsupported file type, skipped" });
  }

  for (const src of sources) {
    await visit(src, basename(src));
  }
  return { entries, bytes, errors };
}

const CREATE_CHUNK_BYTES = 1024 * 1024; // 1MB, same order as ops/copy.ts's stream chunk

/** Stream one file's content into its `ZipDeflate`, chunk by chunk, so a
 * large file yields and can be cancelled mid-file instead of only between
 * files — the same shape as ops/copy.ts's `copyLargeFile`. */
async function pushFileContent(
  zf: ZipDeflate,
  absSrc: string,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void,
): Promise<void> {
  const handle = await open(absSrc, "r");
  try {
    const st = await handle.stat();
    if (st.size === 0) {
      zf.push(new Uint8Array(0), true);
      return;
    }
    const buffer = Buffer.allocUnsafe(Math.min(CREATE_CHUNK_BYTES, st.size));
    let position = 0;
    for (;;) {
      if (signal?.aborted) throw new ArchiveAbortedError();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const final = position >= st.size;
      zf.push(buffer.subarray(0, bytesRead), final);
      onBytes(bytesRead);
      await Promise.resolve(); // yield between chunks
    }
  } finally {
    await handle.close();
  }
}

/**
 * Create a zip at `zipPath` from `sources` (absolute real filesystem
 * paths — each becomes a top-level member named by its own basename,
 * mirroring `ops/copy.ts`'s `CopyJob.destName` convention). Every member
 * gets `os: 3` and `attrs: mode << 16` (the mode already includes the
 * S_IFDIR/S_IFREG type bits from `lstat`, per the plan) so permissions
 * round-trip through `extractZip` above.
 *
 * Any per-entry failure during the actual write (a source vanishing mid-
 * read, permission denied) is treated as fatal to the whole archive rather
 * than silently producing a zip that is missing a file with no record of
 * why: the partially-written output is deleted and the error reported —
 * "no partial output" applied to create() the same way `ops/copy.ts`
 * applies it to individual files. A source that fails during the initial
 * walk (planCreate, before any stream was opened for it) is safe to just
 * skip and report, since nothing was ever added to the archive for it.
 */
export async function createZip(
  zipPath: string,
  sources: string[],
  opts: CreateOptions = {},
): Promise<CreateOutcome> {
  const { signal, onProgress } = opts;
  const { entries, bytes, errors } = await planCreate(sources);
  const total = entries.length;

  if (signal?.aborted) {
    return { addedCount: 0, errors, cancelled: true };
  }

  const ws = createWriteStream(zipPath);
  const finished = new Promise<void>((res, rej) => {
    ws.on("finish", res);
    ws.on("error", rej);
  });

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      ws.destroy(err);
      return;
    }
    ws.write(chunk);
    if (final) ws.end();
  });

  let done = 0;
  let bytesDone = 0;
  let addedCount = 0;
  let cancelled = false;
  let fatal: ArchiveError | null = null;

  for (const entry of entries) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    const zf = new ZipDeflate(entry.memberName, { level: 6 });
    zf.os = 3;
    zf.attrs = entry.mode << 16;
    zf.mtime = new Date(entry.mtimeMs);
    zip.add(zf);

    if (entry.kind === "dir") {
      zf.push(new Uint8Array(0), true);
      done++;
      addedCount++;
      onProgress?.({
        done,
        total,
        currentPath: entry.absSrc,
        bytesDone,
        bytesTotal: bytes,
      });
    } else {
      try {
        await pushFileContent(zf, entry.absSrc, signal, (n) => {
          bytesDone += n;
          onProgress?.({
            done,
            total,
            currentPath: entry.absSrc,
            bytesDone,
            bytesTotal: bytes,
          });
        });
        done++;
        addedCount++;
        onProgress?.({
          done,
          total,
          currentPath: entry.absSrc,
          bytesDone,
          bytesTotal: bytes,
        });
      } catch (err) {
        if (isAbortError(err)) {
          // Terminate this member's stream so `zip.end()` below doesn't
          // hang waiting on it — see the file header's "no partial output"
          // note. The whole archive is being discarded either way.
          zf.push(new Uint8Array(0), true);
          cancelled = true;
          break;
        }
        zf.push(new Uint8Array(0), true);
        fatal = { path: entry.absSrc, message: errorMessage(err) };
        break;
      }
    }

    if (ws.writableNeedDrain) {
      await new Promise<void>((res) => ws.once("drain", res));
    }
  }

  if (cancelled || fatal) {
    ws.destroy();
    await unlink(zipPath).catch(() => {});
    if (fatal) errors.push(fatal);
    return { addedCount: 0, errors, cancelled };
  }

  zip.end();
  await finished;

  return { addedCount, errors, cancelled: false };
}
