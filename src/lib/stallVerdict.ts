/** Whether a stall verdict is still true at the moment it would be applied. */

import {
  bytesAdvanced,
  type BytesAdvanceEvent,
  type BytesAdvancePrev,
} from "./bytesAdvance";

/** The stall-related fields a progress event leaves on a row. */
export type StallFields = {
  readonly engineStalled: boolean | undefined;
  readonly engineSilenceMs: number | null | undefined;
  readonly lastBytesAt: number | null;
};

type StallPrev = BytesAdvancePrev & {
  readonly engineStalled?: boolean;
  readonly engineSilenceMs?: number | null;
};

/** Moving bytes end the silence, so they clear the engine's verdict as well as stamping the
 *  clock. Gated on an advance: the engine re-emits progress every second on a dead peer too. */
export function stallFieldsAfterProgress(
  event: BytesAdvanceEvent | null | undefined,
  prev: StallPrev | null | undefined,
  now: number = Date.now()
): StallFields {
  if (!bytesAdvanced(event, prev)) {
    return {
      engineStalled: prev?.engineStalled,
      engineSilenceMs: prev?.engineSilenceMs,
      lastBytesAt: prev?.lastBytesAt ?? null,
    };
  }
  return { engineStalled: false, engineSilenceMs: 0, lastBytesAt: now };
}

export type StallVerdictCheck = {
  /** Whether the engine's silence flag is what decided this verdict, rather than the peer-loss
   *  rule. Only the first is invalidated by that flag clearing; the second has its own basis. */
  readonly decidedOnEngineStall: boolean;
  /** The row's last-byte stamp in the snapshot the verdict was decided from. */
  readonly decidedLastBytesAt: number | null | undefined;
  /** The same row's stamp, read again now. */
  readonly currentLastBytesAt: number | null | undefined;
  /** Whether the engine's silence verdict still stands for this row. */
  readonly currentEngineStalled: boolean | null | undefined;
  /** False when the row has gone from the list entirely, which is not a stall to apply. */
  readonly rowStillPresent: boolean;
};

function stamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether the row's byte clock moved between the two readings. */
function bytesMovedSince(
  decidedLastBytesAt: number | null | undefined,
  currentLastBytesAt: number | null | undefined
): boolean {
  const decided = stamp(decidedLastBytesAt);
  const current = stamp(currentLastBytesAt);
  if (current === null) return false;
  // A row that had never moved a byte and now has one: that is an advance too.
  if (decided === null) return true;
  return current > decided;
}

/** False means drop the verdict: no transition, no retry. A verdict is decided from a silence
 *  window and applied an `await` later, and bytes returning in that gap flapped the row. */
export function stallVerdictStillHolds(check: StallVerdictCheck): boolean {
  if (!check.rowStillPresent) return false;
  // Bytes in the gap end the silence, whichever rule decided the verdict.
  if (bytesMovedSince(check.decidedLastBytesAt, check.currentLastBytesAt)) return false;
  // The engine resumed or a progress event cleared the flag, so the reason this verdict
  // existed is gone. The peer-loss rule never consulted the flag and is left alone.
  if (check.decidedOnEngineStall && check.currentEngineStalled !== true) return false;
  return true;
}
