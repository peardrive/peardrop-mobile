/**
 * the single answer to "is a transfer in flight right now".
 *
 * This is the ONLY place that question is answered. The service lifecycle,
 * the freeze attribution and the fallback counter all call in here; none of
 * them re-derives the condition. Scattering it is how the two halves of a
 * start/stop pair drift apart and a service is held forever.
 *
 * Pure, and importing nothing, for two reasons. It must be unit-testable
 * under jest's "node" environment, which cannot load react-native — the same
 * split as `settingsLadder.ts` and `oemProbeCandidates.ts`. And it must be
 * callable SYNCHRONOUSLY from the AppState → background handler: see
 * "Why this cannot await" below.
 *
 * ## Why this cannot await
 *
 * The predicate is read at the AppState → background transition, which is
 * the last moment the process is reliably executing. Everything after that
 * may be frozen. `markBackgrounded()` next door awaits `readAliveTicks()` —
 * an RPC into the worklet — and its own log line admits the failure mode:
 * "mark FAILED … engine status unreachable, this background window CANNOT
 * be judged". The service decision must never inherit that. So this function
 * takes an already-materialised snapshot of RN-side state and returns a
 * boolean with no I/O, no promise and no engine round-trip.
 *
 * A corollary: everything it reads must already be in RN's memory at
 * background time. Nothing here may depend on a value the engine can only
 * supply later.
 */

/**
 * THE HOSTING DECISION, as one boolean in one place.
 *
 * An idle hosted share — seeded, swarm attached, zero peers connected — is
 * NOT active. It does not hold the service.
 *
 * The cost of the other choice is what decides it: a permanent ongoing
 * notification for any user who has ever shared anything, real battery
 * drain for a process doing nothing, a `dataSync` Play declaration that
 * would have to claim data is syncing when none is, and Android 15's ~6 h
 * cap burned on idleness so it is unavailable when a transfer actually
 * starts.
 *
 * What it costs instead: a peer who comes online long after the sharer
 * backgrounded their phone cannot reach it. That is a real loss, and
 * `IDLE_HOST_GRACE_MS` below is the partial mitigation — not a fix.
 *
 * Flip this to `true` and the grace window becomes irrelevant; every hosted
 * share holds the service for as long as it exists. Nothing else needs to
 * change.
 */
export const HOLD_SERVICE_FOR_IDLE_HOST = false;

/**
 * How long a hosted share stays "active" after its LAST peer disconnects.
 *
 * A peer that drops at 98% and reconnects ten seconds later is the common
 * case, and releasing the service the instant the count hits zero would let
 * the OS freeze the process in the gap. Ten minutes is long enough to cover
 * a Wi-Fi roam, a tunnel, or a screen-lock on the peer's side, and short
 * enough that a genuinely finished share is not holding a notification for
 * the rest of the day.
 *
 * This is only reachable because peer transitions are genuinely observable
 * from the RN side — the engine emits `peer-connected` / `peer-disconnected`
 * for hosted swarms and the RN event pump maintains `peerIds` and
 * `peersConnected` per drive. The 8A brief said not to synthesise the signal
 * if it were not observable; it is, so the timer is real rather than a
 * guess.
 */
export const IDLE_HOST_GRACE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------
// the forced-active override (test instrument)
// ---------------------------------------------------------------------

/**
 * Force the predicate true regardless of real transfer state.
 *
 * 8A ships a service gated on `isTransferActive()`, and that predicate had
 * never returned true on hardware — every log read `active=false transfers=0
 * service=skip`. The mechanism was proven by 7D's harness, which starts the
 * service WITHOUT consulting the predicate; the trigger was not.
 *
 * This is the fallback instrument for closing that gap, not the primary one.
 * It bypasses `classifyTransfer` entirely, so it proves the service starts
 * and the lifecycle runs — it proves nothing about whether a real transfer
 * satisfies the predicate. The sustained-simulate row exercises the genuine
 * `upload` branch and should be preferred; this exists because three minutes
 * of foreground waiting per attempt is a real cost on a borrowed device, and
 * because it is the only way to get an active state with no transfer at all.
 *
 * Session-only by design: a module-level `let`, reset by any reload. A forced
 * state surviving a relaunch is how someone measures a lie a week later.
 */
let forcedActive = false;

/**
 * `isDebugBuild` is injected rather than imported.
 *
 * This module must stay free of react-native imports — jest runs it under
 * `testEnvironment: "node"` and the config says so explicitly — so it cannot
 * read `IS_DEBUG_BUILD` from `devGate.ts` itself. Passing it in puts the gate
 * INSIDE the flag's own source rather than only at the call site, and makes
 * "ignored when the gate is off" directly testable.
 *
 * In a release build this can only ever set `false`, whatever it is passed.
 */
export function setForcedTransferActive(
  next: boolean,
  isDebugBuild: boolean
): void {
  forcedActive = isDebugBuild ? next : false;
}

export function isForcedTransferActive(): boolean {
  return forcedActive;
}

/** Origin as the RN transfer record carries it. */
export type ActivityOrigin = "hosted" | "received" | "unknown";

/**
 * The minimum a transfer must expose to be classified.
 *
 * Deliberately a narrow structural subset of `TransferSummary` rather than
 * the type itself: this module must not import from `src/state/types.ts`,
 * and a narrow input makes the test fixtures honest about what is actually
 * consulted.
 *
 * `lastPeerLeftAt` is the one field `TransferSummary` does NOT have today.
 * It must be stamped in the `peer-disconnected` handler when the count
 * reaches zero. `lastEventAt` is not a substitute — it is bumped by every
 * event, so it cannot distinguish "the last peer left 9 minutes ago" from
 * "something unrelated happened 2 seconds ago".
 */
export type TransferActivityInput = {
  origin: ActivityOrigin;
  completed: boolean;
  stalled: boolean;
  peersConnected: number;
  /** When the peer count last fell to zero. Null if it never has. */
  lastPeerLeftAt: number | null;
};

/** Why a transfer counts as active. Null means it does not. */
export type ActivityReason =
  /** A download in flight. Unambiguous. */
  | "download"
  /** A hosted share with at least one peer connected. Unambiguous. */
  | "upload"
  /** A hosted share whose last peer left inside the grace window. */
  | "idle-host-grace"
  /** Hosting an idle share, only when HOLD_SERVICE_FOR_IDLE_HOST is true. */
  | "idle-host";

export function classifyTransfer(
  t: TransferActivityInput,
  now: number
): ActivityReason | null {
  // A connected peer on a hosted drive is the strongest signal there is, and
  // it is checked BEFORE `completed` on purpose. `completed` on a hosted
  // transfer is not terminal: the RN watchdog sets it when the last peer
  // disconnects (the "stuck-at-0%" heuristic), so a drive that has served
  // one peer and is now serving a second is `completed: true` while bytes
  // are actively flowing. Consulting it here would release the service
  // mid-transfer.
  if (t.origin === "hosted" || t.origin === "unknown") {
    if (t.peersConnected > 0) return "upload";
  }

  if (t.origin === "received") {
    // A completed download is done. A stalled one has had no events for
    // 30 s and its sender has usually gone; holding a foreground service
    // for it is the idle-host cost with none of the upside.
    if (!t.completed && !t.stalled) return "download";
    return null;
  }

  if (t.origin === "hosted") {
    if (HOLD_SERVICE_FOR_IDLE_HOST) return "idle-host";
    if (
      t.lastPeerLeftAt !== null &&
      now - t.lastPeerLeftAt >= 0 &&
      now - t.lastPeerLeftAt < IDLE_HOST_GRACE_MS
    ) {
      return "idle-host-grace";
    }
    return null;
  }

  // `unknown` origin with no peers. Transient — the origin resolver has not
  // caught up yet. Treated as inactive rather than guessed: a wrong "active"
  // here holds a service indefinitely, a wrong "inactive" costs one
  // background window that the next foreground transition re-evaluates.
  return null;
}

/** Every transfer that counts as active, with its reason. */
export function activeTransfers(
  list: readonly TransferActivityInput[],
  now: number
): { index: number; reason: ActivityReason }[] {
  const out: { index: number; reason: ActivityReason }[] = [];
  list.forEach((t, index) => {
    const reason = classifyTransfer(t, now);
    if (reason) out.push({ index, reason });
  });
  return out;
}

/**
 * THE predicate. Everything downstream calls this and nothing else.
 */
export function isTransferActive(
  list: readonly TransferActivityInput[],
  now: number
): boolean {
  // the override is read HERE, inside the single entry point, so
  // the background decision, the release path and the grace timer all see
  // the same answer. A second code path is how a forced start acquires a
  // real stop, or the reverse.
  if (forcedActive) return true;
  return list.some((t) => classifyTransfer(t, now) !== null);
}

/**
 * How long until this list's answer could change on its own, in ms.
 *
 * Only the idle-host grace window expires without an event; every other
 * reason flips because a transfer changed, which the caller already observes.
 * Returns null when nothing is on a timer, so the caller can skip scheduling
 * a wake-up it does not need.
 *
 * Exists so the service-release logic does not have to re-derive the grace
 * arithmetic and drift from `classifyTransfer`.
 */
export function msUntilActivityCouldChange(
  list: readonly TransferActivityInput[],
  now: number
): number | null {
  let soonest: number | null = null;
  for (const t of list) {
    if (classifyTransfer(t, now) !== "idle-host-grace") continue;
    if (t.lastPeerLeftAt === null) continue;
    const remaining = t.lastPeerLeftAt + IDLE_HOST_GRACE_MS - now;
    if (remaining <= 0) continue;
    if (soonest === null || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

/**
 * One-line summary for the log, so a background window's start/stop decision
 * can be read back afterwards rather than inferred.
 *
 * Counts by reason rather than dumping drive ids — an exported log already
 * carries those, and this line is meant to be greppable.
 */
export function describeActivity(
  list: readonly TransferActivityInput[],
  now: number
): string {
  const active = activeTransfers(list, now);

  // `forced=true` whenever the override is in effect, so no
  // exported log can show an `active=true` that was really a test override.
  // The real reasons are still printed beside it — a forced run over a list
  // that happens to contain a live upload reads `forced=true … upload=1`,
  // which is the honest description of both facts.
  //
  // The same principle governs `upload=` versus `idle-host-grace=`: the log
  // has to say WHICH branch made it true, or a grace-window run and an
  // upload-sustained one are indistinguishable afterwards.
  const forced = forcedActive ? "forced=true " : "";

  if (active.length === 0) {
    return `${forced}active=${forcedActive} transfers=${list.length}`;
  }
  const counts: Record<string, number> = {};
  for (const { reason } of active) counts[reason] = (counts[reason] ?? 0) + 1;
  const detail = Object.keys(counts)
    .sort()
    .map((k) => `${k}=${counts[k]}`)
    .join(" ");
  return `${forced}active=true transfers=${list.length} ${detail}`;
}
