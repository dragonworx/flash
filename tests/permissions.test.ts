// tests/permissions.test.ts — ui/overlay/permissions.ts's pure rendering
// helpers plus a --dump-frame-style snapshot, and state/store.ts's chmod
// actions (startPermissions/permMoveFocus/permToggle/permDigit/
// applyPermissions). The important test in this file is
// "grid-only edits preserve sticky/sgid bits" — the plan's named risk: a
// naive 3x3 grid silently clears setuid/setgid/sticky by writing
// chmod(path, gridValue). state/store.ts's applyPermissions() must instead
// apply (st.mode & ~0o777) | rwxBits, re-read per target.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.ts";
import { Screen } from "../src/term/screen.ts";
import {
  bitAt,
  formatOctal,
  renderPermissionsOverlay,
} from "../src/ui/overlay/permissions.ts";

/**
 * Seed a file/directory's special bits for a test's "before" state via the
 * real `chmod` binary, deliberately NOT `node:fs`'s `chmodSync` — verified
 * on this machine, Bun 1.3.14's own `chmodSync`/`chmod` silently mask away
 * setuid/setgid/sticky before the syscall (see fsapi/ops/chmod.ts's file
 * header), so using it here would make every "does the special bit
 * survive" test start from a false premise. `lstatSync` (used throughout
 * this file for the "after" assertions) reads special bits back correctly
 * — only Bun's *write* path is broken — so it stays trustworthy for
 * verifying what `applyPermissions` actually did.
 */
function chmodRealSync(path: string, octalMode: string): void {
  const result = Bun.spawnSync(["chmod", octalMode, path]);
  if (result.exitCode !== 0) {
    throw new Error(`chmod ${octalMode} ${path} failed in test setup`);
  }
}

// ── pure helpers ──

describe("bitAt", () => {
  it("maps grid index 0 (user r) to 0o400 and index 8 (other x) to 0o1", () => {
    expect(bitAt(0o400, 0)).toBe(true);
    expect(bitAt(0o000, 0)).toBe(false);
    expect(bitAt(0o001, 8)).toBe(true);
    expect(bitAt(0o000, 8)).toBe(false);
  });

  it("reads every bit of 0o755 correctly", () => {
    // rwxr-xr-x
    const mode = 0o755;
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => bitAt(mode, i))).toEqual([
      true,
      true,
      true, // user rwx
      true,
      false,
      true, // group r-x
      true,
      false,
      true, // other r-x
    ]);
  });
});

describe("formatOctal", () => {
  it("shows 3 digits when special bits are preserved (not explicit)", () => {
    expect(formatOctal(0o755, 0o2, false)).toBe("755");
  });

  it("shows a leading 4th digit once special bits are explicit", () => {
    expect(formatOctal(0o755, 0o4, true)).toBe("4755");
    expect(formatOctal(0o644, 0o0, true)).toBe("0644");
  });
});

describe("renderPermissionsOverlay snapshot", () => {
  it("renders the grid, the special-bit row, and the octal readout", () => {
    const screen = new Screen(80, 24, () => {});
    screen.clear();
    renderPermissionsOverlay(screen, 80, 24, {
      targetLabel: "report.txt",
      rwxBits: 0o755,
      specialBits: 0o2,
      specialExplicit: false,
      focus: 0,
      error: null,
    });
    const text = screen.renderPlainText();
    expect(text).toContain("Permissions — report.txt");
    expect(text).toContain("user");
    expect(text).toContain("group");
    expect(text).toContain("other");
    expect(text).toContain("sgid"); // 0o2 = sgid, shown even though not explicit
    expect(text).toContain("preserved per file");
    expect(text).toContain("octal: 755");
    expect(text).toContain("Enter apply");
  });

  it("shows the explicit special-bit value once specialExplicit is set", () => {
    const screen = new Screen(80, 24, () => {});
    screen.clear();
    renderPermissionsOverlay(screen, 80, 24, {
      targetLabel: "3 items",
      rwxBits: 0o755,
      specialBits: 0o4,
      specialExplicit: true,
      focus: 4,
      error: null,
    });
    const text = screen.renderPlainText();
    expect(text).toContain("suid");
    expect(text).toContain("octal: 4755");
    expect(text).not.toContain("preserved per file");
  });

  it("degrades gracefully rather than throwing on a very small terminal", () => {
    const screen = new Screen(15, 6, () => {});
    screen.clear();
    expect(() =>
      renderPermissionsOverlay(screen, 15, 6, {
        targetLabel: "x",
        rwxBits: 0o644,
        specialBits: 0,
        specialExplicit: false,
        focus: 0,
        error: null,
      }),
    ).not.toThrow();
  });
});

// ── Store integration ──

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flash-permissions-test-"));
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

/** focus index for (row, col): 0=user/1=group/2=other x 0=r/1=w/2=x. */
function focusOf(row: number, col: number): number {
  return row * 3 + col;
}

describe("Store.startPermissions", () => {
  it("seeds rwxBits/specialBits from the cursor entry's current mode", async () => {
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    chmodSync(file, 0o640);
    const store = await makeStore();
    setCursorTo(store, "f.txt");
    store.startPermissions();

    const overlay = store.getState().overlay;
    expect(overlay?.kind).toBe("permissions");
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.rwxBits).toBe(0o640);
    expect(overlay.specialExplicit).toBe(false);
    expect(overlay.paths).toEqual([file]);
  });

  it("refuses to open when nothing is targetable (cursor on '..')", async () => {
    const store = await makeStore();
    store.moveCursorTo("home");
    store.startPermissions();
    expect(store.getState().overlay).toBeNull();
  });
});

describe("Store permissions grid editing", () => {
  it("permToggle flips exactly the focused rwx bit", async () => {
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    chmodSync(file, 0o644);
    const store = await makeStore();
    setCursorTo(store, "f.txt");
    store.startPermissions();

    // focus starts at 0 (user r), already set in 0o644 — toggling clears it.
    store.permToggle();
    let overlay = store.getState().overlay;
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.rwxBits).toBe(0o244);

    // Move to other-x (row 2, col 2) and set it.
    store.permMoveFocus("down");
    store.permMoveFocus("down");
    store.permMoveFocus("right");
    store.permMoveFocus("right");
    expect(store.getState().overlay?.kind).toBe("permissions");
    overlay = store.getState().overlay;
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.focus).toBe(focusOf(2, 2));
    store.permToggle();
    overlay = store.getState().overlay;
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.rwxBits).toBe(0o245);
  });

  it("permMoveFocus clamps at the grid's edges", async () => {
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    const store = await makeStore();
    setCursorTo(store, "f.txt");
    store.startPermissions();

    store.permMoveFocus("up"); // already row 0 — clamps
    store.permMoveFocus("left"); // already col 0 — clamps
    const overlay = store.getState().overlay;
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.focus).toBe(0);
  });

  it("permDigit builds an octal value calculator-style and sets specialExplicit on the 4th digit", async () => {
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    const store = await makeStore();
    setCursorTo(store, "f.txt");
    store.startPermissions();

    store.permDigit(4);
    store.permDigit(7);
    store.permDigit(5);
    let overlay = store.getState().overlay;
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.rwxBits).toBe(0o475);
    expect(overlay.specialBits).toBe(0);
    expect(overlay.specialExplicit).toBe(false);

    store.permDigit(5);
    overlay = store.getState().overlay;
    if (overlay?.kind !== "permissions") throw new Error("unreachable");
    expect(overlay.rwxBits).toBe(0o755);
    expect(overlay.specialBits).toBe(0o4);
    expect(overlay.specialExplicit).toBe(true);
  });
});

describe("Store.applyPermissions — the critical correctness test", () => {
  it("preserves the sticky bit through a grid-only (Space) edit — never types a digit", async () => {
    const dir = join(root, "shared");
    mkdirSync(dir);
    chmodRealSync(dir, "1777"); // sticky + rwxrwxrwx, like /tmp
    const before = lstatSync(dir).mode;
    expect(before & 0o1000).toBe(0o1000); // sticky bit present before we start

    const store = await makeStore();
    setCursorTo(store, "shared");
    store.startPermissions();

    // Toggle "other write" off via the grid — the only interaction with
    // this overlay. No digits typed, so specialExplicit stays false.
    store.permMoveFocus("down");
    store.permMoveFocus("down");
    store.permMoveFocus("right"); // other/w
    store.permToggle();

    await store.applyPermissions();

    const after = lstatSync(dir).mode;
    expect(after & 0o1000).toBe(0o1000); // sticky bit SURVIVED
    expect(after & 0o777).toBe(0o1777 & ~0o2 & 0o777); // other-write cleared, rest unchanged
  });

  it("preserves the setgid bit through a grid-only edit", async () => {
    const dir = join(root, "group-shared");
    mkdirSync(dir);
    chmodRealSync(dir, "2775"); // setgid + rwxrwxr-x
    const store = await makeStore();
    setCursorTo(store, "group-shared");
    store.startPermissions();

    store.permToggle(); // toggle user-read off and back on has no net effect; instead toggle something real:
    store.permToggle(); // back to original state (net no-op on rwx) — proves apply still preserves setgid even with churn
    await store.applyPermissions();

    const after = lstatSync(dir).mode;
    expect(after & 0o2000).toBe(0o2000); // setgid SURVIVED
    expect(after & 0o777).toBe(0o775);
  });

  it("preserves the setuid bit on a file through a grid-only edit", async () => {
    const file = join(root, "suid-bin");
    writeFileSync(file, "#!/bin/sh\n");
    chmodRealSync(file, "4755"); // setuid + rwxr-xr-x
    const store = await makeStore();
    setCursorTo(store, "suid-bin");
    store.startPermissions();

    // Focus other/x and toggle it off.
    store.permMoveFocus("down");
    store.permMoveFocus("down");
    store.permMoveFocus("right");
    store.permMoveFocus("right");
    store.permToggle();
    await store.applyPermissions();

    const after = lstatSync(file).mode;
    expect(after & 0o4000).toBe(0o4000); // setuid SURVIVED
    expect(after & 0o777).toBe(0o754); // other-x cleared
  });

  it("an explicit 4-digit octal DOES change the special bits, matching real chmod semantics", async () => {
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    chmodRealSync(file, "4755"); // starts with setuid
    const store = await makeStore();
    setCursorTo(store, "f.txt");
    store.startPermissions();

    store.permDigit(0);
    store.permDigit(6);
    store.permDigit(4);
    store.permDigit(4); // explicit "0644" — no special bits
    await store.applyPermissions();

    const after = lstatSync(file).mode;
    expect(after & 0o7000).toBe(0); // setuid explicitly cleared
    expect(after & 0o777).toBe(0o644);
  });

  it("applies to every marked entry, preserving each one's own special bits independently", async () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    chmodSync(a, 0o644); // no special bits
    chmodRealSync(b, "2644"); // setgid

    const store = await makeStore();
    setCursorTo(store, "a.txt");
    store.toggleMarkAtCursor();
    setCursorTo(store, "b.txt");
    store.toggleMarkAtCursor();
    store.startPermissions();

    // Grid-only: toggle other-execute ON for both (both start at 0o644,
    // where other-x is 0) — an unambiguous "turned on" edit for both files.
    store.permMoveFocus("down");
    store.permMoveFocus("down");
    store.permMoveFocus("right");
    store.permMoveFocus("right"); // other/x
    store.permToggle();
    await store.applyPermissions();

    const modeA = lstatSync(a).mode;
    const modeB = lstatSync(b).mode;
    expect(modeA & 0o7000).toBe(0); // a had no special bits, still none
    expect(modeB & 0o7000).toBe(0o2000); // b's setgid survived independently
    expect(modeA & 0o001).toBe(0o001);
    expect(modeB & 0o001).toBe(0o001);
  });

  it("reports a per-entry failure without aborting the rest of the batch", async () => {
    const ok = join(root, "ok.txt");
    writeFileSync(ok, "ok");
    const missing = join(root, "vanished.txt");
    writeFileSync(missing, "x");

    const store = await makeStore();
    setCursorTo(store, "ok.txt");
    store.toggleMarkAtCursor();
    setCursorTo(store, "vanished.txt");
    store.toggleMarkAtCursor();
    store.startPermissions();
    rmSync(missing); // vanish one target after the overlay opened

    await store.applyPermissions();

    expect(store.getState().overlay).toBeNull();
    expect(store.getState().message?.kind).toBe("error");
    expect(store.getState().message?.text).toContain("1 failed");
    expect(store.getState().message?.text).toContain("1 item"); // the other one still succeeded
  });
});

describe("prompt/permissions overlay cancel", () => {
  it("cancelPermissions closes without touching the filesystem", async () => {
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    chmodRealSync(file, "4755");
    const store = await makeStore();
    setCursorTo(store, "f.txt");
    store.startPermissions();
    store.permToggle();
    store.cancelPermissions();

    expect(store.getState().overlay).toBeNull();
    expect(lstatSync(file).mode & 0o777).toBe(0o755);
  });
});
