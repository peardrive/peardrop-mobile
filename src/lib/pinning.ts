/** Pinning, switched off in one place; the feature is kept whole. */

/** A deliberate off switch: `true` restores every surface. While false,
 * `stripStoredPins` also clears pins already saved. */
export const PINNING_ENABLED = false;

/** Returns 0 while off, so the caller's next level decides and no stray pin
 * flag can jump the queue. A function because a `.tsx` `if` is untestable. */
export function comparePinned(
  a: { isPinned?: boolean },
  b: { isPinned?: boolean }
): number {
  if (!PINNING_ENABLED) return 0;
  return (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
}

/** Runs on the raw array, before `sanitize` can coerce the key and make every
 * load report a change. Drops no record, touches no other field, idempotent. */
export function stripStoredPins(records: readonly unknown[]): {
  records: unknown[];
  cleared: number;
} {
  let cleared = 0;
  const out = records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return record;
    }
    if (!("isPinned" in record)) return record;
    const { isPinned: _retired, ...rest } = record as Record<string, unknown>;
    cleared += 1;
    return rest;
  });
  return { records: out, cleared };
}
