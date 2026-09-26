/**
 * A tap on an incomplete received share must reopen the picker.
 *
 * Every assertion runs against the real `src/lib/receivedRowRoute.ts`, the
 * module `src/screens/MainScreen.tsx`'s `onTapRow` calls. It is not a copy of
 * the handler's logic asserted against itself: the handler has no logic left
 * to copy, it dispatches on this function's return value.
 *
 * A four-way decision on `isBundle`, then `primaryFile`, then the info panel,
 * with `origin` never read, is what the `"regrab-picker"` cases below exist to
 * reject.
 *
 * That `onTapRow` calls this, and that the picker appears, are not assertable
 * here: `MainScreen.tsx` is `.tsx` and unreachable from this suite, whose
 * `testMatch` collects only `*.test.ts`.
 */

import { rowTapRoute, type RowTapInput } from "../receivedRowRoute";
import { describeHoldings } from "../receivedHoldings";

/** A stored share file, as `receivedSharesStorage` holds it. */
const held = (name: string, size = 10) => ({
  name,
  size,
  isDownloaded: true,
  localPath: `/downloads/${name}`,
});
const missing = (name: string, size = 10) => ({ name, size, isDownloaded: false });

/**
 * Built through the real `describeHoldings`, deliberately: the label and the
 * route read one predicate, and a hand-written `{ allHeld }` here would let
 * them drift without the test noticing.
 */
function receivedRow(files: ReturnType<typeof held>[] | ReturnType<typeof missing>[]): RowTapInput {
  const localFiles = files.filter((f) => f.isDownloaded);
  return {
    origin: "received",
    isBundle: files.length > 1,
    hasPrimaryFile: localFiles.length === 1,
    hasStoredShare: true,
    holdings: describeHoldings(files),
  };
}

describe("an incomplete received share routes to the picker", () => {
  /**
   * The probe: open a link, see the list, leave without choosing, come back.
   * Nothing downloaded, several files.
   */
  it("routes a received share with nothing downloaded to the picker", () => {
    const row = receivedRow([missing("/a.txt"), missing("/b.txt"), missing("/c.txt")]);
    expect(rowTapRoute(row)).toBe("regrab-picker");
  });

  /** A grab that got part of the way: still missing files, so still the picker. */
  it("routes a partially-downloaded received share to the picker", () => {
    const row = receivedRow([held("/a.txt"), missing("/b.txt")]);
    expect(rowTapRoute(row)).toBe("regrab-picker");
  });

  /** The single-file case, which otherwise falls to the info panel. */
  it("routes a single missing file to the picker, not the info panel", () => {
    const row = receivedRow([missing("/only.txt")]);
    expect(rowTapRoute(row)).toBe("regrab-picker");
  });
});

describe("a complete received share opens as it does today", () => {
  it("opens the folder modal for a complete multi-file share", () => {
    const row = receivedRow([held("/a.txt"), held("/b.txt")]);
    expect(rowTapRoute(row)).toBe("folder-modal");
  });

  it("opens the file preview for a complete single-file share", () => {
    const row = receivedRow([held("/only.txt")]);
    expect(rowTapRoute(row)).toBe("file-preview");
  });
});

describe("hosted rows are untouched", () => {
  it("opens the folder modal for a hosted bundle", () => {
    expect(
      rowTapRoute({ origin: "hosted", isBundle: true, hasPrimaryFile: false, hasStoredShare: false }),
    ).toBe("folder-modal");
  });

  it("opens the preview for a hosted single file", () => {
    expect(
      rowTapRoute({ origin: "hosted", isBundle: false, hasPrimaryFile: true, hasStoredShare: false }),
    ).toBe("file-preview");
  });

  /**
   * A hosted share whose local copy was evicted. This is the case the info
   * panel exists for and it must stay on it: a hosted row has no stored
   * `ReceivedShare` and nothing to re-grab.
   */
  it("keeps the info panel for a hosted single file with no local copy", () => {
    expect(
      rowTapRoute({ origin: "hosted", isBundle: false, hasPrimaryFile: false, hasStoredShare: false }),
    ).toBe("info-panel");
  });
});

describe("the picker branch cannot fire without the data it needs", () => {
  /**
   * The route says "open the picker over the stored file list". With no
   * stored record there is no list, so this must not claim the picker: the
   * caller would have nothing to pass it.
   */
  it("falls back to the info panel when the row carries no stored share", () => {
    expect(
      rowTapRoute({
        origin: "received",
        isBundle: false,
        hasPrimaryFile: false,
        hasStoredShare: false,
        holdings: null,
      }),
    ).toBe("info-panel");
  });

  /**
   * `describeHoldings([])` reports `allHeld: false`, which is correct for a
   * label and wrong as a re-grab trigger: there is nothing to grab.
   * `totalCount > 0` is the guard, and this is what keeps it there.
   */
  it("does not offer the picker for a received share with an empty file list", () => {
    const holdings = describeHoldings([]);
    expect(holdings.allHeld).toBe(false);
    expect(
      rowTapRoute({
        origin: "received",
        isBundle: false,
        hasPrimaryFile: false,
        hasStoredShare: true,
        holdings,
      }),
    ).toBe("info-panel");
  });

  /**
   * Positive control for the `origin` guard. Same missing-file holdings, same
   * empty `primaryFile`; the only difference from the first probe is the
   * origin. If this ever returns `"regrab-picker"` the guard has stopped being
   * read and the test above it proves nothing.
   */
  it("does not offer the picker to a hosted row carrying the same holdings", () => {
    expect(
      rowTapRoute({
        origin: "hosted",
        isBundle: false,
        hasPrimaryFile: false,
        hasStoredShare: true,
        holdings: describeHoldings([missing("/a.txt")]),
      }),
    ).toBe("info-panel");
  });
});
