// tests/rename-mkdir.test.ts — state/store.ts's Phase 7 rename/mkdir
// actions: startRename/startMkdir opening the prompt overlay correctly,
// submitPrompt doing the real filesystem work (through refresh(), not
// load() — see store.ts's file header), and the two named risks the plan
// calls out for this pair: refusing to clobber an existing name, and
// catching the race where the target name appears on disk after the
// listing was read but before Enter is pressed.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flash-rename-mkdir-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeStore(): Promise<Store> {
  const store = new Store({ cwd: root });
  await store.load(root);
  return store;
}

function setCursorTo(store: Store, name: string): void {
  const idx = store.visibleEntries().findIndex((e) => e.name === name);
  expect(idx).toBeGreaterThanOrEqual(0);
  store.setCursorIndex(idx);
}

/** Type a plain-ASCII string into an already-open prompt one char at a time. */
function typeInto(store: Store, text: string): void {
  for (const ch of text) store.promptInsertChar(ch);
}

describe("Store.startRename", () => {
  it("pre-fills the prompt with the cursor entry's name, cursor at the end", async () => {
    writeFileSync(join(root, "report.txt"), "hi");
    const store = await makeStore();
    setCursorTo(store, "report.txt");

    store.startRename();
    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.mode).toBe("rename");
    expect(overlay.value).toBe("report.txt");
    expect(overlay.cursor).toBe("report.txt".length);
    expect(overlay.error).toBeNull();
  });

  it("refuses to open on the synthetic '..' row", async () => {
    const store = await makeStore();
    store.moveCursorTo("home"); // the ".." row
    store.startRename();
    expect(store.getState().overlay).toBeNull();
  });

  it("refuses to open a second overlay while one is already open", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    const store = await makeStore();
    setCursorTo(store, "a.txt");
    store.startRename();
    const firstValue = store.getState().overlay;

    setCursorTo(store, "b.txt");
    store.startRename();
    expect(store.getState().overlay).toEqual(firstValue);
  });
});

describe("Store.startMkdir", () => {
  it("opens an empty prompt", async () => {
    const store = await makeStore();
    store.startMkdir();
    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.mode).toBe("mkdir");
    expect(overlay.value).toBe("");
    expect(overlay.cursor).toBe(0);
  });
});

describe("Store.submitPrompt — mkdir", () => {
  it("creates the directory and closes the overlay via refresh()", async () => {
    const store = await makeStore();
    store.startMkdir();
    typeInto(store, "newdir");
    await store.submitPrompt();

    expect(store.getState().overlay).toBeNull();
    expect(existsSync(join(root, "newdir"))).toBe(true);
    expect(store.visibleEntries().some((e) => e.name === "newdir")).toBe(true);
  });

  it("shows an inline error and does not create anything for an empty name", async () => {
    const store = await makeStore();
    store.startMkdir();
    await store.submitPrompt();

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).not.toBeNull();
  });

  it("refuses a name containing '/' inline, before Enter is even pressed", async () => {
    const store = await makeStore();
    store.startMkdir();
    typeInto(store, "a/b");

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).toContain("/");

    await store.submitPrompt();
    expect(store.getState().overlay).not.toBeNull(); // still open, nothing created
    expect(existsSync(join(root, "a"))).toBe(false);
  });

  it("refuses an already-existing name", async () => {
    mkdirSync(join(root, "build"));
    const store = await makeStore();
    store.startMkdir();
    typeInto(store, "build");
    await store.submitPrompt();

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).toContain("already exists");
  });
});

describe("Store.submitPrompt — rename", () => {
  it("renames the file and closes the overlay via refresh(), preserving cursor identity", async () => {
    writeFileSync(join(root, "old.txt"), "contents");
    const store = await makeStore();
    setCursorTo(store, "old.txt");
    store.startRename();
    store.promptMoveHome();
    // Clear the field and retype, exercising Home + Ctrl+U-style clear plus
    // ordinary typing, not just a pre-filled no-op.
    for (let i = 0; i < "old.txt".length; i++) store.promptDeleteForward();
    typeInto(store, "new.txt");
    await store.submitPrompt();

    expect(store.getState().overlay).toBeNull();
    expect(existsSync(join(root, "old.txt"))).toBe(false);
    expect(existsSync(join(root, "new.txt"))).toBe(true);
    const current = store.visibleEntries()[store.getState().cursor];
    expect(current?.name).toBe("new.txt");
  });

  it("an unchanged rename (Enter with the same name) is a silent no-op", async () => {
    writeFileSync(join(root, "same.txt"), "x");
    const store = await makeStore();
    setCursorTo(store, "same.txt");
    store.startRename();
    await store.submitPrompt();

    expect(store.getState().overlay).toBeNull();
    expect(existsSync(join(root, "same.txt"))).toBe(true);
  });

  it("refuses to clobber an existing name (validated against the listing)", async () => {
    writeFileSync(join(root, "a.txt"), "a-contents");
    writeFileSync(join(root, "b.txt"), "b-contents");
    const store = await makeStore();
    setCursorTo(store, "a.txt");
    store.startRename();
    store.promptMoveEnd();
    for (let i = 0; i < "a.txt".length; i++) store.promptBackspace();
    typeInto(store, "b.txt");

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).toContain("already exists");

    await store.submitPrompt();
    expect(store.getState().overlay).not.toBeNull(); // still open
    // Neither file touched — b.txt's original contents survive, a.txt still there.
    expect(existsSync(join(root, "a.txt"))).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(true);
  });

  it("refuses '.' and '..' as a new name", async () => {
    writeFileSync(join(root, "x.txt"), "x");
    const store = await makeStore();
    setCursorTo(store, "x.txt");
    store.startRename();
    for (let i = 0; i < "x.txt".length; i++) store.promptBackspace();
    typeInto(store, "..");

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).not.toBeNull();

    await store.submitPrompt();
    expect(existsSync(join(root, "x.txt"))).toBe(true); // untouched
  });

  it("refuses a name containing '/'", async () => {
    writeFileSync(join(root, "y.txt"), "y");
    const store = await makeStore();
    setCursorTo(store, "y.txt");
    store.startRename();
    typeInto(store, "/etc");

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).toContain("/");
  });

  it("catches the race where the target name appeared on disk after the listing was read (the plan's named case)", async () => {
    writeFileSync(join(root, "source.txt"), "original source");
    const store = await makeStore();
    setCursorTo(store, "source.txt");
    store.startRename();
    for (let i = 0; i < "source.txt".length; i++) store.promptBackspace();
    typeInto(store, "target.txt");
    // Inline validation is happy: "target.txt" wasn't in the listing this
    // prompt was opened against.
    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("prompt");
    if (overlay?.kind !== "prompt") throw new Error("unreachable");
    expect(overlay.error).toBeNull();

    // Simulate the race: something else creates "target.txt" between the
    // listing being read and Enter being pressed.
    writeFileSync(join(root, "target.txt"), "raced-in contents");

    await store.submitPrompt();

    // The rename must NOT have gone through — the raced-in file survives
    // with its own contents, and the source is untouched.
    expect(store.getState().overlay).not.toBeNull();
    expect(existsSync(join(root, "source.txt"))).toBe(true);
    const raced = await Bun.file(join(root, "target.txt")).text();
    expect(raced).toBe("raced-in contents");
  });
});

describe("prompt overlay cancel", () => {
  it("cancelPrompt closes the overlay without touching the filesystem", async () => {
    writeFileSync(join(root, "keep.txt"), "keep");
    const store = await makeStore();
    setCursorTo(store, "keep.txt");
    store.startRename();
    typeInto(store, "-renamed");
    store.cancelPrompt();

    expect(store.getState().overlay).toBeNull();
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
  });
});
