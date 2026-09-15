/**
 * Validate an engine status reply before its liveness counter is trusted.
 *
 * `aliveTicks` measures one thing: "the engine's ticker is running." The
 * freeze detector was reading it as a different thing: "the OS let us run."
 * Those two agree only while the engine is alive, and diverge completely when
 * it is not — `engineStatus()` reports `aliveTicks` unconditionally, so a
 * failed `engineInit` leaves the counter pinned at 0 forever while the status
 * call keeps succeeding. Every background window over the 60 s floor then
 * evaluates as 100% frozen, and the app reports an OS freeze for what is
 * actually its own boot failure.
 *
 * `started` is the engine's own answer to "did I initialise", and it has been
 * on the wire since the counter was added — it was simply never read. Requiring
 * it makes the reading mean what the caller assumes it means.
 *
 * A null return is not a freeze verdict of any kind: both call sites in
 * BackendProvider return early on null and log "CANNOT be judged", which is
 * the honest outcome for a window the app has no evidence about.
 *
 * Pure so jest.config.js can reach it; the RPC call stays in backend.ts.
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
 * Extract a trustworthy liveness reading, or null.
 *
 * `Number.isFinite`, not `typeof === "number"`, and the difference matters.
 * `evaluateFreeze` guards non-finite `elapsedMs` and `tickIntervalMs`, but it
 * does NOT guard the tick counts: its only test on them is
 * `observedTicks < 0`, which catches a counter running backwards and lets NaN
 * through, because `NaN < 0` is false. A NaN counter therefore reaches
 * `frozenFraction = 1 - NaN/20 = NaN`, fails `NaN >= 0.5`, and is reported as
 * **`ran-normally`** — a clean-run verdict manufactured out of a malformed
 * reply. Rejecting it here turns that into "cannot be judged", which is what
 * it actually is.
 *
 * Fixed at the boundary rather than in `evaluateFreeze` deliberately: this is
 * where wire data stops being untrusted, and the freeze evaluator's
 * classifications are load-bearing for every historical log line.
 */
export function parseAliveReading(status: AliveStatusLike): AliveReading | null {
  if (!status) return null;
  // Strictly `true`. An engine that has not initialised reports `false`, and
  // a reply missing the field entirely predates the counter — neither is
  // evidence of anything.
  if (status.started !== true) return null;
  const ticks = status.aliveTicks;
  const intervalMs = status.aliveTickMs;
  if (!Number.isFinite(ticks) || !Number.isFinite(intervalMs)) return null;
  return { ticks: ticks as number, intervalMs: intervalMs as number };
}
