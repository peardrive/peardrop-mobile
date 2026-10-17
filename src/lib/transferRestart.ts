/** Clearing a transfer row so a new grab cannot inherit the last one's ending. */
// Not cosmetic: the completed flag holds the foreground service, so a fresh download born complete could release it.

export type RestartableTransfer = {
  percent?: number | null;
  bytesTransferred?: number;
  totalBytes?: number | null;
  completed?: boolean;
  cancelled?: boolean;
  filesKept?: number | null;
  stalled?: boolean;
  progressEverReceived?: boolean;
  peersConnected?: number;
  peerIds?: string[];
  lastPeerLeftAt?: number | null;
  lastEventAt?: number;
  [key: string]: unknown;
};

/** The fields a new grab must not inherit, and nothing else; identity and anything the caller sets explicitly are left alone. */
// The last-event stamp is set to now rather than zeroed, because the stall watchdog measures from it and a zero reads as no events since the epoch.
export function restartTransfer<T extends RestartableTransfer>(
  prev: T | undefined | null,
  now: number,
): T & RestartableTransfer {
  const base = (prev ?? {}) as T;
  return {
    ...base,
    percent: null,
    bytesTransferred: 0,
    totalBytes: null,
    completed: false,
    cancelled: false,
    filesKept: null,
    stalled: false,
    progressEverReceived: false,
    peersConnected: 0,
    peerIds: [],
    lastPeerLeftAt: null,
    lastEventAt: now,
  };
}

/** Does this row carry a previous run's ending? For a log line only; the reset
 * is unconditional, because detecting staleness has to be right every time. */
export function carriesPreviousOutcome(prev: RestartableTransfer | undefined | null): boolean {
  if (!prev) return false;
  return (
    prev.completed === true ||
    prev.cancelled === true ||
    prev.stalled === true ||
    (typeof prev.bytesTransferred === "number" && prev.bytesTransferred > 0)
  );
}
