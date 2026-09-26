/**
 * An ungraded window must write nothing: only windows spanning at least 10
 * expected ticks are graded, and a 60–89 s window is the band where one
 * missed tick out of two clears `evaluateFreeze`'s threshold.
 *
 * No expected grade is handed to the code under test — each fixture is a
 * verdict and the policy derives the answer — and each assertion is paired
 * with a control fixture that must come out the other way.
 */
import {
  decideFreezeWindow,
  type FreezeWindowDecision,
} from "../freezeWindowPolicy";
import type { FreezeVerdict } from "../../lib/freezeDetect";
import { MIN_GRADED_EXPECTED_TICKS } from "../../lib/freezeGrade";
import {
  hasFallbackTriggered,
  shouldPrompt,
  withFreeze,
  withServiceWindow,
  type BackgroundHealth,
} from "../../lib/backgroundHealthModel";

const TICK_MS = 30_000;

/** A verdict as `evaluateFreeze` produces it. No grade is implied by any field. */
function verdict(partial: Partial<FreezeVerdict>): FreezeVerdict {
  const expectedTicks = partial.expectedTicks ?? 20;
  const observedTicks = partial.observedTicks ?? 0;
  return {
    frozen: partial.frozen ?? true,
    frozenFraction:
      partial.frozenFraction ??
      (expectedTicks > 0 ? 1 - observedTicks / expectedTicks : 0),
    elapsedMs: partial.elapsedMs ?? expectedTicks * TICK_MS,
    expectedTicks,
    observedTicks,
    reason: partial.reason ?? "frozen",
  };
}

describe("only a graded window may be recorded", () => {
  test("a 60-89s window is ungraded and records NOTHING, however frozen it looks", () => {
    // Two expected ticks, none observed: frozenFraction 1.0, `evaluateFreeze`
    // says frozen. This is the band that must not be recorded.
    const short = verdict({ expectedTicks: 2, observedTicks: 0 });
    expect(short.frozen).toBe(true);

    const d: FreezeWindowDecision = decideFreezeWindow(short, 0, TICK_MS);

    expect(d.grade).toBeNull();
    expect(d.ungradedReason).toBe("below-grading-floor");
    // THE ASSERTION. Before this change `recordFreeze` was called on
    // `verdict.frozen` alone and `freezeCount` went up for this window.
    expect(d.recordFreeze).toBe(false);
  });

  test("THE CONTROL: the same shape at the floor DOES record", () => {
    // One tick longer than the short window is not the difference; crossing
    // MIN_GRADED_EXPECTED_TICKS is. Without this arm a policy that refused
    // everything would pass the test above.
    const long = verdict({
      expectedTicks: MIN_GRADED_EXPECTED_TICKS,
      observedTicks: 0,
    });
    const d = decideFreezeWindow(long, 0, TICK_MS);

    expect(d.grade).toBe("frozen");
    expect(d.ungradedReason).toBeNull();
    expect(d.recordFreeze).toBe(true);
  });

  test("an unmeasured gap is ungraded but a real freeze still records", () => {
    // `null` means no gap measurement exists. It must not grade healthy by
    // default...
    const clean = verdict({
      frozen: false,
      expectedTicks: 20,
      observedTicks: 20,
      reason: "ran-normally",
    });
    const unmeasured = decideFreezeWindow(clean, null, TICK_MS);
    expect(unmeasured.grade).toBeNull();
    expect(unmeasured.ungradedReason).toBe("gap-unmeasured");
    expect(unmeasured.recordFreeze).toBe(false);

    // ...and the same `null` must NOT suppress an outright freeze, which is
    // decided before any gap clause. This is the arm that fails if someone
    // "simplifies" the policy to `gap !== null && ...`.
    const frozen = verdict({ expectedTicks: 20, observedTicks: 0 });
    const stillRecorded = decideFreezeWindow(frozen, null, TICK_MS);
    expect(stillRecorded.grade).toBe("frozen");
    expect(stillRecorded.recordFreeze).toBe(true);
  });

  test("a gap of 0 is a measurement and grades; null is not 0", () => {
    const clean = verdict({
      frozen: false,
      expectedTicks: 20,
      observedTicks: 20,
      reason: "ran-normally",
    });
    expect(decideFreezeWindow(clean, 0, TICK_MS).grade).toBe("healthy");
    expect(decideFreezeWindow(clean, null, TICK_MS).grade).toBeNull();
  });

  test("a window evaluateFreeze declined records nothing", () => {
    for (const reason of [
      "too-short",
      "insufficient-signal",
      "invalid-input",
    ] as const) {
      const declined = verdict({
        frozen: false,
        expectedTicks: 20,
        observedTicks: 1,
        reason,
      });
      const d = decideFreezeWindow(declined, 0, TICK_MS);
      expect(d.grade).toBeNull();
      expect(d.recordFreeze).toBe(false);
    }
  });
});

/**
 * The claim this fix rests on, checked rather than accepted: an ungraded window
 * that wrongly reached `recordFreeze` could NOT have produced the user-facing
 * prompt. If that were false, the polluted counter would be a live P0 rather
 * than a measurement defect, and the finding would be a different one.
 */
describe("POSITIVE CONTROL: freeze history cannot reach the prompt", () => {
  const empty: BackgroundHealth = {
    schemaVersion: 3,
    freezeCount: 0,
    lastFreezeAt: 0,
    lastElapsedMs: 0,
    lastFrozenFraction: 0,
    serviceFreezeStreak: 0,
    fallbackTriggeredAt: 0,
    promptedVersion: 0,
    hasPrompted: false,
  };

  test("any number of recorded freezes leaves shouldPrompt false", () => {
    let health = empty;
    for (let i = 0; i < 25; i++) {
      health = withFreeze(health, 1_000 + i, 120_000, 1);
    }
    expect(health.freezeCount).toBe(25);
    expect(hasFallbackTriggered(health)).toBe(false);
    expect(shouldPrompt(health)).toBe(false);
  });

  test("THE CONTROL: graded service windows DO reach it", () => {
    // Without this arm, "shouldPrompt stayed false" would also be what a
    // permanently-disabled prompt looks like, and the control above would prove
    // nothing.
    let health = empty;
    for (let i = 0; i < 3; i++) {
      health = withServiceWindow(health, "frozen", 2_000 + i);
    }
    expect(hasFallbackTriggered(health)).toBe(true);
    expect(shouldPrompt(health)).toBe(true);
  });
});
