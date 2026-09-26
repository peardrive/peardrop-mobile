/**
 * Tripwire — "Start sharing" must never be offered on a received row. The
 * decision lives in `src/lib/shareActions.ts`; this file fails if the
 * predicate is widened, which is the change that would silently re-break
 * every call site at once.
 *
 * A received row's id is `share:<shareKey>`, one per share key, while
 * `engineActivateDrive` keys `manifest.drives` by engine `driveId`, so the
 * lookup cannot hit.
 */

import {
  SYNTHETIC_SHARE_ROW_PREFIX,
  canOfferStartSharing,
  isSyntheticShareRowId,
} from "../shareActions";

const HOSTED_ID = "drive_1789837768922_zehwy4zs";
const SHARE_KEY =
  "404da1b69436ecd9c0b4baec3adf9c344b34b8453fd228bd426885d312ed097f";
const RECEIVED_ID = `${SYNTHETIC_SHARE_ROW_PREFIX}${SHARE_KEY}`;
const RECV_ENGINE_ID = "recv_1789837768922_zehwy4zs";

describe("isSyntheticShareRowId", () => {
  test("recognises the synthesized received-row id", () => {
    expect(isSyntheticShareRowId(RECEIVED_ID)).toBe(true);
  });

  test("does not match an engine driveId of either origin", () => {
    // `recv_…` is a real engine driveId — the engine mints it in
    // `engineOpenDrive`. It is NOT the synthetic row id, and conflating the
    // two is its own bug.
    expect(isSyntheticShareRowId(HOSTED_ID)).toBe(false);
    expect(isSyntheticShareRowId(RECV_ENGINE_ID)).toBe(false);
  });

  test("does not throw on non-strings", () => {
    expect(isSyntheticShareRowId(undefined)).toBe(false);
    expect(isSyntheticShareRowId(null)).toBe(false);
    expect(isSyntheticShareRowId(42)).toBe(false);
    expect(isSyntheticShareRowId({})).toBe(false);
  });
});

describe("canOfferStartSharing — hosted rows", () => {
  test("inactive hosted row IS offered the action", () => {
    expect(
      canOfferStartSharing({ id: HOSTED_ID, origin: "hosted", isActive: false }),
    ).toBe(true);
  });

  test("active hosted row is NOT — the action there is Stop sharing", () => {
    expect(
      canOfferStartSharing({ id: HOSTED_ID, origin: "hosted", isActive: true }),
    ).toBe(false);
  });

  test("a missing origin is treated as hosted, matching the engine default", () => {
    // `engineListDrives` emits `origin: entry.origin || "hosted"`, so an older
    // manifest entry without the field reads as hosted everywhere else too.
    expect(canOfferStartSharing({ id: HOSTED_ID, isActive: false })).toBe(true);
    expect(
      canOfferStartSharing({ id: HOSTED_ID, origin: null, isActive: false }),
    ).toBe(true);
  });
});

describe("canOfferStartSharing — received rows", () => {
  test("THE INVARIANT: a received row is never offered the action", () => {
    expect(
      canOfferStartSharing({
        id: RECEIVED_ID,
        origin: "received",
        isActive: false,
      }),
    ).toBe(false);
  });

  test("…and not when it is somehow marked active either", () => {
    // `activeDriveIds` is keyed by engine driveId so this cannot happen today.
    // Asserted anyway: if that ever changes, the answer must not flip to true.
    expect(
      canOfferStartSharing({
        id: RECEIVED_ID,
        origin: "received",
        isActive: true,
      }),
    ).toBe(false);
  });

  test("the two rejections are independent — synthetic id alone is enough", () => {
    // Origin dropped from the row shape by some future refactor.
    expect(canOfferStartSharing({ id: RECEIVED_ID, isActive: false })).toBe(
      false,
    );
  });

  test("the two rejections are independent — origin alone is enough", () => {
    // Engine driveId, but the row still declares itself received. This is the
    // shape a future "one row per engine drive" change would produce.
    expect(
      canOfferStartSharing({
        id: RECV_ENGINE_ID,
        origin: "received",
        isActive: false,
      }),
    ).toBe(false);
  });

  test("downloaded files are NOT part of the decision", () => {
    // The predicate deliberately reads no file state: the id is wrong
    // whatever has landed on disk, so gating on it would fix nothing.
    const rowShapeCarriesNoFileInfo = {
      id: RECEIVED_ID,
      origin: "received",
      isActive: false,
    };
    expect(Object.keys(rowShapeCarriesNoFileInfo)).not.toContain("localFiles");
    expect(canOfferStartSharing(rowShapeCarriesNoFileInfo)).toBe(false);
  });
});

describe("canOfferStartSharing — degenerate input", () => {
  test("null / undefined rows are refused rather than thrown on", () => {
    expect(canOfferStartSharing(null)).toBe(false);
    expect(canOfferStartSharing(undefined)).toBe(false);
  });

  test("an empty id is refused", () => {
    expect(canOfferStartSharing({ id: "", origin: "hosted", isActive: false })).toBe(
      false,
    );
  });
});
