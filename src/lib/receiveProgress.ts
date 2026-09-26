/**
 * Pure logic for rendering a received share's transfer state.
 *
 * Received rows are keyed `share:<shareKey>`, not by driveId, so progress
 * needs a shareKey → driveId index. It is built from `engineListDrives()`
 * and from the live resolve session, and the live session wins: an
 * in-flight grab is not in the drive list yet, and that is the only window
 * in which progress matters.
 *
 * No react-native imports — jest runs this under `testEnvironment: "node"`.
 */

/** Minimal shape read off a `DriveRecord`; avoids importing state/types. */
export type DriveKeyRecord = {
  id: string;
  key?: string;
  origin?: string;
};

/** Minimal shape read off a `TransferSummary`. */
export type ReceiveTransferLike = {
  percent: number | null;
  completed: boolean;
  stalled: boolean;
  progressEverReceived: boolean;
  /**
   * REQUIRED, not optional, and that is the point.
   *
   * `markCancelled` writes `completed: true` and `cancelled: true` into the
   * SAME object, so a status deriver that cannot see `cancelled` reports a
   * transfer the user stopped as "Saved". This type was the reason it could
   * not see it: the field existed on `TransferSummary` and was discarded at
   * the boundary. Making it optional would let a future caller reintroduce
   * exactly that by omission, which is the defect, not a variant of it.
   */
  cancelled: boolean;
  /**
   * How many files were already on disk when the cancel
   * landed. Optional and nullable, deliberately:
   *
   *  - `null` / absent → the count is NOT KNOWN. The engine sends `filesKept`
   *    on `transfer-cancelled`, but a cancel settled locally (the
   *    `alreadyInactive` reply in `cancelInFlight`) never had a count to
   *    send. The row then says plain "Stopped" rather than claiming zero.
   *  - a number → that many files survived; the row names it.
   *
   * Defaulting a missing count to 0 would turn "we don't know" into
   * "nothing saved", which is a claim the app did not observe.
   */
  filesKept?: number | null;
  /**
   * How a receive ended. Optional, unlike `cancelled` above: `downloadOutcome`
   * is written only on the receive path, so it is `undefined` on every hosted
   * transfer and on every received one still in flight. Absence means not
   * known; gate on this being present, never default it.
   */
  downloadOutcome?: {
    outcome: "complete" | "partial" | "failed";
    /** Files written to disk. */
    kept: number;
    /** Files that were asked for and did not arrive. */
    failed: number;
  };
};

/**
 * Build the shareKey → driveId index.
 *
 * Keys are lower-cased on both sides. `extractKey` already lower-cases
 * what it returns and `parseShareLink` lower-cases in the engine, but the
 * manifest is long-lived storage written by several sprints' worth of
 * code, so normalizing here costs nothing and removes a class of silent
 * miss that would look exactly like "no progress again".
 *
 * `liveDriveId` / `liveShareKey` are applied LAST so the in-flight
 * session overwrites any stale entry for the same share key — see the
 * header note on precedence.
 */
export function buildShareKeyDriveIndex(
  drives: readonly DriveKeyRecord[] | null | undefined,
  live?: { shareKey: string | null; driveId: string | null },
): Map<string, string> {
  const index = new Map<string, string>();

  for (const d of drives ?? []) {
    if (!d || d.origin !== "received") continue;
    if (!d.id || !d.key) continue;
    index.set(String(d.key).toLowerCase(), d.id);
  }

  const liveKey = live?.shareKey ? String(live.shareKey).toLowerCase() : null;
  if (liveKey && live?.driveId) index.set(liveKey, live.driveId);

  return index;
}

/**
 * Resolve the transfer belonging to a received row.
 *
 * `shareKey` is the row's share key (a received row's `key` field), NOT
 * its synthetic `share:<key>` id.
 */
export function resolveReceivedTransfer<T>(
  shareKey: string | null | undefined,
  index: ReadonlyMap<string, string>,
  transferByDriveId: ReadonlyMap<string, T>,
): T | undefined {
  if (!shareKey) return undefined;
  const driveId = index.get(String(shareKey).toLowerCase());
  if (!driveId) return undefined;
  return transferByDriveId.get(driveId);
}

export type ReceiveRowState =
  | "idle"
  | "starting"
  | "receiving"
  | "finishing"
  | "stalled"
  | "cancelled"
  // Two terminal states that are not "saved". Both consumers of `.state`
  // compare it against `"idle"` only, so adding members leaves no gap.
  | "partial"
  | "failed"
  | "saved";

export type ReceiveRowStatus = {
  state: ReceiveRowState;
  /** Rendered after the `<Type> · ` prefix the row already builds. */
  label: string;
  tone: "warning" | "primary" | "danger" | "muted";
};

/**
 * Map a received transfer onto a row status. `percent >= 100 && !completed`
 * is reachable — the byte counter hits 100 when the last block lands, while
 * `completed` waits for the `upload-complete` event after the files reach
 * disk — so it gets its own label and only `completed` is terminal.
 */
export function receiveRowStatus(
  transfer: ReceiveTransferLike | null | undefined,
): ReceiveRowStatus {
  if (!transfer) return { state: "idle", label: "", tone: "muted" };

  // ABOVE `completed`, and the order is the whole fix.
  //
  // `markCancelled` (src/state/backend.ts) sets `completed: true` AND
  // `cancelled: true` in one object literal — `completed` because every
  // "this transfer is over" reader consults it (the activity predicate that
  // releases the foreground service among them, which is why it must not be
  // dropped). So a `cancelled` clause placed after the `completed` clause is
  // unreachable code that looks like a fix. It goes here.
  if (transfer.cancelled) {
    return {
      state: "cancelled",
      label: cancelledRowLabel(transfer.filesKept),
      // `muted`, not `danger` — the same reasoning already written into
      // `grabCompletionMessage` below: the user asked for this, so there is
      // nothing to celebrate and nothing to apologise for. A red row
      // apologises for obeying an instruction.
      tone: "muted",
    };
  }

  // Above `completed`, which the `download-outcome` handler sets on all three
  // outcomes; below `cancelled`, which is stopped by intent, not broken.
  if (transfer.downloadOutcome && transfer.downloadOutcome.outcome !== "complete") {
    return downloadOutcomeRowStatus(transfer.downloadOutcome);
  }

  if (transfer.completed) {
    return { state: "saved", label: "Saved", tone: "primary" };
  }

  if (transfer.stalled) {
    return { state: "stalled", label: "Stopped — tap to retry", tone: "danger" };
  }

  const pct = clampReceivePercent(transfer.percent);

  if (pct >= 100) {
    return { state: "finishing", label: "Finishing…", tone: "warning" };
  }

  if (pct > 0 || transfer.progressEverReceived) {
    return { state: "receiving", label: `Receiving (${pct}%)`, tone: "warning" };
  }

  return { state: "starting", label: "Starting…", tone: "warning" };
}

/**
 * Clamp a transfer percent to 0..100.
 *
 * `Number.isFinite` rather than `typeof === "number"`: `NaN` is a number,
 * and a `NaN` percent would slip past every comparison below (`NaN >= 100`
 * and `NaN > 0` are both false) and silently render "Starting…" forever —
 * the same shape of bug as the `NaN` freeze verdict in `aliveTicks.ts`.
 * Validate where the value enters, not where it is interpreted.
 */
export function clampReceivePercent(percent: number | null | undefined): number {
  if (!Number.isFinite(percent as number)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent as number)));
}

/**
 * Wording for the post-grab completion toast.
 *
 * Separate from the row status because it answers a different question:
 * the row says what state the share is in, this says what just happened
 * and — critically — whether anything was left behind. `engineDownload`
 * continues past a per-file failure and returns the survivors in `files`
 * with the casualties in `failed`, so `ok: true` does NOT mean "you have
 * the whole share". The original report was "I couldn't tell if I had the
 * full file"; reporting a partial grab as an unqualified success is the
 * same defect wearing a different hat.
 */
export function grabCompletionMessage(counts: {
  saved: number;
  failed: number;
  /**
   * the user pressed Cancel part-way. Takes precedence over the
   * failed/saved split below, because "3 of 10 — 7 didn't make it" describes
   * a broken transfer, and this one was not broken.
   */
  cancelled?: boolean;
}): { text: string; kind: "success" | "error" | "info" } {
  const { saved, failed, cancelled } = counts;

  // Files that finished before the cancel are real files on disk, so they are
  // named. `failed` is not: the rest were never attempted.
  if (cancelled) {
    if (saved === 0) return { text: "Stopped — nothing saved.", kind: "info" };
    return {
      text: saved === 1 ? "Stopped — 1 file saved." : `Stopped — ${saved} files saved.`,
      kind: "info",
    };
  }

  if (failed > 0 && saved === 0) {
    return {
      text: failed === 1 ? "Couldn't grab that file." : `Couldn't grab ${failed} files.`,
      kind: "error",
    };
  }

  if (failed > 0) {
    return {
      text: `Saved ${saved} of ${saved + failed} — ${failed} didn't make it.`,
      kind: "error",
    };
  }

  return {
    text: saved === 1 ? "Got it — 1 file saved." : `Got it — ${saved} files saved.`,
    kind: "success",
  };
}

/**
 * The row's wording for "the user stopped this one". Derived from
 * `grabCompletionMessage` so the row and the toast cannot drift apart; the
 * trailing full stop is dropped because a row label is a fragment. An
 * unknown count is not coerced to zero, which would be a claim.
 */
export function cancelledRowLabel(filesKept?: number | null): string {
  if (typeof filesKept !== "number" || !Number.isFinite(filesKept) || filesKept < 0) {
    return "Stopped";
  }
  const saved = Math.round(filesKept);
  return grabCompletionMessage({ saved, failed: 0, cancelled: true }).text.replace(
    /\.$/,
    "",
  );
}

/**
 * The row's wording for a grab that did not come back whole. Derived from
 * `grabCompletionMessage` so row and toast cannot drift. `failed` is `danger`
 * and `partial` is `warning`, matching the haptic split. Counts are guarded,
 * not defaulted: a `failed` outcome carrying no counts is reachable.
 */
function downloadOutcomeRowStatus(outcome: {
  outcome: "complete" | "partial" | "failed";
  kept: number;
  failed: number;
}): ReceiveRowStatus {
  const kept = usableCount(outcome.kept);
  const failed = usableCount(outcome.failed);

  // `kept <= 0` is routed here whatever the grading says: a "partial" grab
  // that kept nothing is a failed grab wearing the wrong label, and the row
  // answers to what is on disk.
  if (outcome.outcome === "failed" || kept <= 0) {
    return {
      state: "failed",
      label:
        failed > 0
          ? stripRowStop(grabCompletionMessage({ saved: 0, failed }).text)
          : // No casualty count to name. This is the notification half's
            // "Nothing was saved" (src/state/backend.ts:1689) as a fragment.
            "Nothing saved",
      tone: "danger",
    };
  }

  return {
    state: "partial",
    label:
      failed > 0
        ? stripRowStop(grabCompletionMessage({ saved: kept, failed }).text)
        : // Files landed and the engine says some did not, but it did not say
          // how many. "Saved 2 of 2" would be a split the app never observed.
          "Some files didn't arrive",
    tone: "warning",
  };
}

/** A count is usable only if it is a finite, non-negative number; 0 means "cannot name it". */
function usableCount(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** A row label is a fragment, not a sentence — the toast's words, the row's punctuation. */
function stripRowStop(text: string): string {
  return text.replace(/\.$/, "");
}
