/**
 * What one background window may write. Only windows spanning at least ten expected ticks are
 * graded — below that, one missed tick is half the window and frozen is an artefact of resolution.
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
  /** Requires both that the window was called frozen and that it was gradeable: an ungraded
   *  window is unknown, neither fine nor frozen. */
  recordFreeze: boolean;
};

/**
 * The null in `workletGapMs` is load-bearing: it means no gap was measured. Do not coerce it to 0
 * on the way in — that turns an absent measurement into a clean one.
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
