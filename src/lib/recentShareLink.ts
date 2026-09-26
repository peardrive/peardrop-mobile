/**
 * Which action the Send sheet's Recent Shares list offers on a row: hand out
 * the link, or start sharing again first. `"share-again"` is the safe answer
 * in every doubtful case, because handing out a link no peer can resolve is
 * the defect. A stopped drive is still listed with its link string, and a
 * failed hydration stays in `activeDriveIds` with no swarm, so both sets are
 * consulted and any caller must list both in its dependency array.
 */

/**
 * The fields of a list row this decision actually reads. Structural rather than
 * an import of `DriveRow`, so this module stays free of `src/state/types` and
 * therefore of react-native.
 */
export type RecentShareRow = {
  /** Engine `driveId` for hosted rows. */
  id: string;
  /** `"hosted"` | `"received"`. Anything else is treated as not-received. */
  origin?: string | null;
  /** The `peardrop://` link, as reported by `engineListDrives`. */
  shareLink?: string | null;
};

/**
 * The only thing this module needs from `activeDriveIds` / `failedHydrationIds`.
 * A `Set<string>` satisfies it; so does a test double, without either side
 * importing the other.
 */
export type DriveIdSet = { has(id: string): boolean };

/**
 * Recent Shares shows at most this many rows.
 *
 * Round 2 / F4: the `MainScreen` call site must pass THIS, not a literal.
 * It previously passed a literal `5` while this constant had zero production
 * call sites, so the cap test proved the module default rather than the shipped
 * cap — changing the constant would have moved the test and left the app alone.
 *
 * Unrelated to `RECENT_SHARES_LIMIT = 60` in `src/ui/FilePickerSheet.tsx:47`.
 */
export const RECENT_SHARES_LIMIT = 5;

/**
 * True when the Recent Shares row may be offered a copyable link.
 *
 * `failedHydrationIds` has no default, so a call site cannot forget it and
 * still compile; at runtime an absent set is tolerated because absent and
 * empty both mean no failure is known. `activeDriveIds` fails closed instead:
 * absent there means no drive is known to be announcing.
 */
export function canOfferRecentShareLink(
  row: RecentShareRow | null | undefined,
  activeDriveIds: DriveIdSet | null | undefined,
  failedHydrationIds: DriveIdSet | null | undefined,
): boolean {
  if (!row) return false;
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  // A received share is not yours to re-share from this surface.
  if (row.origin === "received") return false;
  // No link to hand out at all.
  if (typeof row.shareLink !== "string" || row.shareLink.length === 0) {
    return false;
  }
  // the engine reports a link for a stopped share. Fail closed when the
  // set is missing rather than assuming everything is announcing.
  if (!activeDriveIds || !activeDriveIds.has(row.id)) return false;
  // F2: a failed hydration leaves the drive in `activeDriveIds` with no swarm.
  // `failed` overrides `active`, matching `MainScreen.tsx:2998-3003`.
  if (failedHydrationIds && failedHydrationIds.has(row.id)) return false;
  return true;
}

/**
 * Which pill a Recent Shares row gets.
 *
 * - `"link"` — the share is announcing right now; copy the link.
 * - `"share-again"` — it is not; start sharing first, then offer the link.
 */
export type RecentShareAction = "link" | "share-again";

/**
 * the single place that turns "is it announcing?" into a pill.
 *
 * Deliberately a thin wrapper rather than two independent conditions. If the
 * Link pill and the link string behind it could disagree, a row could show
 * "Link" and copy nothing, or show "Share again" beside a live share. The test
 * asserts this is the exact inverse of `canOfferRecentShareLink` over every
 * combination of the two sets, so the two cannot drift.
 */
export function recentShareAction(
  row: RecentShareRow | null | undefined,
  activeDriveIds: DriveIdSet | null | undefined,
  failedHydrationIds: DriveIdSet | null | undefined,
): RecentShareAction {
  return canOfferRecentShareLink(row, activeDriveIds, failedHydrationIds)
    ? "link"
    : "share-again";
}

/**
 * True when the row belongs in Recent Shares at all, announcing or not: a
 * hosted row that has a link string. Announcing state is not consulted — that
 * is `recentShareAction`'s job. Received rows stay out because their id is
 * `share:<shareKey>`, which activation can only answer `drive-not-found`.
 */
function isRecentShareRow(row: RecentShareRow | null | undefined): boolean {
  if (!row) return false;
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  if (row.origin === "received") return false;
  if (typeof row.shareLink !== "string" || row.shareLink.length === 0) {
    return false;
  }
  return true;
}

/**
 * The Recent Shares selection: hosted rows with a link, capped, order preserved.
 *
 * Filter-then-cap, not cap-then-filter — received and link-less rows must not
 * consume slots. Stopped shares do consume slots: they are kept and tagged
 * `"share-again"`.
 */
export function selectRecentShareRows<T extends RecentShareRow>(
  rows: readonly T[] | null | undefined,
  limit: number = RECENT_SHARES_LIMIT,
): T[] {
  if (!rows || rows.length === 0) return [];
  return rows.filter((r) => isRecentShareRow(r)).slice(0, limit);
}
