/** Which rows just became ready, and how long to tint them for. */
// Pure, so "once per change, never again on re-render or restart" is assertable rather than a claim about a component.

/** Total time for the two-pulse animation, in ms. */
export const HIGHLIGHT_TOTAL_MS = 2500;
/** One pulse up and back, so two of them fill the total. */
export const HIGHLIGHT_PULSE_MS = HIGHLIGHT_TOTAL_MS / 4;
/** Reduce-motion holds a single tint for this long instead of pulsing. */
export const HIGHLIGHT_STATIC_MS = 2000;

export type ReadyRow = {
  readonly shareKey: string;
  readonly status: string;
};

/** The keys that changed to ready between two snapshots. */
// A key absent from the previous snapshot does not count: a row arriving already ready is the store rehydrating, which would otherwise replay every highlight on restart.
export function newlyReadyKeys(
  prev: readonly ReadyRow[] | null | undefined,
  next: readonly ReadyRow[] | null | undefined,
): string[] {
  if (!prev || !next) return [];
  const before = new Map<string, string>();
  for (const r of prev) {
    if (r && typeof r.shareKey === "string" && r.shareKey) before.set(r.shareKey, r.status);
  }
  const out: string[] = [];
  for (const r of next) {
    if (!r || typeof r.shareKey !== "string" || !r.shareKey) continue;
    if (r.status !== "ready") continue;
    const was = before.get(r.shareKey);
    // Unknown key: not a change, a first sighting.
    if (was === undefined) continue;
    if (was === "ready") continue;
    out.push(r.shareKey);
  }
  return out;
}

/** The timings one highlight run uses, by motion preference. */
export function highlightPlan(reduceMotion: boolean): {
  pulses: number;
  pulseMs: number;
  totalMs: number;
  animated: boolean;
} {
  if (reduceMotion) {
    return { pulses: 1, pulseMs: HIGHLIGHT_STATIC_MS, totalMs: HIGHLIGHT_STATIC_MS, animated: false };
  }
  return {
    pulses: 2,
    pulseMs: HIGHLIGHT_PULSE_MS,
    totalMs: HIGHLIGHT_TOTAL_MS,
    animated: true,
  };
}
