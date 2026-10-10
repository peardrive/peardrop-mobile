import fs from "fs";
import path from "path";

import { PINNING_ENABLED } from "../pinning";

/** Source-text probes for the two `.tsx` pinning surfaces jest cannot render.
 * They prove the guard exists, not that it runs. */

const MAIN_SCREEN = path.join(__dirname, "..", "..", "screens", "MainScreen.tsx");
const SHARE_ROW = path.join(__dirname, "..", "..", "ui", "ShareRow.tsx");

const mainSrc = fs.readFileSync(MAIN_SCREEN, "utf8");
const rowSrc = fs.readFileSync(SHARE_ROW, "utf8");

const GUARD = "          if (PINNING_ENABLED) {";
const GUARD_END = "\n          }";

/** Avoids feeding a 3,900-line file to `toContain`, whose failure report would
 * bury every other failure beside it. */
function contains(src: string, needle: string): { needle: string; present: boolean } {
  return { needle, present: src.includes(needle) };
}
const present = (needle: string) => ({ needle, present: true });
const absent = (needle: string) => ({ needle, present: false });

/** The source between `start` and `end`, with both bounds asserted. */
function region(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect({ marker: start, found: from >= 0 }).toEqual({
    marker: start,
    found: true,
  });
  const rest = src.slice(from + start.length);
  const to = rest.indexOf(end);
  expect({ marker: end, found: to >= 0 }).toEqual({ marker: end, found: true });
  return rest.slice(0, to);
}

describe("no pin action is offered while the switch is off", () => {
  /** Bounded to the guard's own window: an unbounded search would pass with the
   * guard deleted and the push left behind. */
  it("wraps the kebab pin row in the PINNING_ENABLED guard", () => {
    const guarded = region(mainSrc, GUARD, GUARD_END);
    expect(contains(guarded, 'key: "pin",')).toEqual(present('key: "pin",'));
    expect(contains(guarded, "togglePinned(kebabDrive);")).toEqual(
      present("togglePinned(kebabDrive);")
    );
  });

  /** The guard must appear exactly once, or a second surface is ungated. */
  it("has exactly one such guard in the file", () => {
    expect(mainSrc.split(GUARD).length - 1).toBe(1);
  });

  /** A label outside the guard means a second surface the switch misses. */
  it("has no Pin or Unpin label outside that guard", () => {
    const guarded = region(mainSrc, GUARD, GUARD_END);
    for (const label of ['"Unpin"', '"Pin to top"']) {
      const total = mainSrc.split(label).length - 1;
      const inside = guarded.split(label).length - 1;
      expect({ label, total, inside }).toEqual({ label, total: 1, inside: 1 });
    }
  });

  /** Kept wired so the switch is a one-line change, not a rewrite;
   * `reshareWiring.test.ts` also uses this declaration as a boundary. */
  it("keeps togglePinned and both storage setters in place", () => {
    for (const needle of [
      "  const togglePinned = useCallback(",
      "void setSharePinned(drive.share.shareKey, next);",
      "void setHostedSharePinned(drive.id, next);",
    ]) {
      expect(contains(mainSrc, needle)).toEqual(present(needle));
    }
  });
});

describe("no pin icon while the switch is off", () => {
  it("gates the inline pin icon on PINNING_ENABLED", () => {
    expect(contains(rowSrc, "{PINNING_ENABLED && isPinned ? (")).toEqual(
      present("{PINNING_ENABLED && isPinned ? (")
    );
  });

  /** One pin glyph, and it is the gated one; the star is `isFavorite`. */
  it("renders the pin glyph nowhere else, and leaves the star alone", () => {
    expect(rowSrc.split('name="pin"').length - 1).toBe(1);
    expect(contains(rowSrc, "{isFavorite ? (")).toEqual(
      present("{isFavorite ? (")
    );
  });
});

describe("both sort sites go through comparePinned", () => {
  /** Only that both sort calls reach it: a green suite over a module nothing
   * calls is not evidence. */
  it("calls comparePinned at both sort sites", () => {
    expect(mainSrc.split("comparePinned(a, b)").length - 1).toBe(2);
    const imp = 'import { comparePinned, PINNING_ENABLED } from "../lib/pinning";';
    expect(contains(mainSrc, imp)).toEqual(present(imp));
  });

  /** An inline comparator ignores the switch. It must be gone. */
  it("compares no pin flag inline any more", () => {
    for (const dead of ["const pa = a.isPinned", "const pb = b.isPinned"]) {
      expect(contains(mainSrc, dead)).toEqual(absent(dead));
    }
  });
});

describe("the switch these probes are about", () => {
  it("is off, so every guard above resolves to the absent branch", () => {
    expect(PINNING_ENABLED).toBe(false);
  });
});
