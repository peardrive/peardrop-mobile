// Guard on the engine liveness reading.
//
// `aliveTicks` means "the engine's ticker is running". The freeze detector
// read it as "the OS let us run". Those diverge whenever the engine itself is
// dead: engineStatus() reports the counter unconditionally, so a failed
// engineInit pins it at 0 while status calls keep succeeding, and every
// background window past the 60 s floor evaluates as 100% frozen — the app
// reporting an OS freeze for its own boot failure.

import { parseAliveReading } from "../aliveTicks";
import { evaluateFreeze } from "../freezeDetect";

/** A ten-minute window at the engine's real 30 s cadence. */
const WINDOW_MS = 600_000;
const TICK_MS = 30_000;

/**
 * The whole chain as BackendProvider runs it: a null reading means
 * `checkForFreeze` returns before `evaluateFreeze` is ever reached, so there
 * is no verdict at all — which is a different outcome from "not frozen".
 */
function verdictFor(
  status: unknown,
  ticksAtBackground: number
): ReturnType<typeof evaluateFreeze> | null {
  const reading = parseAliveReading(status as never);
  if (!reading) return null;
  return evaluateFreeze({
    elapsedMs: WINDOW_MS,
    ticksAtBackground,
    ticksNow: reading.ticks,
    tickIntervalMs: reading.intervalMs,
  });
}

describe("parseAliveReading — started must be true", () => {
  test("started:false yields no reading, and therefore no freeze verdict", () => {
    const dead = { started: false, aliveTicks: 0, aliveTickMs: TICK_MS };
    expect(parseAliveReading(dead)).toBeNull();
    // The counter is pinned at 0 across a ten-minute window — the exact shape
    // that used to be reported as `frozen 100%`.
    expect(verdictFor(dead, 0)).toBeNull();
  });

  test("a missing started field yields no reading", () => {
    expect(
      parseAliveReading({ aliveTicks: 5, aliveTickMs: TICK_MS })
    ).toBeNull();
  });

  test("a truthy-but-not-true started is rejected", () => {
    expect(
      parseAliveReading({ started: 1, aliveTicks: 5, aliveTickMs: TICK_MS })
    ).toBeNull();
    expect(
      parseAliveReading({ started: "true", aliveTicks: 5, aliveTickMs: TICK_MS })
    ).toBeNull();
  });

  test("null and undefined replies yield no reading", () => {
    expect(parseAliveReading(null)).toBeNull();
    expect(parseAliveReading(undefined)).toBeNull();
  });
});

describe("parseAliveReading — a live engine is unaffected", () => {
  test("started:true with valid counters passes the reading through", () => {
    expect(
      parseAliveReading({ started: true, aliveTicks: 417, aliveTickMs: TICK_MS })
    ).toEqual({ ticks: 417, intervalMs: TICK_MS });
  });

  test("a live engine that ran the whole window still reports not-frozen", () => {
    // 20 ticks observed against 20 expected — the Autostart-ON shape.
    const alive = { started: true, aliveTicks: 20, aliveTickMs: TICK_MS };
    const verdict = verdictFor(alive, 0);
    expect(verdict).not.toBeNull();
    expect(verdict?.frozen).toBe(false);
    expect(verdict?.reason).toBe("ran-normally");
    expect(verdict?.observedTicks).toBe(20);
  });

  test("a live engine that was frozen still reports frozen", () => {
    // 1 tick observed against 20 expected — the Autostart-OFF shape. The
    // guard must not suppress a genuine freeze.
    const alive = { started: true, aliveTicks: 1, aliveTickMs: TICK_MS };
    const verdict = verdictFor(alive, 0);
    expect(verdict?.frozen).toBe(true);
    expect(verdict?.reason).toBe("frozen");
    expect(verdict?.frozenFraction).toBeCloseTo(0.95, 5);
  });

  test("malformed counters are still rejected even when started is true", () => {
    expect(
      parseAliveReading({ started: true, aliveTicks: "417", aliveTickMs: TICK_MS })
    ).toBeNull();
    expect(
      parseAliveReading({ started: true, aliveTicks: 417 })
    ).toBeNull();
  });

  test("a NaN counter yields no reading, and therefore no verdict", () => {
    // evaluateFreeze does NOT catch this. Its only test on the tick counts is
    // `observedTicks < 0`, and `NaN < 0` is false, so a NaN counter reaches
    // `frozenFraction = 1 - NaN/20 = NaN`, fails `NaN >= 0.5`, and comes back
    // as `ran-normally` — a clean-run verdict invented from a malformed
    // reply. Verified by running it: reason was "ran-normally", not
    // "invalid-input". Rejecting it at the boundary is what makes the
    // outcome honest.
    const nan = { started: true, aliveTicks: Number.NaN, aliveTickMs: TICK_MS };
    expect(parseAliveReading(nan)).toBeNull();
    expect(verdictFor(nan, 0)).toBeNull();
  });

  test("an Infinite counter or cadence yields no reading", () => {
    expect(
      parseAliveReading({
        started: true,
        aliveTicks: Number.POSITIVE_INFINITY,
        aliveTickMs: TICK_MS,
      })
    ).toBeNull();
    expect(
      parseAliveReading({
        started: true,
        aliveTicks: 5,
        aliveTickMs: Number.POSITIVE_INFINITY,
      })
    ).toBeNull();
  });
});
