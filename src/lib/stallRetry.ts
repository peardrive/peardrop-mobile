/** The timed retry as a schedule, not a timer, for a peer attached with nothing moving — which the waiting loop cannot help. */
// Three retries then it stops asking, and the clock is injected because a real timer is a schedule no test can assert.

import { STALL_RETRY_LIMIT, type RowLifecycleState } from "./rowLifecycle";

export const STALL_RETRY_DELAY_MS = 10_000;

export type StallRetryPlan = {
  /** `null` means "leave it to the waiting loop's ordinary cadence". */
  readonly at: number | null;
  /** 1-based, for the log line. `0` when there is no retry. */
  readonly attempt: number;
};

/** When the next timed retry is due. Only a stalled row is eligible: the offline case is the loop's business, and the two that need the user or the host would be noise on a short drum. */
export function planStallRetry(
  state: RowLifecycleState,
  now: number,
): StallRetryPlan {
  if (state.status !== "paused") return { at: null, attempt: 0 };
  if (state.pauseReason !== "stalled") return { at: null, attempt: 0 };
  // `>`, not `>=`: the third stall carries `stallRetries === 3` and is
  // entitled to the third retry. The fourth is the one that stops.
  if (state.stallRetries > STALL_RETRY_LIMIT) return { at: null, attempt: 0 };
  if (!Number.isFinite(now)) return { at: null, attempt: 0 };
  return {
    at: now + STALL_RETRY_DELAY_MS,
    // `stallRetries` is incremented by the `stall` event that produced this
    // pause, so it is already the count of this attempt.
    attempt: state.stallRetries,
  };
}

/** The timestamps a full retry sequence produces from one starting stall, exported so a test can state the schedule rather than observe whatever the implementation happened to do. */
export function stallRetryTimestamps(firstStallAt: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= STALL_RETRY_LIMIT; i++) {
    out.push(firstStallAt + i * STALL_RETRY_DELAY_MS);
  }
  return out;
}
