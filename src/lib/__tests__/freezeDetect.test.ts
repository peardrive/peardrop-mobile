import {
  DEFAULT_MIN_ELAPSED_MS,
  describeDuration,
  evaluateFreeze,
  type FreezeInput,
} from "../freezeDetect";

const TICK = 30_000;

function input(over: Partial<FreezeInput> = {}): FreezeInput {
  return {
    elapsedMs: 10 * 60_000,
    ticksAtBackground: 100,
    ticksNow: 120,
    tickIntervalMs: TICK,
    ...over,
  };
}

describe("evaluateFreeze", () => {
  it("reports a freeze when almost no ticks ran", () => {
    // The measured case: ~15 min backgrounded, 96-99% frozen.
    const res = evaluateFreeze(
      input({ elapsedMs: 15 * 60_000, ticksAtBackground: 100, ticksNow: 101 })
    );
    expect(res.frozen).toBe(true);
    expect(res.reason).toBe("frozen");
    expect(res.expectedTicks).toBe(30);
    expect(res.observedTicks).toBe(1);
    expect(res.frozenFraction).toBeCloseTo(1 - 1 / 30, 5);
  });

  it("reports no freeze when every tick ran", () => {
    // The restriction-off control: ~20 min, 0% frozen.
    const res = evaluateFreeze(
      input({ elapsedMs: 20 * 60_000, ticksAtBackground: 0, ticksNow: 40 })
    );
    expect(res.frozen).toBe(false);
    expect(res.reason).toBe("ran-normally");
    expect(res.frozenFraction).toBe(0);
  });

  it("ignores a short backgrounding even if fully frozen", () => {
    const res = evaluateFreeze(
      input({ elapsedMs: 20_000, ticksAtBackground: 5, ticksNow: 5 })
    );
    expect(res.frozen).toBe(false);
    expect(res.reason).toBe("too-short");
  });

  it("treats exactly the minimum elapsed time as long enough to judge", () => {
    const res = evaluateFreeze(
      input({ elapsedMs: DEFAULT_MIN_ELAPSED_MS, ticksAtBackground: 5, ticksNow: 5 })
    );
    expect(res.reason).toBe("frozen");
    expect(res.frozen).toBe(true);
  });

  it("declines to judge when fewer than two ticks were expected", () => {
    // 45 s at a 30 s cadence floors to one expected tick — too coarse.
    const res = evaluateFreeze(
      input({
        elapsedMs: 45_000,
        ticksAtBackground: 5,
        ticksNow: 5,
        minElapsedMs: 10_000,
      })
    );
    expect(res.frozen).toBe(false);
    expect(res.reason).toBe("insufficient-signal");
    expect(res.expectedTicks).toBe(1);
  });

  it("floors expected ticks rather than rounding, so a partial interval is not a missing tick", () => {
    // 119 s = 3 completed 30 s intervals plus change. Rounding would expect 4
    // and manufacture a freeze from a normal run.
    const res = evaluateFreeze(
      input({ elapsedMs: 119_000, ticksAtBackground: 0, ticksNow: 3 })
    );
    expect(res.expectedTicks).toBe(3);
    expect(res.frozen).toBe(false);
  });

  it("does not report a freeze when the engine restarted (counter went backwards)", () => {
    const res = evaluateFreeze(
      input({ elapsedMs: 10 * 60_000, ticksAtBackground: 500, ticksNow: 3 })
    );
    expect(res.frozen).toBe(false);
    expect(res.reason).toBe("invalid-input");
  });

  it("clamps a counter that ran ahead of expectation to 0% frozen", () => {
    const res = evaluateFreeze(
      input({ elapsedMs: 5 * 60_000, ticksAtBackground: 0, ticksNow: 999 })
    );
    expect(res.frozenFraction).toBe(0);
    expect(res.frozen).toBe(false);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(evaluateFreeze(input({ tickIntervalMs: 0 })).reason).toBe("invalid-input");
    expect(evaluateFreeze(input({ elapsedMs: -1 })).reason).toBe("invalid-input");
    expect(evaluateFreeze(input({ elapsedMs: Number.NaN })).reason).toBe("invalid-input");
    expect(evaluateFreeze(input({ tickIntervalMs: Number.NaN })).reason).toBe(
      "invalid-input"
    );
  });

  it("honours a caller-supplied frozen-fraction threshold", () => {
    // 50% frozen: above the 0.4 threshold, below the 0.9 one.
    const half = { elapsedMs: 10 * 60_000, ticksAtBackground: 0, ticksNow: 10 };
    expect(evaluateFreeze(input({ ...half, minFrozenFraction: 0.4 })).frozen).toBe(true);
    expect(evaluateFreeze(input({ ...half, minFrozenFraction: 0.9 })).frozen).toBe(false);
  });
});

describe("describeDuration", () => {
  it("renders the ranges the prompt uses", () => {
    expect(describeDuration(30_000)).toBe("less than a minute");
    expect(describeDuration(60_000)).toBe("about a minute");
    expect(describeDuration(15 * 60_000)).toBe("about 15 minutes");
    expect(describeDuration(60 * 60_000)).toBe("about an hour");
    expect(describeDuration(3 * 60 * 60_000)).toBe("about 3 hours");
  });

  it("guards non-positive and non-finite input", () => {
    expect(describeDuration(0)).toBe("a moment");
    expect(describeDuration(-5)).toBe("a moment");
    expect(describeDuration(Number.NaN)).toBe("a moment");
  });
});
