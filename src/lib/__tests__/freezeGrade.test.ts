// The grading boundary, pinned to the runs it was calibrated from. A boolean
// freeze test graded every recorded run `ran-normally`, including one that
// stalled for 115 s, so these tests stop that boundary drifting back. The
// budget's unit is load-bearing: one verdict below is graded twice, and if it
// passes under both units this file has gone blind. The recorded gaps come
// from a different clock than the grader's, so they are evidence for the ratio
// band only; the gap clause is tested at the production cadence.

import { evaluateFreeze, type FreezeVerdict } from "../freezeDetect";
import {
  type UngradedReason,
  GRADE_WEIGHT,
  HEALTHY_MAX_GAP_TICKS,
  HEALTHY_MIN_RATIO,
  MIN_GRADED_EXPECTED_TICKS,
  classifyWindow,
  gradeWindow,
  tickRatio,
} from "../freezeGrade";
import { EMPTY_HEALTH, withServiceWindow } from "../backgroundHealthModel";

/** The production cadence. `ALIVE_TICK_MS` in the engine, ungated. */
const PROD_TICK_MS = 30_000;
/** The cadence the RN heartbeat series was recorded at. */
const RN_HEARTBEAT_MS = 2_000;

/** Build a real verdict rather than a hand-made object. */
function windowOf(observed: number, expected: number, tickMs: number) {
  return evaluateFreeze({
    elapsedMs: expected * tickMs,
    ticksAtBackground: 0,
    ticksNow: observed,
    tickIntervalMs: tickMs,
  });
}

/**
 * The stated refusal, or the sentinel `"GRADED"`. Narrowing through `graded`
 * rather than reading `.reason` off the union is deliberate: the type makes
 * it impossible to read a reason off a window that has a grade.
 */
function reasonFor(
  verdict: FreezeVerdict,
  gapMs: number | null,
  tickMs: number
): UngradedReason | "GRADED" {
  const result = classifyWindow(verdict, gapMs, tickMs);
  return result.outcome === "graded" ? "GRADED" : result.reason;
}

/* ===================================================================== *
 * the defect itself: a healthy phone told it is being killed
 * ===================================================================== */

describe("the 60-89 s band is no longer a freeze", () => {
  /**
   * The arithmetic. At the 30 s cadence a 60-89 s window has
   * `expectedTicks = 2` (floor), so one missed tick is
   * `frozenFraction = 0.5`, which clears `DEFAULT_MIN_FROZEN_FRACTION`
   * exactly — a user glancing at another app for 70 seconds scoring a
   * full-weight freeze.
   */
  test("evaluateFreeze still calls it frozen — the artefact is real", () => {
    const verdict = evaluateFreeze({
      elapsedMs: 70_000,
      ticksAtBackground: 0,
      ticksNow: 1,
      tickIntervalMs: PROD_TICK_MS,
    });
    expect(verdict.expectedTicks).toBe(2);
    expect(verdict.frozenFraction).toBe(0.5);
    expect(verdict.frozen).toBe(true);
  });

  test("the grader refuses it: ungraded, below the grading floor", () => {
    const verdict = evaluateFreeze({
      elapsedMs: 70_000,
      ticksAtBackground: 0,
      ticksNow: 1,
      tickIntervalMs: PROD_TICK_MS,
    });
    expect(gradeWindow(verdict, 0, PROD_TICK_MS)).toBeNull();
    expect(classifyWindow(verdict, 0, PROD_TICK_MS)).toEqual({
      outcome: "ungraded",
      grade: null,
      reason: "below-grading-floor",
    });
  });

  test("the floor is OD-2's ten expected ticks, and it is inclusive", () => {
    expect(MIN_GRADED_EXPECTED_TICKS).toBe(10);
    // Nine ticks: 4.5 minutes at the production cadence.
    const nine = windowOf(9, 9, PROD_TICK_MS);
    expect(nine.expectedTicks).toBe(9);
    expect(gradeWindow(nine, 0, PROD_TICK_MS)).toBeNull();
    // Ten: five minutes, and gradeable.
    const ten = windowOf(10, 10, PROD_TICK_MS);
    expect(ten.expectedTicks).toBe(10);
    expect(gradeWindow(ten, 0, PROD_TICK_MS)).toBe("healthy");
  });

  /**
   * The consequence the user sees. `withServiceWindow` is the real streak
   * fold, and its caller gates it on a truthy grade, so an ungraded window
   * never reaches it. Three 70 s glances must leave the streak at zero; the
   * control alongside proves the fold still trips on three windows that
   * really are frozen.
   */
  test("three 70 s windows leave the streak at zero (control: three real freezes trip it)", () => {
    const glance = evaluateFreeze({
      elapsedMs: 70_000,
      ticksAtBackground: 0,
      ticksNow: 1,
      tickIntervalMs: PROD_TICK_MS,
    });
    let health = EMPTY_HEALTH;
    for (let i = 0; i < 3; i++) {
      const grade = gradeWindow(glance, 0, PROD_TICK_MS);
      if (grade) health = withServiceWindow(health, grade, 1_000);
    }
    expect(health.serviceFreezeStreak).toBe(0);
    expect(health.fallbackTriggeredAt).toBe(0);

    // Positive control: a real freeze — 20 expected ticks (10 min), 2
    // observed — still accumulates and still trips at three.
    const realFreeze = windowOf(2, 20, PROD_TICK_MS);
    expect(gradeWindow(realFreeze, 0, PROD_TICK_MS)).toBe("frozen");
    let control = EMPTY_HEALTH;
    for (let i = 0; i < 3; i++) {
      const grade = gradeWindow(realFreeze, 0, PROD_TICK_MS);
      if (grade) control = withServiceWindow(control, grade, 1_000);
    }
    expect(control.serviceFreezeStreak).toBe(3);
    expect(control.fallbackTriggeredAt).toBe(1_000);
  });
});

describe("the budget's unit is load-bearing (D-12 defect 3)", () => {
  /**
   * One verdict, graded twice. The only difference between the two columns is
   * the interval the 3-tick allowance is multiplied by: 2,000 ms gives a
   * 6,000 ms budget, 30,000 ms gives 90,000 ms. That substitution is the
   * defect — an allowance calibrated on the RN heartbeat clock applied
   * against the worklet tick clock — and a test set that grades the same for
   * both cannot see it. A clean ratio (300/300) keeps the ratio clause out of
   * the answer, so every disagreement below is the gap clause.
   */
  const clean = windowOf(300, 300, PROD_TICK_MS);

  test("the ratio contributes nothing to these rows", () => {
    expect(tickRatio(clean)).toBe(1);
  });

  const rows: [number, string, string][] = [
    // gapMs        under a 6,000 ms budget   under a 90,000 ms budget
    [5_999, "healthy", "healthy"],
    [6_000, "healthy", "healthy"],
    [6_001, "frozen", "healthy"],
    [60_000, "frozen", "healthy"],
    [90_000, "frozen", "healthy"],
    [90_001, "frozen", "frozen"],
  ];

  test.each(rows)(
    "a %d ms gap: %s at a 2 s tick, %s at a 30 s tick",
    (gapMs, atHeartbeat, atProduction) => {
      expect(gradeWindow(clean, gapMs, RN_HEARTBEAT_MS)).toBe(atHeartbeat);
      expect(gradeWindow(clean, gapMs, PROD_TICK_MS)).toBe(atProduction);
    }
  );

  test("the two budgets genuinely disagree — this set is not blind", () => {
    const disagreements = rows.filter(([, a, b]) => a !== b);
    expect(disagreements.map(([gapMs]) => gapMs)).toEqual([
      6_001, 60_000, 90_000,
    ]);
  });

  test("the budget is exactly HEALTHY_MAX_GAP_TICKS intervals, inclusive", () => {
    expect(HEALTHY_MAX_GAP_TICKS).toBe(3);
    const budget = PROD_TICK_MS * HEALTHY_MAX_GAP_TICKS;
    expect(budget).toBe(90_000);
    expect(gradeWindow(clean, budget, PROD_TICK_MS)).toBe("healthy");
    expect(gradeWindow(clean, budget + 1, PROD_TICK_MS)).toBe("frozen");
  });

  /**
   * A window is frozen if the gap is longer than 3 ticks. Over budget is
   * `frozen`, not `degraded`, which is what makes a 115 s stall cost a full
   * streak point.
   */
  test("over budget is frozen, not degraded, even on a perfect ratio", () => {
    expect(gradeWindow(clean, 115_000, PROD_TICK_MS)).toBe("frozen");
  });
});

describe("gradeWindow — the observed runs, on ratio", () => {
  /**
   * Graded with a measured-clean gap (0, not null) so the ratio is the only
   * thing under test. The recorded gap figures are RN heartbeat gaps and are
   * not inputs to this clause; see the file header.
   */
  const RUNS: {
    name: string;
    observed: number;
    expected: number;
    tickMs: number;
    grade: "healthy" | "degraded" | "frozen";
  }[] = [
    { name: "Redmi clean (1.002)", observed: 425, expected: 424, tickMs: RN_HEARTBEAT_MS, grade: "healthy" },
    { name: "Redmi re-run (0.997)", observed: 308, expected: 309, tickMs: RN_HEARTBEAT_MS, grade: "healthy" },
    { name: "Samsung third (0.753)", observed: 213, expected: 283, tickMs: RN_HEARTBEAT_MS, grade: "degraded" },
    { name: "Samsung S21 FE (0.576)", observed: 228, expected: 396, tickMs: RN_HEARTBEAT_MS, grade: "degraded" },
    { name: "Samsung S24 Ultra (0.167)", observed: 52, expected: 312, tickMs: RN_HEARTBEAT_MS, grade: "frozen" },
    { name: "11/19 run (0.579)", observed: 11, expected: 19, tickMs: PROD_TICK_MS, grade: "degraded" },
  ];

  for (const run of RUNS) {
    test(`${run.name} grades ${run.grade}`, () => {
      const verdict = windowOf(run.observed, run.expected, run.tickMs);
      expect(verdict.expectedTicks).toBe(run.expected);
      expect(gradeWindow(verdict, 0, run.tickMs)).toBe(run.grade);
    });
  }

  /**
   * The battery-unrestricted control: a respectable ratio hiding a 115 s
   * stall and a completion 49 s late. Ratio alone would call it healthy,
   * which is why the gap clause exists. A 115 s stall is 57 intervals at the
   * 2 s cadence it was recorded on and 3.8 at the production cadence — over
   * budget on either clock, so it grades `frozen`.
   */
  test("the battery-unrestricted control is caught by the gap clause alone", () => {
    const verdict = windowOf(290, 300, RN_HEARTBEAT_MS);
    expect(tickRatio(verdict)).toBeGreaterThan(HEALTHY_MIN_RATIO);
    expect(gradeWindow(verdict, 0, RN_HEARTBEAT_MS)).toBe("healthy");
    expect(gradeWindow(verdict, 115_000, RN_HEARTBEAT_MS)).toBe("frozen");
  });
});

describe("gradeWindow — the ratio boundary", () => {
  test("ratio exactly at the threshold with a clean gap is healthy", () => {
    const verdict = windowOf(90, 100, PROD_TICK_MS);
    expect(tickRatio(verdict)).toBeCloseTo(HEALTHY_MIN_RATIO, 10);
    expect(gradeWindow(verdict, 0, PROD_TICK_MS)).toBe("healthy");
  });

  test("just under the ratio threshold is degraded", () => {
    const verdict = windowOf(89, 100, PROD_TICK_MS);
    expect(gradeWindow(verdict, 0, PROD_TICK_MS)).toBe("degraded");
  });

  test("the empty band between the two observed populations", () => {
    // Nothing observed lands between 0.753 and 0.997, so the threshold has
    // room on both sides.
    const degradedSide = windowOf(753, 1000, PROD_TICK_MS);
    const healthySide = windowOf(997, 1000, PROD_TICK_MS);
    expect(gradeWindow(degradedSide, 0, PROD_TICK_MS)).toBe("degraded");
    expect(gradeWindow(healthySide, 0, PROD_TICK_MS)).toBe("healthy");
  });
});

/* ===================================================================== *
 * Ungraded — every way the module declines to answer
 * ===================================================================== */

describe("classifyWindow — ungraded windows", () => {
  test("a window too short to judge is ungraded", () => {
    const verdict = windowOf(0, 1, 10_000);
    expect(verdict.reason).toBe("too-short");
    expect(reasonFor(verdict, 0, PROD_TICK_MS)).toBe(
      "window-too-short"
    );
    expect(gradeWindow(verdict, 0, PROD_TICK_MS)).toBeNull();
  });

  test("too little signal is ungraded", () => {
    const verdict = evaluateFreeze({
      elapsedMs: 120_000,
      ticksAtBackground: 0,
      ticksNow: 1,
      tickIntervalMs: 90_000,
    });
    expect(verdict.reason).toBe("insufficient-signal");
    expect(reasonFor(verdict, 0, 90_000)).toBe(
      "insufficient-signal"
    );
  });

  test("an engine restart is ungraded rather than frozen", () => {
    // A counter that went backwards is a different event from a freeze and
    // must not add to a streak.
    const verdict = evaluateFreeze({
      elapsedMs: 600_000,
      ticksAtBackground: 500,
      ticksNow: 3,
      tickIntervalMs: PROD_TICK_MS,
    });
    expect(verdict.reason).toBe("invalid-input");
    expect(reasonFor(verdict, 0, PROD_TICK_MS)).toBe(
      "invalid-input"
    );
  });

  /**
   * Falling back to the ratio clause alone when `tickIntervalMs <= 0` is
   * banned: it returns `healthy` for a window with a 999,999 ms gap. The
   * module refuses to answer instead.
   */
  test("an unknown cadence is ungraded — there is NO ratio-only fallback", () => {
    const verdict = windowOf(100, 100, PROD_TICK_MS);
    expect(gradeWindow(verdict, 999_999, 0)).toBeNull();
    expect(reasonFor(verdict, 999_999, 0)).toBe("cadence-unknown");
    expect(reasonFor(verdict, 999_999, -1)).toBe("cadence-unknown");
    expect(reasonFor(verdict, 999_999, NaN)).toBe("cadence-unknown");
    // ...and the ratio was clean, so nothing but the refusal produced this.
    expect(tickRatio(verdict)).toBe(1);
  });

  /**
   * `null` vs `0` from `largestWorkletTickGapMs`. `null` is "no measurement
   * was taken"; `0` is "measured, saw no gap". Collapsing them manufactures a
   * `healthy` out of an absent measurement — the `frozenFraction = NaN` →
   * `ran-normally` failure exactly.
   */
  test("a null gap is ungraded; a zero gap is measured and grades", () => {
    const verdict = windowOf(100, 100, PROD_TICK_MS);
    expect(gradeWindow(verdict, null, PROD_TICK_MS)).toBeNull();
    expect(reasonFor(verdict, null, PROD_TICK_MS)).toBe(
      "gap-unmeasured"
    );
    expect(gradeWindow(verdict, 0, PROD_TICK_MS)).toBe("healthy");
  });

  test("a NaN or negative gap is ungraded, not healthy", () => {
    const verdict = windowOf(100, 100, PROD_TICK_MS);
    expect(reasonFor(verdict, NaN, PROD_TICK_MS)).toBe(
      "gap-unmeasured"
    );
    expect(reasonFor(verdict, -1, PROD_TICK_MS)).toBe(
      "gap-unmeasured"
    );
  });

  /**
   * The one exception: an outright freeze does not depend on the gap.
   * `verdict.frozen` is decided by the tick counter alone, so a device that
   * froze is still graded with no gap measurement — the one verdict that must
   * never be silently dropped.
   */
  test("a frozen verdict still grades with no gap measurement at all", () => {
    const verdict = windowOf(2, 20, PROD_TICK_MS);
    expect(verdict.frozen).toBe(true);
    expect(gradeWindow(verdict, null, PROD_TICK_MS)).toBe("frozen");
    expect(gradeWindow(verdict, null, 0)).toBe("frozen");
  });

  test("no ungraded outcome carries a grade", () => {
    const verdict = windowOf(100, 100, PROD_TICK_MS);
    for (const result of [
      classifyWindow(verdict, null, PROD_TICK_MS),
      classifyWindow(verdict, 0, 0),
      classifyWindow(windowOf(9, 9, PROD_TICK_MS), 0, PROD_TICK_MS),
      classifyWindow(windowOf(0, 1, 10_000), 0, PROD_TICK_MS),
    ]) {
      expect(result.outcome).toBe("ungraded");
      expect(result.grade).toBeNull();
      // Nothing ungraded may be looked up in the weight table.
      expect(GRADE_WEIGHT[result.grade as never]).toBeUndefined();
    }
  });
});

describe("grade weights", () => {
  test("frozen is twice degraded, and healthy contributes nothing", () => {
    expect(GRADE_WEIGHT.frozen).toBe(1);
    expect(GRADE_WEIGHT.degraded).toBe(0.5);
    expect(GRADE_WEIGHT.healthy).toBe(0);
  });

  test("six degraded weights sum exactly to three with no float drift", () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += GRADE_WEIGHT.degraded;
    expect(sum).toBe(3);
  });
});
