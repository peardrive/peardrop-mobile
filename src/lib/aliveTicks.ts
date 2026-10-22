/**
 * Validate an engine status reply before trusting its liveness counter. `engineStatus()` reports
 * `aliveTicks` unconditionally, so a failed init pins it at 0 and every long window reads as frozen.
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
 * A trustworthy reading, or null. `Number.isFinite`, not `typeof === "number"`: `evaluateFreeze`
 * tests only `observedTicks < 0`, so a NaN counter would read as a clean run.
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
