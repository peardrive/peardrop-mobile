/**
 * Validate an engine status reply before its liveness counter is trusted.
 * `aliveTicks` means "the engine's ticker is running", not "the OS let us
 * run": `engineStatus()` reports it unconditionally, so a failed `engineInit`
 * pins it at 0 while status calls keep succeeding and every long window reads
 * as fully frozen. A null return is no verdict — the window has no evidence.
 */

export type AliveReading = {
  /** The engine's liveness counter at the moment of the reply. */
  ticks: number;
  /** Cadence of that counter, in ms, as reported by the engine. */
  intervalMs: number;
};

/**
 * Shape accepted from the wire. Deliberately loose — this is a boundary, and
 * the point of the function is that the fields may be missing or wrong.
 */
export type AliveStatusLike =
  | {
      started?: unknown;
      aliveTicks?: unknown;
      aliveTickMs?: unknown;
    }
  | null
  | undefined;

/**
 * Extract a trustworthy liveness reading, or null. `Number.isFinite`, not
 * `typeof === "number"`: `evaluateFreeze` tests only `observedTicks < 0`, so a
 * NaN counter slips through and a malformed reply reads as a clean run.
 */
export function parseAliveReading(status: AliveStatusLike): AliveReading | null {
  if (!status) return null;
  // Strictly `true`: an engine that has not initialised reports `false`, and a
  // missing field is no evidence either way.
  if (status.started !== true) return null;
  const ticks = status.aliveTicks;
  const intervalMs = status.aliveTickMs;
  if (!Number.isFinite(ticks) || !Number.isFinite(intervalMs)) return null;
  return { ticks: ticks as number, intervalMs: intervalMs as number };
}
