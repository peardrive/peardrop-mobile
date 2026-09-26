/**
 * what the ongoing foreground-service notification says.
 *
 * ## Why this file exists
 *
 * shipped the native half (`TransferService.updateNotification`),
 * the bridge (`TransferServiceModule.update`) and the JS wrapper
 * (`updateServiceProgress`) — and wired nothing to any of them:
 * `updateServiceProgress` had zero callers in `src/` and `app/`,
 * so `currentTitle` / `currentText` / `currentPercent` sat at their
 * compile-time defaults ("PearDrop" / "Transferring…" / -1) for the whole
 * life of every transfer. `percent = -1` takes the indeterminate branch of
 * `buildNotification`, which is why the field report read as "a bar and
 * nothing else": the bar was the indeterminate sweep, not progress.
 *
 * This module is the missing content layer. It is pure and imports no
 * react-native, so jest can run it under `testEnvironment: "node"` — the same
 * split as `transferActivity.ts` and `settingsLadder.ts`. The side-effecting
 * half (deciding when to call the bridge) lives in `src/state/backend.ts`,
 * which is where the engine events already land.
 *
 * ## It describes exactly the set the service is held for
 *
 * `activeTransfers` from `transferActivity.ts` is THE predicate, and this
 * calls it rather than re-deriving "in flight". If the two drifted, the
 * notification would describe a different transfer from the one keeping the
 * process alive — which is precisely the class of bug that module's header
 * warns about. `transferActivity.ts` is not modified here; it is imported.
 */

import { formatBytes } from "./format";
import { activeTransfers, type TransferActivityInput } from "./transferActivity";

/**
 * How often the ongoing notification may be re-posted, in ms.
 *
 * **Do not lower this.** It is not a latency budget, it is a rate limit with
 * three separate reasons behind the number:
 *
 * 1. **Android drops updates above its enqueue rate.** `NotificationManager`
 *    rate-limits per package (AOSP's `MAX_NOTIFICATION_ENQUEUE_RATE`, single
 *    digits per second). Posting faster does not produce a smoother bar; it
 *    produces dropped posts and a bar that appears to stutter.
 * 2. **Every post is a binder round-trip into system_server.** This runs while
 *    the app is backgrounded and the process is otherwise close to idle — the
 *    exact condition the foreground service exists to survive. Spending wakeups
 *    on redraws nobody is looking at is how a transfer notification turns into
 *    a battery complaint.
 * 3. **The engine is far faster than a human eye.** Download progress is
 *    already coalesced at 100 ms upstream, i.e. 10 posts/second. A progress bar
 *    that advances once a second reads as live; ten times a second reads
 *    identically and costs ten times as much.
 *
 * 1000 ms also sits at the same order as the debug-log flush (1 s) and below
 * the worklet heartbeat (2 s), so the notification can never be the fastest
 * recurring thing in a backgrounded process.
 */
export const NOTIFICATION_UPDATE_INTERVAL_MS = 1000;

/**
 * The minimum a transfer must expose to be described.
 *
 * A structural subset rather than `TransferSummary` itself, for the same
 * reason `TransferActivityInput` is one: this module must not import from
 * `src/state/types.ts`, and a narrow input keeps the test fixtures honest
 * about what is actually read. `TransferSummary` satisfies it structurally.
 */
export type NotificationTransferInput = TransferActivityInput & {
  driveId: string;
  percent: number | null;
  bytesTransferred: number;
  totalBytes: number | null;
  /** Fallback denominator: `totalBytes` is not always populated for a host. */
  driveSize: number | null;
};

/** What the service should display. `percent < 0` means indeterminate. */
export type NotificationContent = {
  title: string;
  text: string;
  percent: number;
  /**
   * the label on the notification's Cancel action.
   *
   * There is exactly ONE notification — `NOTIFICATION_ID = 4711`, the single
   * id a foreground service may own — and `describeTransferNotification`
   * already collapses several transfers into "Receiving 3 shares". It carries
   * no driveId, so the action cannot target one transfer, and a button
   * labelled "Cancel" that silently stops three transfers is a trap.
   *
   * So the label states the scope: "Cancel" when exactly one transfer is
   * active, "Cancel all" when more than one. Derived from the same `picked`
   * set that produces the title, so the two can never disagree about how many
   * transfers are in play.
   */
  cancelLabel: string;
};

/**
 * Resolve a human name for a drive. Returns null/undefined when unknown.
 *
 * **Expected to miss for a received transfer in flight.** The drives list is
 * populated from `RPC_DRIVES_LIST`, and for a receive that manifest does not
 * carry the drive until the transfer ends. So the name resolves for uploads
 * and misses for exactly the downloads
 * the notification matters most for. That is why every branch below degrades
 * to a title that still reads correctly without a name, rather than treating
 * the name as required.
 */
export type DriveNameResolver = (driveId: string) => string | null | undefined;

/** Finite-or-null. `NaN` is a `number`, and this is where that stops. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A percentage we are willing to render, or null.
 *
 * Validated here, at the boundary where engine numbers enter this module,
 * rather than at the point of interpretation — `measurement.md`'s standing
 * lesson, learned from a `NaN` that passed a `>= 0.5` check and was reported
 * as a clean run.
 */
function usablePercent(value: unknown): number | null {
  const n = finiteOrNull(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function positiveOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * Build the notification content for the current transfer set, or null when
 * nothing is active and the caller should not post at all.
 *
 * The title is never empty: the direction verb alone is always a valid title,
 * and the name is strictly an upgrade on top of it.
 */
export function describeTransferNotification(
  list: readonly NotificationTransferInput[],
  now: number,
  nameFor: DriveNameResolver
): NotificationContent | null {
  const active = activeTransfers(list, now);
  if (active.length === 0) return null;

  const picked: { transfer: NotificationTransferInput; receiving: boolean }[] = [];
  for (const { index, reason } of active) {
    const transfer = list[index];
    if (!transfer) continue;
    picked.push({
      transfer,
      // `reason` is the authoritative direction, not `origin`: it is what
      // `classifyTransfer` concluded, including the hosted-with-peers and
      // grace-window branches that `origin` alone cannot distinguish.
      receiving: reason === "download",
    });
  }
  if (picked.length === 0) return null;

  /** Set only for a lone transfer — the one case that can carry a name. */
  const only = picked.length === 1 ? picked[0] : undefined;
  const receivingCount = picked.filter((p) => p.receiving).length;
  const verb =
    receivingCount === picked.length
      ? "Receiving"
      : receivingCount === 0
        ? "Sending"
        : "Transferring";

  let title: string;
  if (only) {
    const name = nameFor(only.transfer.driveId);
    const trimmed = typeof name === "string" ? name.trim() : "";
    title = trimmed ? `${verb} ${trimmed}` : verb;
  } else {
    title = `${verb} ${picked.length} shares`;
  }

  // Aggregate bytes only when EVERY active transfer knows its total — a sum
  // over a partially-known set produces a percentage that is confidently
  // wrong, which is worse than an honest indeterminate bar.
  let sumBytes = 0;
  let sumTotal = 0;
  let totalsComplete = true;
  for (const { transfer } of picked) {
    sumBytes += finiteOrNull(transfer.bytesTransferred) ?? 0;
    const total =
      positiveOrNull(transfer.totalBytes) ?? positiveOrNull(transfer.driveSize);
    if (total === null) totalsComplete = false;
    else sumTotal += total;
  }

  let percent = -1;
  if (totalsComplete && sumTotal > 0) {
    percent = Math.max(0, Math.min(100, Math.round((sumBytes / sumTotal) * 100)));
  } else if (only) {
    // Fall back to the engine's own figure for a single transfer. It is known
    // to clamp at 99 and to sit at 0 through a fast transfer, so it is used
    // only when byte totals cannot answer the question.
    percent = usablePercent(only.transfer.percent) ?? -1;
  }

  const parts: string[] = [];
  if (percent >= 0) parts.push(`${percent}%`);
  if (totalsComplete && sumTotal > 0) {
    parts.push(`${formatBytes(sumBytes)} of ${formatBytes(sumTotal)}`);
  } else if (sumBytes > 0) {
    parts.push(`${formatBytes(sumBytes)} so far`);
  }
  // Never an empty content line: a notification with a title and a blank body
  // is the shape of the bug this sprint is fixing.
  const text = parts.length > 0 ? parts.join(" · ") : "Connecting…";

  // scope stated in the label, from the same set as the title.
  const cancelLabel = picked.length > 1 ? "Cancel all" : "Cancel";

  return { title, text, percent, cancelLabel };
}

/** What was last handed to the service, for the throttle to compare against. */
export type LastPost = { at: number; content: NotificationContent };

/**
 * why a post happened, or did not.
 *
 * `shouldPostNotification` answers `true`/`false`, and that is all the caller
 * needs — but it is not all the log needs. A log line has to distinguish
 * "suppressed identical content" from "suppressed because the last post was
 * 100 ms ago". Those are different facts about the notification, and `false`
 * collapses them.
 */
export type NotificationPostDecision =
  | "posted"
  | "suppressed-identical"
  | "suppressed-rate";

/**
 * Classify a post decision.
 *
 * This is `shouldPostNotification`'s body, unchanged, with each `return`
 * labelled. The suppression logic itself is explicitly out of scope for
 * and is not altered — the branches, their order, the fields
 * compared, the `NaN`/backwards-clock direction and the threshold comparison are
 * all identical. `shouldPostNotification` now delegates here rather than holding
 * a second copy, because two copies of this decision drifting apart is exactly
 * the failure mode that would make the new log line lie.
 * `notificationPostClassify.test.ts` asserts they agree across the whole cross
 * product.
 */
export function classifyNotificationPost(
  last: LastPost | null,
  next: NotificationContent,
  now: number
): NotificationPostDecision {
  if (last === null) return "posted";
  if (
    last.content.title === next.title &&
    last.content.text === next.text &&
    last.content.percent === next.percent &&
    // the label is part of the content. A second transfer starting
    // flips "Cancel" to "Cancel all" without necessarily changing the title
    // or the byte totals in the same tick, and a button whose label lags the
    // action it performs is the trap this label exists to avoid.
    last.content.cancelLabel === next.cancelLabel
  ) {
    return "suppressed-identical";
  }
  const elapsed = now - last.at;
  // A non-finite or backwards elapsed time means the clock moved under us.
  // Posting is the safe direction: the alternative wedges the notification
  // at a stale value until the next reboot.
  if (!Number.isFinite(elapsed) || elapsed < 0) return "posted";
  return elapsed >= NOTIFICATION_UPDATE_INTERVAL_MS ? "posted" : "suppressed-rate";
}

/**
 * Whether to re-post now.
 *
 * Two independent suppressions, and both matter. Identical content is dropped
 * however long it has been — a stalled transfer must not burn a wakeup per
 * second to redraw the same pixels. Changed content is still held to
 * `NOTIFICATION_UPDATE_INTERVAL_MS`, which is what keeps the engine's 100 ms
 * cadence from reaching `NotificationManager`.
 */
export function shouldPostNotification(
  last: LastPost | null,
  next: NotificationContent,
  now: number
): boolean {
  return classifyNotificationPost(last, next, now) === "posted";
}
