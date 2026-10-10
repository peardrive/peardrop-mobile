/** Text for the two notification rows; never decides whether the service runs. */

import { formatBytes } from "./format";
import {
  NOTIFICATION_UPDATE_INTERVAL_MS,
  type NotificationPostDecision,
} from "./notificationProgress";
import { activeTransfers, type TransferActivityInput } from "./transferActivity";

/** 60 chars: Android clips mid-word past about 40 in the collapsed shade, but
 * the row is also read expanded. The ellipsis counts inside the limit. */
export const NAME_LIST_MAX_CHARS = 60;

/** One notification row, as fields Kotlin renders and does not interpret. */
export type NotificationRow = {
  title: string;
  text: string;
  /** Third line under `text`; empty when the row has none. */
  subline: string;
  /** `0..100`, or `PROGRESS_INDETERMINATE` / `PROGRESS_NONE`: the Sharing row
   * needs no bar, which one negative sentinel cannot express. */
  percent: number;
};

/** A sweeping bar: receiving, but the total is not known. */
export const PROGRESS_INDETERMINATE = -1;
/** No bar at all: the Sharing row, which is a status and not a transfer. */
export const PROGRESS_NONE = -2;

/** Which of the two rows is the foreground service's own notification. */
export type ServiceRowId = "receiving" | "sharing";

export type NotificationRows = {
  /** Present only while a download is running. */
  receiving: NotificationRow | null;
  /** Present only while there is a hosted share to describe. */
  sharing: NotificationRow | null;
  /** Receiving while a download runs, else Sharing: one service owns one id,
   * so the other row is posted separately. */
  serviceRow: ServiceRowId | null;
};

/** Structural subset rather than `TransferSummary`: this module must not
 * import from `src/state/types.ts`. */
export type NotificationTransferInput = TransferActivityInput & {
  driveId: string;
  bytesTransferred: number;
  totalBytes: number | null;
  /** Fallback denominator: `totalBytes` is not always populated for a host. */
  driveSize: number | null;
};

/** An empty array is a real case, not an error: the manifest carries no
 * received drive mid-download, so each branch reads correctly without names. */
export type DriveNamesResolver = (driveId: string) => readonly string[];

/** Finite-or-null. `NaN` is a `number`, and this is where that stops. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/** `formatBytes` without a trailing `.0`, only here: `120.0 MB` is noise in a
 * sub-line read at a glance. A fractional digit survives. */
export function formatNotificationBytes(bytes: number | null | undefined): string {
  return formatBytes(bytes).replace(/\.0 /, " ");
}

/** Cuts by character, not name boundary, so one over-long name still shows;
 * a trailing separator is trimmed so the result is never `a.jpg, …`. */
export function joinNames(names: readonly string[]): string {
  const cleaned = names
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n.length > 0);
  const joined = cleaned.join(", ");
  if (joined.length <= NAME_LIST_MAX_CHARS) return joined;
  const cut = joined.slice(0, NAME_LIST_MAX_CHARS - 1).replace(/[\s,]+$/, "");
  return `${cut}…`;
}

/** Calls `activeTransfers` rather than re-deriving it: drift would describe a
 * different transfer from the one holding the process alive. */
export function describeNotificationRows(
  list: readonly NotificationTransferInput[],
  now: number,
  namesFor: DriveNamesResolver
): NotificationRows {
  const active = activeTransfers(list, now);
  // A row must never outlive the service; enforced here as well as in Kotlin.
  if (active.length === 0) {
    return { receiving: null, sharing: null, serviceRow: null };
  }

  const downloads: NotificationTransferInput[] = [];
  /** Hosted entries with a peer attached — the shares being downloaded. */
  const servingHosts: NotificationTransferInput[] = [];
  for (const { index, reason } of active) {
    const transfer = list[index];
    if (!transfer) continue;
    // `reason` is authoritative, not `origin`: it carries the
    // hosted-with-peers and grace-window branches.
    if (reason === "download") downloads.push(transfer);
    else if (reason === "upload") servingHosts.push(transfer);
  }

  const receiving = downloads.length > 0
    ? buildReceivingRow(downloads, namesFor)
    : null;
  const sharing = buildSharingRow(list, servingHosts, namesFor);

  // Receiving owns the service row while a download runs: it has the bar and
  // the Cancel the user may need.
  const serviceRow: ServiceRowId | null = receiving
    ? "receiving"
    : sharing
      ? "sharing"
      : null;

  return { receiving, sharing, serviceRow };
}

function buildReceivingRow(
  downloads: readonly NotificationTransferInput[],
  namesFor: DriveNamesResolver
): NotificationRow {
  const names: string[] = [];
  for (const t of downloads) {
    for (const n of namesFor(t.driveId)) {
      if (typeof n === "string" && n.trim()) names.push(n.trim());
    }
  }

  // Counts files from the same list the text renders, so the two cannot
  // disagree; with no names it falls back to transfers, which understates.
  const fileCount = names.length > 0 ? names.length : downloads.length;
  const title = `Receiving ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const text = names.length > 0 ? joinNames(names) : "Connecting…";

  // Sum only when every download knows its total: a partial sum is
  // confidently wrong, which is worse than a sweeping bar.
  let sumBytes = 0;
  let sumTotal = 0;
  let totalsComplete = true;
  for (const t of downloads) {
    sumBytes += finiteOrNull(t.bytesTransferred) ?? 0;
    const total = positiveOrNull(t.totalBytes) ?? positiveOrNull(t.driveSize);
    if (total === null) totalsComplete = false;
    else sumTotal += total;
  }

  if (totalsComplete && sumTotal > 0) {
    return {
      title,
      text,
      subline: `${formatNotificationBytes(sumBytes)} of ${formatNotificationBytes(sumTotal)}`,
      percent: Math.max(0, Math.min(100, Math.round((sumBytes / sumTotal) * 100))),
    };
  }
  return {
    title,
    text,
    subline: `${formatNotificationBytes(sumBytes)} received`,
    percent: PROGRESS_INDETERMINATE,
  };
}

/** Null rather than a row about shares a receive-only user does not have. The
 * count sums `peersConnected`, so one device taking two shares reads as two. */
function buildSharingRow(
  list: readonly NotificationTransferInput[],
  servingHosts: readonly NotificationTransferInput[],
  namesFor: DriveNamesResolver
): NotificationRow | null {
  const hosted = list.filter(
    (t) => t.origin === "hosted" || t.origin === "unknown"
  );
  if (hosted.length === 0) return null;

  let peers = 0;
  for (const t of servingHosts) {
    peers += Math.max(0, finiteOrNull(t.peersConnected) ?? 0);
  }

  if (peers === 0) {
    return {
      title: "Shares are ready to download",
      text: "No requests yet…",
      subline: "",
      percent: PROGRESS_NONE,
    };
  }

  const names: string[] = [];
  for (const t of servingHosts) {
    for (const n of namesFor(t.driveId)) {
      if (typeof n === "string" && n.trim()) names.push(n.trim());
    }
  }
  return {
    title: `${peers} ${peers === 1 ? "pear is" : "pears are"} receiving from you`,
    text: names.length > 0 ? joinNames(names) : "A share is being downloaded",
    subline: "",
    percent: PROGRESS_NONE,
  };
}

/** What was last handed to the service for one row, for the throttle. */
export type LastRowPost = { at: number; row: NotificationRow };

/** Per row, or the two interfere: an unchanged Sharing row would re-post on
 * every Receiving tick. Threshold and vocabulary from `notificationProgress.ts`. */
export function classifyRowPost(
  last: LastRowPost | null,
  next: NotificationRow,
  now: number
): NotificationPostDecision {
  if (last === null) return "posted";
  if (
    last.row.title === next.title &&
    last.row.text === next.text &&
    last.row.subline === next.subline &&
    last.row.percent === next.percent
  ) {
    return "suppressed-identical";
  }
  const elapsed = now - last.at;
  // A non-finite or backwards elapsed means the clock moved; posting beats
  // wedging the row at a stale value.
  if (!Number.isFinite(elapsed) || elapsed < 0) return "posted";
  return elapsed >= NOTIFICATION_UPDATE_INTERVAL_MS ? "posted" : "suppressed-rate";
}

/** Downloads only, excluded here rather than at the call site so "cancel
 * receiving never reaches the hosting stop path" is testable. */
export function selectReceivingCancelTargets(
  list: readonly NotificationTransferInput[],
  now: number
): string[] {
  const out: string[] = [];
  for (const { index, reason } of activeTransfers(list, now)) {
    if (reason !== "download") continue;
    const driveId = list[index]?.driveId;
    if (typeof driveId === "string" && driveId) out.push(driveId);
  }
  return out;
}
