// tests/conflict.test.ts — fsapi/ops/conflict.ts's `uniqueName`, exhaustively.
// Pure function, no filesystem — every case is just a name plus a set of
// names already "there."

import { describe, expect, it } from "bun:test";
import { uniqueName } from "../src/fsapi/ops/conflict.ts";

describe("uniqueName", () => {
  it("returns the name unchanged when there is no collision", () => {
    expect(uniqueName("report.txt", [])).toBe("report.txt");
    expect(uniqueName("report.txt", ["other.txt"])).toBe("report.txt");
  });

  it("suffixes before the extension on a single collision", () => {
    expect(uniqueName("report.txt", ["report.txt"])).toBe("report 2.txt");
  });

  it("keeps incrementing past multiple existing numbered collisions", () => {
    const existing = ["report.txt", "report 2.txt"];
    expect(uniqueName("report.txt", existing)).toBe("report 3.txt");
  });

  it("handles a destination pre-seeded with many numbered collisions", () => {
    const existing = [
      "report.txt",
      ...Array.from({ length: 49 }, (_, i) => `report ${i + 2}.txt`),
    ];
    // existing now holds report.txt, report 2.txt .. report 50.txt
    expect(uniqueName("report.txt", existing)).toBe("report 51.txt");
  });

  it("treats known double extensions as a single unit", () => {
    expect(uniqueName("report.tar.gz", ["report.tar.gz"])).toBe(
      "report 2.tar.gz",
    );
    expect(uniqueName("archive.tar.bz2", ["archive.tar.bz2"])).toBe(
      "archive 2.tar.bz2",
    );
    expect(uniqueName("archive.tar.xz", ["archive.tar.xz"])).toBe(
      "archive 2.tar.xz",
    );
    // Never the wrong split: "report.tar 2.gz" would be wrong.
    expect(uniqueName("report.tar.gz", ["report.tar.gz"])).not.toBe(
      "report.tar 2.gz",
    );
  });

  it("keeps incrementing a double extension past multiple collisions", () => {
    const existing = ["report.tar.gz", "report 2.tar.gz"];
    expect(uniqueName("report.tar.gz", existing)).toBe("report 3.tar.gz");
  });

  it("treats a dotfile as having no extension", () => {
    expect(uniqueName(".bashrc", [".bashrc"])).toBe(".bashrc 2");
    // Must not split on the leading dot as if it were an extension
    // separator (that would wrongly produce base="" ext=".bashrc").
    expect(uniqueName(".bashrc", [".bashrc"])).not.toBe(" 2.bashrc");
  });

  it("handles a dotfile with a real extension after the leading dot", () => {
    // ".config.json" — leading dot is part of the name, ".json" is real.
    expect(uniqueName(".config.json", [".config.json"])).toBe(".config 2.json");
  });

  it("handles a name with no extension at all", () => {
    expect(uniqueName("README", ["README"])).toBe("README 2");
  });

  it("handles a name with a trailing dot and nothing after it", () => {
    const result = uniqueName("weird.", ["weird."]);
    expect(result).not.toBe("weird.");
    // Whatever it picks, it must not collide.
    expect(new Set(["weird."]).has(result)).toBe(false);
  });

  it("handles a name that already ends in a number", () => {
    expect(uniqueName("photo 2.png", ["photo 2.png"])).toBe("photo 2 2.png");
  });

  it("resolves collisions against both the base name and its own numbered variants together", () => {
    const existing = ["draft.md", "draft 2.md", "draft 3.md", "draft 5.md"];
    // 4 is free even though 5 is taken — the function must not assume a
    // contiguous run, just keep incrementing from 2 until something's free.
    expect(uniqueName("draft.md", existing)).toBe("draft 4.md");
  });

  it("accepts a Set directly as well as an array", () => {
    const existing = new Set(["report.txt"]);
    expect(uniqueName("report.txt", existing)).toBe("report 2.txt");
  });

  it("simulates pasting the same directory twice in a row: x, x 2, x 3", () => {
    let existing: string[] = [];
    const first = uniqueName("x", existing);
    existing = [...existing, first];
    const second = uniqueName("x", existing);
    existing = [...existing, second];
    const third = uniqueName("x", existing);
    expect([first, second, third]).toEqual(["x", "x 2", "x 3"]);
  });
});
