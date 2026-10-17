/** The one sender-liveness reading, shared by the row and the picker. */
// A file list is also built from disk and reaches no announcer, so a list existing never implied the sender was there.

/** What the waiting loop persists on the record after every check. */
export type LookupRecordLike = {
  /** When the loop last asked the DHT about this share. */
  readonly lastCheckedAt?: number;
  /** Consecutive checks that found no announcer. `0` means the last one hit. */
  readonly emptyChecks?: number;
};

export type SenderLookup = {
  readonly found: boolean;
  readonly at: number;
};

/** The lookup argument the model should be given for a share. */
// Null when the loop has never checked, which is not the same as offline: the model still has the live transfer to go on, and a peer delivering bytes outranks any lookup.
export function senderLookupFor(
  record: LookupRecordLike | null | undefined,
): SenderLookup | null {
  const at = record?.lastCheckedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  // `?? 1`, not `?? 0`: a record predating the counter would otherwise claim an observation that was never made.
  const empties = typeof record?.emptyChecks === "number" ? record.emptyChecks : 1;
  return { found: empties === 0, at };
}
