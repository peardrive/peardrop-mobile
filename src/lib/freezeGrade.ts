/**
 * a third grade between "ran normally" and "frozen".
 *
 * Deliberately a separate module from `freezeDetect.ts`. `evaluateFreeze` is
 * on this sprint's do-not-touch list, and six sessions of logs are readable
 * against its frozen/not-frozen vocabulary; nothing here alters it. This
 * module CONSUMES its verdict and adds a grade beside it.
 *
 * ## Why a boolean was not enough
 *
 * `evaluateFreeze` sees two tick counts and a duration. It cannot tell a
 * window that ticked steadily from one that stalled for two minutes and then
 * caught up, and its 0.5 threshold passed a run with a 115-second stall and
 * a completion 49 seconds late. Every Samsung run in the 2026-09-13 series
 * came back `ran-normally`, and three of them were nowhere near clean.
 *
 * ## The two clauses, and why both
 *
 * Ratio alone puts an 11/19 run (0.579) and the S21 FE (0.576) in the same
 * bucket despite very different shapes. The gap clause is what catches the
 * 115-second stall, which scores respectably on ratio alone. A window has to
 * pass BOTH to be called healthy.
 */

import type { FreezeVerdict } from "./freezeDetect";

/**
 * Observed/expected tick ratio at or above which a window may be healthy.
 *
 * CALIBRATED, NOT CHOSEN. Seven observed runs (2026-09-13 and the
 * battery-unrestricted control) fall into two groups with an empty band
 * between them:
 *
 *   healthy side    1.002, 0.997          (Redmi clean, Redmi re-run)
 *   ---- empty from 0.753 to 0.997 ----
 *   degraded side   0.753, 0.579, 0.576, 0.167
 *
 * 0.90 sits inside that gap with room on both sides, so ordinary scheduler
 * jitter cannot push a clean run across it and no observed bad run comes
 * close to reaching it.
 */
export const HEALTHY_MIN_RATIO = 0.9;

/**
 * Largest tolerated heartbeat gap, as a multiple of the tick interval.
 *
 * Three intervals allows one missed tick plus jitter. The two clean Redmi
 * runs peaked at 2.0 s against a 2 s cadence — one interval. The worst run
 * that still passed on ratio alone peaked at 7.2 s, and the run this clause
 * exists to catch peaked at 115 s.
 */
export const HEALTHY_MAX_GAP_TICKS = 3;

export type FreezeGrade = "healthy" | "degraded" | "frozen";

/** Weight a graded window contributes to the service-freeze streak. */
export const GRADE_WEIGHT: Record<FreezeGrade, number> = {
  // A device that froze outright. Three of these trip the fallback.
  frozen: 1,
  // Half-credit: the mechanism half-worked. Six of these trip it, which is
  // a materially higher bar than three outright freezes, as it should be.
  // 0.5 and 1 are both exactly representable, so the sum reaches 3 exactly
  // and no epsilon comparison is needed.
  degraded: 0.5,
  // Positive evidence the mechanism worked. Resets rather than accumulates.
  healthy: 0,
};

/**
 * Grade a window, or null when it cannot be graded.
 *
 * Null for `too-short`, `insufficient-signal` and `invalid-input`: those
 * prove nothing in either direction, and must neither add to a streak nor
 * clear one.
 *
 * `frozen` is taken from `evaluateFreeze` rather than re-derived from the
 * ratio, so the two can never disagree about the same window.
 */
export function gradeWindow(
  verdict: FreezeVerdict,
  largestGapMs: number,
  tickIntervalMs: number
): FreezeGrade | null {
  if (verdict.reason === "too-short") return null;
  if (verdict.reason === "insufficient-signal") return null;
  if (verdict.reason === "invalid-input") return null;

  if (verdict.frozen) return "frozen";

  const ratio =
    verdict.expectedTicks > 0
      ? verdict.observedTicks / verdict.expectedTicks
      : 0;
  const gapBudgetMs = tickIntervalMs * HEALTHY_MAX_GAP_TICKS;

  const ratioOk = ratio >= HEALTHY_MIN_RATIO;
  // A non-positive interval means the cadence is unknown; fall back to the
  // ratio alone rather than failing every window on an unusable budget.
  const gapOk = tickIntervalMs <= 0 || largestGapMs <= gapBudgetMs;

  return ratioOk && gapOk ? "healthy" : "degraded";
}

/** Observed/expected, or null when there is no denominator. */
export function tickRatio(verdict: FreezeVerdict): number | null {
  if (verdict.expectedTicks <= 0) return null;
  return verdict.observedTicks / verdict.expectedTicks;
}
