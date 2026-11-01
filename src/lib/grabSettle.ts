/** Whether a grab's chosen files are held, and the guard that stops an automatic grab repeating forever. */

import { baseName } from "./files";

/** Consecutive automatic grabs the engine finished without the row settling, after which the loop stops grabbing it. */
export const AUTO_GRAB_STOP_AFTER = 2;

/** The name a collision-renamed save was asked for: the engine inserts ` (n)` before the last extension. */
export function unsuffixed(name: string): string {
  const b = baseName(name);
  const m = /^(.+) \(\d+\)(\.[^.]*)?$/.exec(b);
  return m ? `${m[1]}${m[2] ?? ""}` : b;
}

/** Splits the chosen names into held and missing; a save under a suffixed name is the same file, not a missing one. */
export function heldChoice(
  chosen: readonly string[],
  heldNames: Iterable<string>,
): { held: string[]; missing: string[] } {
  const exact = new Set<string>();
  const loose = new Set<string>();
  for (const n of heldNames) {
    const b = baseName(n);
    exact.add(b);
    loose.add(unsuffixed(b));
  }
  const held: string[] = [];
  const missing: string[] = [];
  for (const n of chosen) {
    const b = baseName(n);
    if (exact.has(b) || loose.has(b)) held.push(n);
    else missing.push(n);
  }
  return { held, missing };
}

export type AutoGrabGuard = ReadonlyMap<string, number>;

/** One automatic grab's result folded into the guard. A settled or unfinished grab breaks the streak; only finished-but-unsettled ones count. */
export function recordAutoGrab(
  guard: AutoGrabGuard,
  shareKey: string,
  outcome: { readonly engineComplete: boolean; readonly settled: boolean },
): { guard: AutoGrabGuard; stop: boolean; streak: number } {
  const next = new Map(guard);
  if (outcome.settled || !outcome.engineComplete) {
    next.delete(shareKey);
    return { guard: next, stop: false, streak: 0 };
  }
  const streak = (guard.get(shareKey) ?? 0) + 1;
  next.set(shareKey, streak);
  return { guard: next, stop: streak >= AUTO_GRAB_STOP_AFTER, streak };
}
