/**
 * A third grade between "ran normally" and "frozen". Separate from
 * `freezeDetect.ts`: this module consumes `evaluateFreeze`'s verdict and adds
 * a grade beside it, never altering the frozen/not-frozen vocabulary the logs
 * are read against. There is no ratio-only path here — a window with no usable
 * cadence, or no gap measurement, is `ungraded`. The ratio separates
 * `healthy` from `degraded` only once a window has passed the gap test.
 */

import type { FreezeVerdict } from "./freezeDetect";

/**
 * Observed/expected tick ratio at or above which a graded window is healthy.
 * Calibrated, not chosen: observed runs fall into two groups with an empty
 * band between them, and 0.90 sits inside it with room on both sides — do not
 * round it. It only picks `healthy` from `degraded`, and never decides
 * `frozen`.
 */
export const HEALTHY_MIN_RATIO = 0.9;

/**
 * Largest tolerated tick gap, as a multiple of the tick interval that the gap
 * was measured against. Three intervals allows one missed tick plus jitter;
 * exceeding it is the frozen test. The interval must be the cadence the gap
 * was measured against — `BridgeStatus.aliveTickMs`, the same clock the engine
 * stamps `tickGaps` with — or a gap meets an allowance from another clock.
 */
export const HEALTHY_MAX_GAP_TICKS = 3;

/**
 * A window must span at least this many expected ticks before any grade is
 * produced; ten ticks is five minutes at the 30 s cadence. Below that, at
 * `expectedTicks = 2` one missed tick is 50% and clears `evaluateFreeze`'s
 * threshold, so the band is arithmetically incapable of telling a freeze from
 * a tick landing on the wrong side of the window boundary.
 */
export const MIN_GRADED_EXPECTED_TICKS = 10;

export type FreezeGrade = "healthy" | "degraded" | "frozen";

/**
 * Why a window produced no grade at all.
 *
 * Every one of these is "we do not know", never "it was fine" and never "it
 * froze". An ungraded window must neither add to the service-freeze streak nor
 * clear one, and must not reach `recordFreeze`.
 */
export type UngradedReason =
  /** `evaluateFreeze` said `too-short` — under the 60 s elapsed floor. */
  | "window-too-short"
  /** `evaluateFreeze` said `insufficient-signal` — fewer than 2 expected ticks. */
  | "insufficient-signal"
  /** `evaluateFreeze` said `invalid-input` — includes an engine restart. */
  | "invalid-input"
  /** fewer than `MIN_GRADED_EXPECTED_TICKS` expected ticks. */
  | "below-grading-floor"
  /** No usable tick cadence, so the gap budget has no denominator. */
  | "cadence-unknown"
  /**
   * No gap measurement at all, so `largestWorkletTickGapMs` returned `null`.
   * Distinct from `0`, which states that a measurement saw no gap.
   */
  | "gap-unmeasured";

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
 * The outcome of looking at one window: a grade, or a stated refusal to grade.
 * `grade` is present on both branches and is `null` on the ungraded one, so a
 * caller that only wants the grade can read `.grade` without narrowing. The
 * discriminant is a string because under `strict: false` TypeScript does not
 * narrow a union on a boolean-literal discriminant.
 */
export type WindowClassification =
  | { outcome: "graded"; grade: FreezeGrade }
  | { outcome: "ungraded"; grade: null; reason: UngradedReason };

const UNGRADED = (reason: UngradedReason): WindowClassification => ({
  outcome: "ungraded",
  grade: null,
  reason,
});

/**
 * Classify one background window. Pure; the caller persists nothing. The
 * clause order is load-bearing: the grading floor runs before
 * `verdict.frozen`, because below it a frozen verdict is an artefact of the
 * resolution; and `largestGapMs === null` is "took no measurement", which
 * must not grade as healthy-by-default the way `0` does.
 */
export function classifyWindow(
  verdict: FreezeVerdict,
  largestGapMs: number | null,
  tickIntervalMs: number
): WindowClassification {
  // ---- 1. evaluateFreeze already declined ----
  if (verdict.reason === "too-short") return UNGRADED("window-too-short");
  if (verdict.reason === "insufficient-signal") {
    return UNGRADED("insufficient-signal");
  }
  if (verdict.reason === "invalid-input") return UNGRADED("invalid-input");

  // ---- 2. The grading floor, before verdict.frozen ----
  if (
    !Number.isFinite(verdict.expectedTicks) ||
    verdict.expectedTicks < MIN_GRADED_EXPECTED_TICKS
  ) {
    return UNGRADED("below-grading-floor");
  }

  // ---- 3. A freeze the tick counter can see on its own ----
  if (verdict.frozen) return { outcome: "graded", grade: "frozen" };

  // ---- 4. The cadence. NOT a ratio fallback: a budget with no denominator
  // means the gap clause cannot run, and a ratio-only verdict is defect 2. ----
  if (!Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
    return UNGRADED("cadence-unknown");
  }

  // ---- 5. null is "not measured", which is not 0 ----
  if (largestGapMs === null) return UNGRADED("gap-unmeasured");
  if (!Number.isFinite(largestGapMs) || largestGapMs < 0) {
    return UNGRADED("gap-unmeasured");
  }

  // ---- 6. The frozen test: gap > 3 x the interval it was measured
  // against. 90,000 ms at the production 30 s tick. ----
  const gapBudgetMs = tickIntervalMs * HEALTHY_MAX_GAP_TICKS;
  if (largestGapMs > gapBudgetMs) return { outcome: "graded", grade: "frozen" };

  // ---- 7. Ratio, and only here ----
  const ratio =
    verdict.expectedTicks > 0
      ? verdict.observedTicks / verdict.expectedTicks
      : 0;
  return {
    outcome: "graded",
    grade: ratio >= HEALTHY_MIN_RATIO ? "healthy" : "degraded",
  };
}

/**
 * The grade, or `null` when the window is ungraded.
 *
 * A thin adapter over `classifyWindow` for callers that only branch on the
 * grade. `null` here IS the `ungraded` outcome, and it carries the same
 * consequence it always has at the call site: it neither adds to the
 * service-freeze streak nor clears one.
 *
 * **Second argument is `number | null`.** Pass
 * `largestWorkletTickGapMs(...)`'s result straight through — do NOT apply
 * `?? 0`, which would tell this function a missing measurement was a clean
 * one.
 */
export function gradeWindow(
  verdict: FreezeVerdict,
  largestGapMs: number | null,
  tickIntervalMs: number
): FreezeGrade | null {
  return classifyWindow(verdict, largestGapMs, tickIntervalMs).grade;
}

/** Observed/expected, or null when there is no denominator. */
export function tickRatio(verdict: FreezeVerdict): number | null {
  if (verdict.expectedTicks <= 0) return null;
  return verdict.observedTicks / verdict.expectedTicks;
}
