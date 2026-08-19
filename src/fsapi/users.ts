// fsapi/users.ts — uid/gid -> name, parsed from /etc/passwd and /etc/group
// once and cached, never shelled out to `id`/`getent` per row.
//
// On an LDAP, SSSD, or systemd-homed machine most users are in neither file
// and Bun has no `getpwuid` binding, so lookups fall back to the numeric
// uid/gid — never "unknown" or blank — and the cache is seeded from
// `os.userInfo()` first so at least the current user's own files resolve by
// name even when /etc/passwd is unreadable or absent.
//
// Both files are parsed lazily, on first lookup, not at import time — a
// `--dump-frame` run against a directory with no foreign owners should never
// pay for parsing /etc/group.

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

// ── passwd ──

let userCache: Map<number, string> | null = null;

function parsePasswd(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const me = userInfo();
    if (typeof me.uid === "number" && me.uid >= 0) map.set(me.uid, me.username);
  } catch {
    // os.userInfo() can throw on minimal/containerized setups with no
    // password database at all — the numeric fallback below still works.
  }
  try {
    const text = readFileSync("/etc/passwd", "utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0 || line.startsWith("#")) continue;
      const fields = line.split(":");
      const name = fields[0];
      const uid = Number(fields[2]);
      if (name && Number.isFinite(uid)) map.set(uid, name);
    }
  } catch {
    // Unreadable or absent (LDAP/SSSD machines commonly have a near-empty
    // /etc/passwd) — the os.userInfo() seed above and the numeric fallback
    // in userName() below cover this.
  }
  return map;
}

/** Resolve a uid to a username, falling back to the numeric uid as a string. */
export function userName(uid: number): string {
  userCache ??= parsePasswd();
  return userCache.get(uid) ?? String(uid);
}

// ── group ──

let groupCache: Map<number, string> | null = null;

function parseGroup(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const text = readFileSync("/etc/group", "utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0 || line.startsWith("#")) continue;
      const fields = line.split(":");
      const name = fields[0];
      const gid = Number(fields[2]);
      if (name && Number.isFinite(gid)) map.set(gid, name);
    }
  } catch {
    // Same story as /etc/passwd; os.userInfo() has no group-name field to
    // seed from, so this cache can legitimately start empty.
  }
  return map;
}

/** Resolve a gid to a group name, falling back to the numeric gid as a string. */
export function groupName(gid: number): string {
  groupCache ??= parseGroup();
  return groupCache.get(gid) ?? String(gid);
}

/** Test-only: force both caches to re-parse on the next lookup. */
export function resetUserCacheForTests(): void {
  userCache = null;
  groupCache = null;
}
