// tests/config.test.ts — config.ts's round trip (save then load returns
// what was saved) and its tolerance for a missing or corrupt file. Every
// test points `XDG_CONFIG_HOME` at a throwaway temp directory so this never
// touches the real machine's `~/.config/flash` — see config.ts's own
// comment on why `--dump-frame` skips config I/O entirely for the same
// reason.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  saveConfig,
} from "../src/config.ts";

let tempDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "flash-config-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (originalXdg === undefined) {
    // Restore the environment to genuinely "unset" for later tests — an
    // assignment (even `= undefined`) is not the same thing.
    // biome-ignore lint/performance/noDelete: see above.
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("configPath", () => {
  it("lands under $XDG_CONFIG_HOME/flash/config.json", () => {
    expect(configPath()).toBe(join(tempDir, "flash", "config.json"));
  });
});

describe("round trip", () => {
  it("loads DEFAULT_CONFIG when no file has been saved yet", async () => {
    const loaded = await loadConfig();
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it("returns exactly what was saved", async () => {
    const config = {
      view: "grid" as const,
      sort: { key: "size" as const, dirsFirst: true, reverse: true },
      showHidden: true,
      icons: "nerd" as const,
    };
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
  });

  it("overwrites a previous save", async () => {
    await saveConfig({ ...DEFAULT_CONFIG, showHidden: true });
    await saveConfig({ ...DEFAULT_CONFIG, showHidden: false, view: "grid" });
    const loaded = await loadConfig();
    expect(loaded.showHidden).toBe(false);
    expect(loaded.view).toBe("grid");
  });

  it("writes atomically: no leftover .tmp files after a save", async () => {
    await saveConfig(DEFAULT_CONFIG);
    const names = readdirSync(join(tempDir, "flash"));
    expect(names).toEqual(["config.json"]);
  });
});

describe("corrupt/missing file fallback", () => {
  it("falls back to DEFAULT_CONFIG on invalid JSON, without throwing", async () => {
    mkdirSync(join(tempDir, "flash"), { recursive: true });
    writeFileSync(configPath(), "{ not valid json ", "utf8");

    const loaded = await loadConfig();
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it("falls back field-by-field on a well-formed but wrong-shaped file", async () => {
    mkdirSync(join(tempDir, "flash"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        view: "gird", // typo — invalid enum value
        sort: { key: "name", dirsFirst: true, reverse: false },
        showHidden: true,
        icons: "not-a-real-icon-set",
      }),
      "utf8",
    );

    const loaded = await loadConfig();
    // Bad fields fall back to the default...
    expect(loaded.view).toBe(DEFAULT_CONFIG.view);
    expect(loaded.icons).toBe(DEFAULT_CONFIG.icons);
    // ...but a well-formed field alongside them survives.
    expect(loaded.showHidden).toBe(true);
    expect(loaded.sort).toEqual({
      key: "name",
      dirsFirst: true,
      reverse: false,
    });
  });

  it("falls back to DEFAULT_CONFIG when the file doesn't exist at all", async () => {
    const loaded = await loadConfig();
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it("falls back to DEFAULT_CONFIG when the config directory is missing entirely", async () => {
    rmSync(tempDir, { recursive: true, force: true });
    const loaded = await loadConfig();
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });
});
