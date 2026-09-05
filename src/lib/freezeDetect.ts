/**
 * Decide whether the process was frozen while backgrounded.
 *
 * Wall-clock time passes whether the app was running or frozen, and RN's own
 * timers stop on background either way, so neither is evidence. The engine's
 * liveness counter is: it advances while the app is merely backgrounded and
 * stops when the OS freezes the process. Comparing ticks actually observed
 * against ticks that should have elapsed is therefore the whole measurement.
 *
 * Pure by design — data in, verdict out, no React Native imports — so
 * jest.config.js can reach it.
 */

export type FreezeInput = {
  /** Wall-clock ms between backgrounding and returning. */
  elapsedMs: number;
  /** Engine counter at background time. */
  ticksAtBackground: number;
  /** Engine counter on return. */
  ticksNow: number;
  /** Engine's tick cadence, reported alongside the counter. */
  tickIntervalMs: number;
  /** Below this, the backgrounding is too short to judge. */
  minElapsedMs?: number;
  /** Frozen fraction at or above which we call it a freeze. */
  minFrozenFraction?: number;
};

export type FreezeVerdict = {
  /** True only when the evidence is strong enough to act on. */
  frozen: boolean;
  /** 0 = ran the whole time, 1 = never ran. NaN-safe. */
  frozenFraction: number;
  elapsedMs: number;
  /** Ticks the engine should have run if never frozen. */
  expectedTicks: number;
  /** Ticks it actually ran. */
  observedTicks: number;
  /** Why the verdict is what it is — for logging and for tests. */
  reason:
    | "frozen"
    | "ran-normally"
    | "too-short"
    | "insufficient-signal"
    | "invalid-input";
};

/**
 * One minute. A freeze can begin within seconds — onsets of 2.6-6.4 s have
 * been measured — but a user glancing at another app for ten seconds is not
 * a problem worth reporting, and at a 30 s cadence a shorter window yields
 * fewer than two expected ticks, which is too coarse to divide by. Sixty
 * seconds is the point where the measurement is both meaningful and worth
 * acting on.
 */
export const DEFAULT_MIN_ELAPSED_MS = 60_000;

/**
 * Half. A genuine freeze measures 96-99% frozen and an unrestricted run 0%,
 * so the two populations are nowhere near this line — it exists only to
 * reject noise, not to discriminate between close cases. Scheduler jitter
 * and a tick landing just outside the window cost a few percent at most.
 */
export const DEFAULT_MIN_FROZEN_FRACTION = 0.5;

export function evaluateFreeze(input: FreezeInput): FreezeVerdict {
  const {
    elapsedMs,
    ticksAtBackground,
    ticksNow,
    tickIntervalMs,
    minElapsedMs = DEFAULT_MIN_ELAPSED_MS,
    minFrozenFraction = DEFAULT_MIN_FROZEN_FRACTION,
  } = input;

  const observedTicks = ticksNow - ticksAtBackground;

  const invalid =
    !Number.isFinite(elapsedMs) ||
    !Number.isFinite(tickIntervalMs) ||
    tickIntervalMs <= 0 ||
    elapsedMs < 0 ||
    // A counter that went backwards means the engine restarted, which is a
    // different event from a freeze and must not be reported as one.
    observedTicks < 0;

  if (invalid) {
    return {
      frozen: false,
      frozenFraction: 0,
      elapsedMs,
      expectedTicks: 0,
      observedTicks: Math.max(0, observedTicks),
      reason: "invalid-input",
    };
  }

  if (elapsedMs < minElapsedMs) {
    return {
      frozen: false,
      frozenFraction: 0,
      elapsedMs,
      expectedTicks: 0,
      observedTicks,
      reason: "too-short",
    };
  }

  // Floor, not round: a window of 90 s at a 30 s cadence guarantees only two
  // completed intervals, because the first tick lands at an arbitrary offset
  // from the moment of backgrounding. Rounding up would manufacture a
  // missing tick and report a freeze that did not happen.
  const expectedTicks = Math.floor(elapsedMs / tickIntervalMs);

  if (expectedTicks < 2) {
    return {
      frozen: false,
      frozenFraction: 0,
      elapsedMs,
      expectedTicks,
      observedTicks,
      reason: "insufficient-signal",
    };
  }

  const ran = Math.min(observedTicks, expectedTicks);
  const frozenFraction = 1 - ran / expectedTicks;
  const frozen = frozenFraction >= minFrozenFraction;

  return {
    frozen,
    frozenFraction,
    elapsedMs,
    expectedTicks,
    observedTicks,
    reason: frozen ? "frozen" : "ran-normally",
  };
}

/** Human-readable duration for the prompt copy. */
export function describeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "a moment";
  // Checked before rounding: Math.round(0.5) is 1, so a 30 s window would
  // otherwise be described as "about a minute".
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes === 1) return "about a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}
