/**
 * An offline re-grab must ask for the missing files only, and the picker must
 * be buildable from the stored record alone. Every assertion runs against the
 * real `src/lib/receivedRegrab.ts`, the module
 * `src/state/ShareLinkFlowContext.tsx` calls for both jobs; nothing here
 * restates engine behaviour.
 *
 * On a resolve-bypassing grab `alreadyDownloadedNames` is empty, so the naive
 * partition is `{ fetch: everything asked for, keep: [] }`. The engine skips
 * nothing: `engineDownload` selects by `wantedSet` and resolves a name
 * collision through `uniquePath`, which returns `` `${stem} (${i})${ext}` ``.
 * So a fetch list that still contains an already-held name does not no-op —
 * it writes `photo (1).jpg` next to `photo.jpg` and charges the user the
 * bytes. The partition is the only thing standing between an offline re-grab
 * and that.
 *
 * That `runDownload` calls this, and that the engine honours the list, are not
 * assertable here: `ShareLinkFlowContext.tsx` is `.tsx` and unreachable from
 * this suite, and the engine is a separate realm.
 */

import {
  heldNames,
  isHeld,
  missingNames,
  partitionGrabNames,
  storedShareToOpenResult,
  type StoredShareLike,
} from "../receivedRegrab";

const KEY = "a".repeat(64);

const held = (name: string, size = 10) => ({
  name,
  size,
  isDownloaded: true,
  localPath: `/data/peardrop/downloads/Trip/${name.replace(/^\//, "")}`,
});
const missing = (name: string, size = 10) => ({ name, size, isDownloaded: false });

function share(files: StoredShareLike["files"], extra: Partial<StoredShareLike> = {}): StoredShareLike {
  return {
    shareKey: KEY,
    shareLink: `peardrop://${KEY}`,
    shareName: "Trip",
    files,
    ...extra,
  };
}

describe("the grab asks for the missing files only", () => {
  /** THE PROBE. Half the share is on disk; a "Grab everything" must fetch half. */
  it("fetches only what is missing when the whole share is requested", () => {
    const files = [held("/a.txt"), missing("/b.txt")];
    expect(partitionGrabNames(files)).toEqual({ fetch: ["/b.txt"], keep: ["/a.txt"] });
  });

  /**
   * The user explicitly ticked a file they already have. The skip still
   * applies, which is what stops `uniquePath` minting `a (1).txt`, and the
   * kept name is reported so the caller can say what it kept.
   */
  it("keeps, rather than re-fetches, an already-held file the user ticked", () => {
    const files = [held("/a.txt"), missing("/b.txt")];
    expect(partitionGrabNames(files, ["/a.txt", "/b.txt"])).toEqual({
      fetch: ["/b.txt"],
      keep: ["/a.txt"],
    });
  });

  it("fetches nothing when every requested file is already held", () => {
    const files = [held("/a.txt"), held("/b.txt")];
    expect(partitionGrabNames(files)).toEqual({ fetch: [], keep: ["/a.txt", "/b.txt"] });
  });

  it("fetches everything when nothing is held", () => {
    const files = [missing("/a.txt"), missing("/b.txt")];
    expect(partitionGrabNames(files)).toEqual({ fetch: ["/a.txt", "/b.txt"], keep: [] });
  });

  /**
   * A flag with no path is not a file. `describeHoldings` requires the same
   * pair, because trusting the flag alone survives for the life of an install.
   */
  it("treats isDownloaded with no localPath as missing", () => {
    const files = [{ name: "/a.txt", size: 10, isDownloaded: true }];
    expect(isHeld(files[0])).toBe(false);
    expect(partitionGrabNames(files)).toEqual({ fetch: ["/a.txt"], keep: [] });
  });

  /**
   * The caller asked for a name the record does not carry. Passing it through
   * is deliberate: the engine is the authority on what the drive holds, and
   * dropping a request silently is how a grab reports success having fetched
   * nothing.
   */
  it("passes an unknown requested name through to fetch", () => {
    const files = [held("/a.txt")];
    expect(partitionGrabNames(files, ["/ghost.txt"])).toEqual({
      fetch: ["/ghost.txt"],
      keep: [],
    });
  });

  it("names the held and missing sets consistently with the partition", () => {
    const files = [held("/a.txt"), missing("/b.txt"), held("/c.txt")];
    expect(heldNames(files)).toEqual(["/a.txt", "/c.txt"]);
    expect(missingNames(files)).toEqual(["/b.txt"]);
    expect(partitionGrabNames(files).fetch).toEqual(missingNames(files));
    expect(partitionGrabNames(files).keep).toEqual(heldNames(files));
  });
});

describe("the offline picker's file list comes off the stored record", () => {
  it("produces the shape SharePreviewModal consumes, with no engine call", () => {
    const out = storedShareToOpenResult(
      share([held("/photo.jpg", 100), missing("/clip.mp4", 900)]),
    );
    expect(out.ok).toBe(true);
    expect(out.hasManifest).toBe(true);
    expect(out.shareName).toBe("Trip");
    expect(out.totalBytes).toBe(1000);
    expect(out.files).toEqual([
      { name: "/photo.jpg", displayName: "photo.jpg", size: 100 },
      { name: "/clip.mp4", displayName: "clip.mp4", size: 900 },
    ]);
  });

  /**
   * `hasManifest` must be `true`: `src/lib/resolveOutcome.ts` gates on
   * `=== true` and fails closed, so an adapter that left it unset or `false`
   * would be rejected by `applyDedupClassification` and the picker would never
   * open. The record only exists because a manifest was parsed once.
   */
  it("passes classifyResolve, so the picker is not rejected as unusable", async () => {
    const { classifyResolve } = await import("../resolveOutcome");
    expect(classifyResolve(storedShareToOpenResult(share([missing("/a.txt")])))).toBe("usable");
  });

  /**
   * The persisted driveId is what lets the grab reopen the drive by id
   * instead of re-resolving the link. A legacy record has none, and the field
   * must then be absent rather than `undefined`-but-present, because
   * `startDownload`/`activateDrive` are given it directly.
   */
  it("carries a persisted driveId through, and omits the key when there is none", () => {
    expect(storedShareToOpenResult(share([missing("/a.txt")], { driveId: "recv_1_ab" })).driveId).toBe(
      "recv_1_ab",
    );
    const legacy = storedShareToOpenResult(share([missing("/a.txt")]));
    expect("driveId" in legacy).toBe(false);
  });

  it("falls back to a neutral name rather than rendering an empty title", () => {
    expect(storedShareToOpenResult(share([], { shareName: "" })).shareName).toBe("Share");
    expect(storedShareToOpenResult(share([], { shareName: null })).shareName).toBe("Share");
  });

  /** A manifest that carried no sizes must read as 0 bytes, never as NaN. */
  it("coerces absent and malformed sizes to zero", () => {
    const out = storedShareToOpenResult(
      share([
        { name: "/a.txt", isDownloaded: false },
        { name: "/b.txt", size: Number.NaN, isDownloaded: false },
        { name: "/c.txt", size: -5, isDownloaded: false },
      ]),
    );
    expect(out.totalBytes).toBe(0);
    expect(out.files?.map((f) => f.size)).toEqual([0, 0, 0]);
  });
});
