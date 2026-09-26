/**
 * May this row be offered a share-activating action? One definition, because
 * the same decision is made at several call sites. A received row's id is
 * `share:<shareKey>`, while `engineActivateDrive` looks the id up in
 * `manifest.drives`, keyed by engine `driveId` — so the lookup cannot hit and
 * the user is told "Drive not found" about a share in front of them. Gating on
 * file count instead would only move the failure to a different row.
 *
 * No imports, by design — jest runs this under `testEnvironment: "node"` and
 * nothing here needs react-native.
 */

/**
 * Prefix `MainScreen` gives a synthesized received-share row.
 *
 * Exported so the test pins the literal rather than re-typing it: the whole
 * defect is that this shape is not an engine `driveId`, and a test that
 * hardcodes its own copy would keep passing if the prefix ever changed.
 */
export const SYNTHETIC_SHARE_ROW_PREFIX = "share:";

/**
 * The fields of a list row this decision actually reads. Structural rather
 * than an import of `DriveRow`, so this module stays free of `src/state/types`
 * and therefore of react-native.
 */
export type ShareActivationRow = {
  /** Row id. An engine `driveId` for hosted rows; `share:<shareKey>` for received. */
  id: string;
  /** `"hosted"` | `"received"`. Anything else is treated as not-received. */
  origin?: string | null;
  /** Whether the engine currently has this drive announcing. */
  isActive: boolean;
};

/** Is this id the synthetic one `MainScreen` mints for a received share? */
export function isSyntheticShareRowId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(SYNTHETIC_SHARE_ROW_PREFIX);
}

/**
 * True when it is safe to offer "Start sharing" / "Share it" on this row.
 *
 * The two received-row rejections below are deliberately independent rather
 * than one condition. They are the same fact — the row is not backed by an
 * engine driveId — observed two different ways, and either one alone is enough
 * to be correct. Keeping both means a future refactor that drops `origin` from
 * the row shape, or changes the synthetic id prefix, still fails closed. The
 * test asserts each in isolation so neither can be quietly deleted as
 * redundant.
 */
export function canOfferStartSharing(
  row: ShareActivationRow | null | undefined,
): boolean {
  if (!row) return false;
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  // Already announcing — the action on offer is Stop sharing, not Start.
  if (row.isActive) return false;
  // Not an engine driveId: `engineActivateDrive` keys `manifest.drives` by
  // driveId and would answer `drive-not-found`.
  if (isSyntheticShareRowId(row.id)) return false;
  // A received row cannot be activated by id today, whatever its id looks like.
  if (row.origin === "received") return false;
  return true;
}
