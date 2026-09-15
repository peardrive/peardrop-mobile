// The healthy/degraded boundary, pinned to the runs it was calibrated from.
//
// Every run in the 2026-09-13 series came back `ran-normally` under the
// boolean, including one that stalled for 115 s and delivered a completion
// 49 s late. These tests exist so that boundary cannot drift back.

import { evaluateFreeze } from "../freezeDetect";
import {
  GRADE_WEIGHT,
  HEALTHY_MAX_GAP_TICKS,
  HEALTHY_MIN_RATIO,
  gradeWindow,
  tickRatio,
} from "../freezeGrade";

const TICK_MS = 2_000;

/** Build a real verdict rather than a hand-made object. */
function window(observed: number, elapsedMs: number, tickMs: number = TICK_MS) {
  return evaluateFreeze({
    elapsedMs,
    ticksAtBackground: 0,
    ticksNow: observed,
    tickIntervalMs: tickMs,
  });
}

describe("gradeWindow — the observed runs", () => {
  // Ratios and gaps from the 2026-09-13 device series.
  const RUNS: {
    name: string;
    observed: number;
    expected: number;
    gapMs: number;
    /** 19 expected ticks only clears the 60 s floor on the 30 s cadence. */
    tickMs: number;
    grade: "healthy" | "degraded" | "frozen";
  }[] = [
    { name: "Redmi clean", observed: 425, expected: 424, gapMs: 2_009, tickMs: TICK_MS, grade: "healthy" },
    { name: "Redmi re-run", observed: 308, expected: 309, gapMs: 2_006, tickMs: TICK_MS, grade: "healthy" },
    { name: "Samsung third", observed: 213, expected: 283, gapMs: 7_200, tickMs: TICK_MS, grade: "degraded" },
    { name: "Samsung S21 FE", observed: 228, expected: 396, gapMs: 31_000, tickMs: TICK_MS, grade: "degraded" },
    { name: "Samsung S24 Ultra", observed: 52, expected: 312, gapMs: 75_000, tickMs: TICK_MS, grade: "frozen" },
    { name: "11/19 run", observed: 11, expected: 19, gapMs: 40_000, tickMs: 30_000, grade: "degraded" },
  ];

  for (const run of RUNS) {
    test(`${run.name} grades ${run.grade}`, () => {
      const verdict = window(run.observed, run.expected * run.tickMs, run.tickMs);
      expect(verdict.expectedTicks).toBe(run.expected);
      expect(gradeWindow(verdict, run.gapMs, run.tickMs)).toBe(run.grade);
    });
  }

  test("the battery-unrestricted control is caught by the gap clause alone", () => {
    // The run the addendum flagged: a respectable ratio hiding a 115 s stall
    // and a completion 49 s late. Ratio alone would have called it healthy.
    const verdict = window(290, 300 * TICK_MS);
    expect(tickRatio(verdict)).toBeGreaterThan(HEALTHY_MIN_RATIO);
    expect(gradeWindow(verdict, 115_000, TICK_MS)).toBe("degraded");
  });
});

describe("gradeWindow — the boundary", () => {
  test("ratio exactly at the threshold with a clean gap is healthy", () => {
    const verdict = window(90, 100 * TICK_MS);
    expect(tickRatio(verdict)).toBeCloseTo(HEALTHY_MIN_RATIO, 10);
    expect(gradeWindow(verdict, TICK_MS, TICK_MS)).toBe("healthy");
  });

  test("just under the ratio threshold is degraded", () => {
    const verdict = window(89, 100 * TICK_MS);
    expect(gradeWindow(verdict, TICK_MS, TICK_MS)).toBe("degraded");
  });

  test("the gap budget is inclusive at exactly 3 intervals", () => {
    const verdict = window(100, 100 * TICK_MS);
    expect(gradeWindow(verdict, TICK_MS * HEALTHY_MAX_GAP_TICKS, TICK_MS)).toBe(
      "healthy"
    );
    expect(
      gradeWindow(verdict, TICK_MS * HEALTHY_MAX_GAP_TICKS + 1, TICK_MS)
    ).toBe("degraded");
  });

  test("the empty band between the two observed populations", () => {
    // Nothing observed lands between 0.753 and 0.997, so the threshold has
    // room on both sides. These assert the band is genuinely empty of
    // classification surprises.
    const degradedSide = window(753, 1000 * TICK_MS);
    const healthySide = window(997, 1000 * TICK_MS);
    expect(gradeWindow(degradedSide, TICK_MS, TICK_MS)).toBe("degraded");
    expect(gradeWindow(healthySide, TICK_MS, TICK_MS)).toBe("healthy");
  });
});

describe("gradeWindow — ungradeable windows", () => {
  test("a window too short to judge grades null", () => {
    const verdict = window(0, 10_000);
    expect(verdict.reason).toBe("too-short");
    expect(gradeWindow(verdict, 0, TICK_MS)).toBeNull();
  });

  test("too little signal grades null", () => {
    const verdict = evaluateFreeze({
      elapsedMs: 120_000,
      ticksAtBackground: 0,
      ticksNow: 1,
      tickIntervalMs: 90_000,
    });
    expect(verdict.reason).toBe("insufficient-signal");
    expect(gradeWindow(verdict, 0, 90_000)).toBeNull();
  });

  test("an engine restart grades null rather than frozen", () => {
    // A counter that went backwards is a different event from a freeze and
    // must not add to a streak.
    const verdict = evaluateFreeze({
      elapsedMs: 600_000,
      ticksAtBackground: 500,
      ticksNow: 3,
      tickIntervalMs: TICK_MS,
    });
    expect(verdict.reason).toBe("invalid-input");
    expect(gradeWindow(verdict, 0, TICK_MS)).toBeNull();
  });

  test("an unknown cadence falls back to the ratio alone", () => {
    const verdict = window(100, 100 * TICK_MS);
    expect(gradeWindow(verdict, 999_999, 0)).toBe("healthy");
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
