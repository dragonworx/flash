// ui/overlay/permissions.ts — the chmod editor: a 3x3 grid of rwx
// checkboxes for user/group/other, a read-only fourth row showing what
// suid/sgid/sticky will be preserved (or set, once the user has typed a
// full octal), and a live octal readout.
//
// This file only renders `state/store.ts`'s `Overlay { kind: "permissions"
// }` state — `permMoveFocus`/`permToggle`/`permDigit` there own every bit of
// mutation, and `applyPermissions` is where the plan's named risk is
// actually fixed (`(st.mode & ~0o777) | rwxBits`, re-read per target rather
// than reusing the seed file's special bits — see that method's comment).
// This file's only job is to make the *current* state legible: which cell
// has focus, which bits are set, and — critically — that suid/sgid/sticky
// are shown at all, so a user chmod'ing an sgid-shared directory can see
// what they are (and are not) about to touch.

import {
  ATTR_BOLD,
  ATTR_REVERSE,
  type Screen,
  type Style,
} from "../../term/screen.ts";
import { colors } from "../../term/theme.ts";
import { pad, truncate } from "../../term/width.ts";

export type PermissionsOverlayInfo = {
  targetLabel: string; // e.g. "report.txt" or "3 items"
  rwxBits: number; // 0..0o777
  specialBits: number; // 0..0o7 (suid, sgid, sticky)
  specialExplicit: boolean;
  focus: number; // 0..8
  error: string | null;
};

const ROWS = ["user", "group", "other"] as const;
const COLS = ["r", "w", "x"] as const;

/** `"0755"` (3 digits) normally, `"4755"` (4, leading special digit) once the user has set one explicitly. */
export function formatOctal(
  rwxBits: number,
  specialBits: number,
  specialExplicit: boolean,
): string {
  const rwx = (rwxBits & 0o777).toString(8).padStart(3, "0");
  return specialExplicit ? `${specialBits & 0o7}${rwx}` : rwx;
}

/** Whether the checkbox at grid index `i` (0..8, row-major user/group/other x r/w/x) is set in `rwxBits`. */
export function bitAt(rwxBits: number, i: number): boolean {
  const bitPos = 8 - i;
  return (rwxBits & (1 << bitPos)) !== 0;
}

const BOX_WIDTH_MIN = 34;
const BOX_WIDTH_MAX = 60; // wide enough that the footer hint never truncates at 80 columns
const BOX_HEIGHT = 12; // border, title, blank, header, 3 grid rows, special row, octal row, blank, footer, border

export type PermissionsBoxRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function computePermissionsBox(
  screenWidth: number,
  screenHeight: number,
): PermissionsBoxRect {
  const w = screenWidth <= 0 ? 1 : screenWidth;
  const h = screenHeight <= 0 ? 1 : screenHeight;
  const preferred = Math.max(BOX_WIDTH_MIN, Math.min(BOX_WIDTH_MAX, w - 4));
  const width = Math.min(preferred, w);
  const height = Math.min(BOX_HEIGHT, h);
  return {
    x: Math.max(0, Math.floor((w - width) / 2)),
    y: Math.max(0, Math.floor((h - height) / 2)),
    width,
    height,
  };
}

const SPECIAL_LABELS: [string, string, string] = ["suid", "sgid", "sticky"];

/** The special-bit row's text — the bits ACTUALLY set are shown, dim ones are not, so a truthful preview either way. */
function specialRowText(specialBits: number, specialExplicit: boolean): string {
  const parts = SPECIAL_LABELS.filter(
    (_, i) => (specialBits & (1 << (2 - i))) !== 0,
  );
  const shown = parts.length > 0 ? parts.join(" ") : "none";
  return specialExplicit
    ? `special: ${shown}`
    : `special: ${shown} (preserved per file)`;
}

export function renderPermissionsOverlay(
  screen: Screen,
  screenWidth: number,
  screenHeight: number,
  info: PermissionsOverlayInfo,
): void {
  const box = computePermissionsBox(screenWidth, screenHeight);
  if (box.width < 4 || box.height < 4) return;

  screen.box(box.x, box.y, box.width, box.height, { fg: colors.chrome });

  const innerX = box.x + 2;
  const innerWidth = Math.max(box.width - 4, 0);
  const bottomBorderY = box.y + box.height - 1;

  const titleY = box.y + 1;
  const headerY = box.y + 3;
  const gridStartY = box.y + 4; // 3 rows: user, group, other
  const specialY = gridStartY + 3;
  const octalY = specialY + 1;
  const footerY = box.y + box.height - 2;

  screen.put(
    innerX,
    titleY,
    truncate(`Permissions — ${info.targetLabel}`, innerWidth),
    { fg: colors.titleEmphasis, attr: ATTR_BOLD },
  );

  const labelWidth = 7; // "user   " / "group  " / "other  "
  const cellWidth = 3; // "[x]"

  if (headerY < bottomBorderY) {
    let text = " ".repeat(labelWidth);
    for (const c of COLS) text += ` ${c} `;
    screen.put(innerX, headerY, truncate(text, innerWidth), {
      fg: colors.header,
    });
  }

  for (let row = 0; row < ROWS.length; row++) {
    const y = gridStartY + row;
    if (y >= bottomBorderY) break;
    const label = pad(ROWS[row] ?? "", labelWidth);
    screen.put(innerX, y, label, { fg: colors.dim });
    for (let col = 0; col < COLS.length; col++) {
      const idx = row * 3 + col;
      const set = bitAt(info.rwxBits, idx);
      const cellText = `[${set ? "x" : " "}]`;
      const style: Style =
        idx === info.focus
          ? { attr: ATTR_REVERSE }
          : { fg: set ? colors.accent : colors.dim };
      screen.put(innerX + labelWidth + col * cellWidth, y, cellText, style);
    }
  }

  if (specialY < bottomBorderY) {
    screen.put(
      innerX,
      specialY,
      truncate(
        specialRowText(info.specialBits, info.specialExplicit),
        innerWidth,
      ),
      { fg: colors.dim },
    );
  }

  if (octalY < bottomBorderY) {
    const octal = formatOctal(
      info.rwxBits,
      info.specialBits,
      info.specialExplicit,
    );
    screen.put(innerX, octalY, `octal: ${octal}`, { fg: colors.accent });
    if (info.error) {
      const errText = truncate(info.error, Math.max(innerWidth - 20, 0));
      screen.put(innerX + 20, octalY, errText, { fg: colors.error });
    }
  }

  if (footerY < bottomBorderY && footerY > octalY) {
    screen.put(
      innerX,
      footerY,
      pad("Space toggle · digits octal · Enter apply · Esc cancel", innerWidth),
      { fg: colors.dim },
    );
  }
}
