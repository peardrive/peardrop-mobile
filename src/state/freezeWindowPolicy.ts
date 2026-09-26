/**
 * What one background window is allowed to write. A module rather than four
 * lines in the caller because the caller imports react-native and is
 * unreachable from jest, so the rule governing what gets persisted about a
 * freeze would have no test. Pure: it persists nothing, reads no platform
 * API, and the single caller does the writing. Only windows spanning at
 * least ten expected ticks are graded, and a shorter one never counts —
 * below that, one missed tick is half the window and frozen is an artefact
 * of the resolution rather than a measurement.
 */
import {
  classifyWindow,
  type FreezeGrade,
  type UngradedReason,
} from "../lib/freezeGrade";
import type { FreezeVerdict } from "../lib/freezeDetect";

export type FreezeWindowDecision = {
  /** The grade, or null when the window is ungraded. */
  grade: FreezeGrade | null;
  /** Why it was not graded. Null when it was. */
  ungradedReason: UngradedReason | null;
  /**
   * Whether this window may be written to the persisted freeze history.
   * Requires both that it was called frozen and that it was gradeable at
   * all: an ungraded window is unknown, neither fine nor frozen.
   */
  recordFreeze: boolean;
};

/**
 * The null in `workletGapMs` is load-bearing: it means no gap measurement
 * was taken, which `classifyWindow` answers with an ungraded window. Do not
 * coerce it to 0 on the way in — that turns an absent measurement into a
 * clean one.
 */
export function decideFreezeWindow(
  verdict: FreezeVerdict,
  workletGapMs: number | null,
  tickIntervalMs: number
): FreezeWindowDecision {
  const classification = classifyWindow(verdict, workletGapMs, tickIntervalMs);
  const graded = classification.outcome === "graded";
  return {
    grade: classification.grade,
    ungradedReason:
      classification.outcome === "ungraded" ? classification.reason : null,
    recordFreeze: verdict.frozen && graded,
  };
}
