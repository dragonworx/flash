// tests/entry.test.ts — the pure formatters: formatSize, formatMode,
// formatMtime. See src/fsapi/entry.ts.

import { describe, expect, it } from "bun:test";
import { formatMode, formatMtime, formatSize } from "../src/fsapi/entry.ts";

describe("formatSize", () => {
  it("shows sub-1024 byte counts with no unit letter", () => {
    expect(formatSize(0)).toBe("0");
    expect(formatSize(512)).toBe("512");
    expect(formatSize(1023)).toBe("1023");
  });

  it("shows one decimal place under 10 of a unit", () => {
    expect(formatSize(1229)).toBe("1.2K"); // 1229 / 1024 ≈ 1.2001
  });

  it("drops the decimal at 10 or more of a unit", () => {
    expect(formatSize(340 * 1024 * 1024)).toBe("340M");
  });

  it("climbs through K/M/G/T for large values", () => {
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(1024 * 1024)).toBe("1.0M");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0G");
    expect(formatSize(1024 * 1024 * 1024 * 1024)).toBe("1.0T");
  });

  it("returns '?' for negative or non-finite input", () => {
    expect(formatSize(-1)).toBe("?");
    expect(formatSize(Number.NaN)).toBe("?");
  });
});

describe("formatMode", () => {
  it("formats a standard directory", () => {
    expect(formatMode(0o40755)).toBe("drwxr-xr-x");
  });

  it("formats a standard file", () => {
    expect(formatMode(0o100644)).toBe("-rw-r--r--");
  });

  it("formats a symlink", () => {
    expect(formatMode(0o120777)).toBe("lrwxrwxrwx");
  });

  it("shows lowercase s for setuid with exec, uppercase without", () => {
    expect(formatMode(0o104755)).toBe("-rwsr-xr-x"); // setuid + owner exec
    expect(formatMode(0o104655)).toBe("-rwSr-xr-x"); // setuid, no owner exec
  });

  it("shows the sticky bit in the other-exec slot", () => {
    expect(formatMode(0o41777)).toBe("drwxrwxrwt"); // sticky + other exec
    expect(formatMode(0o41776)).toBe("drwxrwxrwT"); // sticky, no other exec
  });

  it("falls back to '-' for an unrecognized type", () => {
    expect(formatMode(0o644)).toBe("-rw-r--r--");
  });
});

describe("formatMtime", () => {
  const now = Date.UTC(2026, 7, 19, 12, 0, 0); // 2026-08-19T12:00:00Z

  it("shows 'just now' under a minute", () => {
    expect(formatMtime(now - 30_000, now)).toBe("just now");
  });

  it("shows minutes ago under an hour", () => {
    expect(formatMtime(now - 5 * 60_000, now)).toBe("5m ago");
  });

  it("shows hours ago under a day", () => {
    expect(formatMtime(now - 3 * 60 * 60_000, now)).toBe("3h ago");
  });

  it("shows days ago under a week", () => {
    expect(formatMtime(now - 2 * 24 * 60 * 60_000, now)).toBe("2d ago");
  });

  it("falls back to YYYY-MM-DD at a week or older", () => {
    const eightDaysAgo = now - 8 * 24 * 60 * 60_000;
    expect(formatMtime(eightDaysAgo, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to YYYY-MM-DD for a future timestamp", () => {
    expect(formatMtime(now + 60_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
