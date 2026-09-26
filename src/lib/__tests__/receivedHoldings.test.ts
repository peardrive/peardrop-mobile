/**
 * A partly-downloaded share must not read like a complete one. Runs against
 * the real `src/lib/receivedHoldings.ts` and the real `src/lib/format.ts`;
 * nothing is mocked and neither module has a platform import.
 *
 * `MainScreen.tsx` is `.tsx` and the suite collects only `*.test.ts`, so that
 * the row calls these helpers, and that hosted rows are left alone, is not
 * asserted here. The derivation they delegate to is asserted in full.
 */

import { formatBytes, formatBytesOrUnknown } from "../format";
import {
  describeHoldings,
  holdingsBytesLabel,
  holdingsCountLabel,
} from "../receivedHoldings";

const MB = 1024 * 1024;

function share(held: number, total: number, sizePerFile = MB) {
  return Array.from({ length: total }, (_, i) => ({
    size: sizePerFile,
    isDownloaded: i < held,
    localPath: i < held ? `/downloads/f${i}` : undefined,
  }));
}

describe("the row must answer 'what do I have', not 'what was sent'", () => {
  /**
   * The probe. A row that sums every manifest file with no `isDownloaded`
   * filter produces the same string for both of these, and that
   * indistinguishability is the defect.
   */
  it("distinguishes 3-of-12 from 12-of-12", () => {
    const partial = holdingsBytesLabel(describeHoldings(share(3, 12)));
    const complete = holdingsBytesLabel(describeHoldings(share(12, 12)));
    expect(partial).not.toBe(complete);
    expect(partial).toBe("3.0 MB of 12.0 MB");
    expect(complete).toBe("12.0 MB");
  });

  it("says so in the count too", () => {
    expect(holdingsCountLabel(describeHoldings(share(3, 12)), "Files")).toBe("3 of 12 Files");
    expect(holdingsCountLabel(describeHoldings(share(12, 12)), "Files")).toBe("12 Files");
  });

  it("counts a file as held only when it has BOTH the flag and a path", () => {
    const h = describeHoldings([
      { size: MB, isDownloaded: true, localPath: "/downloads/a" },
      // Flag with no path is not a file you can open.
      { size: MB, isDownloaded: true },
      { size: MB, isDownloaded: false, localPath: "/downloads/c" },
    ]);
    expect(h.heldCount).toBe(1);
    expect(h.heldBytes).toBe(MB);
    expect(h.totalBytes).toBe(3 * MB);
    expect(h.allHeld).toBe(false);
  });

  it("shows the plain total when nothing is held — 'of' needs two numbers", () => {
    expect(holdingsBytesLabel(describeHoldings(share(0, 5)))).toBe("5.0 MB");
    expect(holdingsCountLabel(describeHoldings(share(0, 5)), "Files")).toBe("0 of 5 Files");
  });

  it("does not put a count on a single-file share", () => {
    expect(holdingsCountLabel(describeHoldings(share(0, 1)), "Files")).toBe("Files");
    expect(holdingsCountLabel(describeHoldings(share(1, 1)), "Files")).toBe("Files");
  });

  it("treats an empty share as not complete", () => {
    expect(describeHoldings([]).allHeld).toBe(false);
  });
});

describe("'0 B' was a claim about the share, not about our knowledge", () => {
  /**
   * `formatBytes` must not be changed for this: it has many honest call sites
   * that pass a measured size. The new function is additive.
   */
  it("leaves formatBytes exactly as it was", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formatBytesOrUnknown says nothing rather than asserting emptiness", () => {
    expect(formatBytesOrUnknown(0)).toBe("—");
    expect(formatBytesOrUnknown(null)).toBe("—");
    expect(formatBytesOrUnknown(undefined)).toBe("—");
    expect(formatBytesOrUnknown(NaN)).toBe("—");
    expect(formatBytesOrUnknown(-1)).toBe("—");
    expect(formatBytesOrUnknown(1024)).toBe("1.0 KB");
    expect(formatBytesOrUnknown(0, "Size unknown")).toBe("Size unknown");
  });

  it("a size-less manifest reads as unknown, not as an empty share", () => {
    const h = describeHoldings([{ isDownloaded: false }, { isDownloaded: false }]);
    expect(h.totalBytes).toBe(0);
    expect(holdingsBytesLabel(h)).toBe("—");
    // …and the count still tells the user what they have.
    expect(holdingsCountLabel(h, "Files")).toBe("0 of 2 Files");
  });
});
