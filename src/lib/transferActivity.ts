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

/**
 * the pad on the WAKE, not on the window.
 *
 * `IDLE_HOST_GRACE_MS` above is unchanged and this does not extend it. It is the
 * margin that was already in the tree, as a bare `+ 250` on the RN `setTimeout`
 * that used to end this window, kept for the same reason it was written: a wake
 * that lands exactly on the boundary finds `now - lastPeerLeftAt < GRACE` true by
 * a millisecond and releases nothing, and the next re-evaluation is a whole
 * ticker cadence away.
 *
 * What changed is who waits it out. The worklet expires the window now
 * (`backend/hyperdrive-engine.mjs`, `sweepIdleHostGrace`), because RN's timers do
 * not run in the state this window exists to cover. RN sends
 * `IDLE_HOST_GRACE_MS + IDLE_HOST_GRACE_WAKE_PAD_MS` down on `RPC_LISTEN`, and
 * the pad covers the one-way IPC skew between the engine stamping its own
 * `lastPeerLeftAt` and RN stamping its copy on the `peer-disconnected` it
 * produced. The engine's stamp is always the earlier of the two, so the pad is
 * spent in the right direction.
 *
 * Both numbers live here, in the file that owns the arithmetic, so neither realm
 * can hold a copy that drifts.
 */
export const IDLE_HOST_GRACE_WAKE_PAD_MS = 250;

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
  /**
   * The RN stall watchdog's verdict.
   *
   * **no longer read on the download branch.** Kept on
   * the type because `TransferSummary` still carries it and the UI still
   * renders it; see `classifyTransfer` for why the predicate stopped
   * consulting it.
   */
  stalled: boolean;
  peersConnected: number;
  /** When the peer count last fell to zero. Null if it never has. */
  lastPeerLeftAt: number | null;
  /**
   * Whether any progress event has ever been seen for this transfer.
   *
   * **no longer read by `classifyTransfer`**,
   * for the same reason `stalled` above is not — it is a statement about what
   * RN has been told so far, not about whether the transfer is over. It is
   * `false` for the whole pre-first-block phase of every download, so reading
   * it released exactly the downloads that most needed holding. See the
   * download branch for the full account.
   *
   * Kept on the type because `TransferSummary` carries it
   * (`src/state/types.ts`), `transferStall.ts` still reads it, and the
   * received-row status text still renders from it. Optional so a fixture may
   * omit it; nothing here distinguishes `false` from absent any more.
   */
  progressEverReceived?: boolean;
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

/**
 * the WRITE side of `lastPeerLeftAt`.
 *
 * `classifyTransfer` below is the only reader of that field; until this sprint
 * the three writers were three separate inline ternaries in
 * `src/state/backend.ts` — the `peer-connected`, `peer-disconnected` and
 * `download-peer-disconnected` handlers. That file imports react-native, so
 * jest cannot reach any of them, and the rule this module exists to enforce
 * (`transferActivity.ts:2-7`: one question, one place, or the halves drift)
 * was being enforced for the read and not for the write.
 *
 * It had already drifted. **`peer-connected` wrote nothing at all**, so a
 * departure stamp outlived the departure: a sender that dropped and re-attached
 * left a `lastPeerLeftAt` sitting in the record, ageing, describing a peer who
 * had come back. The predicate survives that only because `peersConnected > 0`
 * is checked first; anything that consults the stamp while a peer is attached
 * reads a lie, and the grace arithmetic in `msUntilActivityCouldChange` is
 * exactly such a consumer.
 *
 * So: a peer is attached ⇒ there is no pending departure ⇒ the stamp is null.
 * Otherwise the falling-edge rule the disconnect handlers already had (Sprint
 * 8A): stamp only when the count reaches zero from above, never on two-to-one,
 * or peer churn would extend the window indefinitely.
 *
 * This is not a new rule — it is the rule the OTHER realm has been following
 * all along. `backend/hyperdrive-engine.mjs:1035-1040` clears its own
 * `tracker.lastPeerLeftAt` on the rising edge, with the same reasoning in the
 * comment above it ("a peer is attached, so there is no idle period to
 * expire"). The two realms keep independent copies of this timestamp, and only
 * RN's was stale. What follows is the engine's rule, written down where RN's
 * predicate can be tested against it.
 *
 * `prevPeerIdCount` is carried separately from `prevPeersConnected` because the
 * `download-peer-disconnected` handler tested both — the two are kept in sync by
 * every writer, and passing both keeps this a faithful extraction rather than a
 * tightening smuggled in beside one.
 */
export function nextLastPeerLeftAt(args: {
  /** `peersConnected` BEFORE this event. */
  prevPeersConnected: number;
  /** `peerIds.length` BEFORE this event. */
  prevPeerIdCount: number;
  /** `peersConnected` AFTER this event. */
  nextPeersConnected: number;
  /** The stamp currently on the record. */
  prevLastPeerLeftAt: number | null;
  /** Now, in ms — the stamp to write on a falling edge. */
  at: number;
}): number | null {
  // A peer is attached right now. Whatever departure this stamp described is
  // over, and leaving it set records a peer who came back as one who left.
  if (args.nextPeersConnected > 0) return null;

  // The falling edge: zero, reached from above.
  if (args.prevPeersConnected > 0 || args.prevPeerIdCount > 0) return args.at;

  // Still zero, and was zero. Nothing left, so nothing to stamp — and an
  // existing stamp must not be refreshed, or a second event about the same
  // departure would restart the window.
  return args.prevLastPeerLeftAt;
}

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
    /**
     * The download branch runs on evidence about the transfer, never on RN's
     * own state. `stalled` is the RN watchdog's verdict, taken well inside the
     * engine's per-file wait, and releasing the service is what lets the OS
     * freeze the process that was about to receive the rest; `stalled` also
     * never clears for a download that received no progress event, so that
     * shape had no reachable release at all. What replaces them is what the
     * upload branch already runs on: an engine-observed peer, and an
     * engine-observed departure.
     */

    // Terminal here, unlike on a hosted drive: nothing re-opens a finished
    // download. (The hosted inversion is the tripwire above, and is why this
    // check may not be hoisted out of the branch.)
    if (t.completed) return null;

    // POSITIVE evidence, checked first and symmetric with `upload`: a sender
    // is attached to this drive right now.
    if (t.peersConnected > 0) return "download";

    // No sender attached. The engine has to have SAID so — an unstamped
    // `lastPeerLeftAt` means no departure was ever observed, which is the
    // seconds-old pre-connect window of a grab that has just started. There
    // is no evidence of an ending, so hold: a wrong release here is the
    // eight-sprint regression, a wrong hold costs one background window that
    // the next event re-evaluates.
    if (t.lastPeerLeftAt === null) return "download";

    const sinceLeft = now - t.lastPeerLeftAt;
    // A stamp in the future is a clock that moved, not a transfer that ended.
    // Fail towards holding — the hosted branch fails the other way because
    // its wrong answer costs a permanent notification, this one costs a
    // killed download.
    if (sinceLeft < 0) return "download";

    /**
     * There is deliberately no shortcut on `progressEverReceived`. It is
     * `false` for the entire pre-first-block phase of every download, so
     * releasing the service on it would release on the state every download
     * starts in, and a process with no foreground service need not be let
     * back to receive the rest. A departure is evidence and still releases,
     * but on the one clock, never instantly.
     */

    // The sender is gone: the same reconnect allowance the hosted side gets,
    // on the same clock, then release.
    return sinceLeft < IDLE_HOST_GRACE_MS ? "download" : null;
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
 * What the foreground service should do right now. A transfer that starts
 * while the app is already backgrounded must acquire the service too, so the
 * start and the stop are two halves of one pair read from one function: the
 * two halves drifting apart is how a service is held forever.
 *
 * The caller re-runs this on every `transfers` change, and transfer changes
 * are engine events, which are alive while backgrounded where timer-driven
 * code is not. So the start needs no clock and no wake-up. This answers only
 * for the instant it is called.
 */
export type ServiceTransition = "start" | "stop" | "none";

export function decideServiceTransition(args: {
  /** Is the app in the foreground right now? */
  appActive: boolean;
  /** Did this background window already start the service? */
  serviceStartedForWindow: boolean;
  transfers: readonly TransferActivityInput[];
  now: number;
}): ServiceTransition {
  // Foreground needs no service, but the release is NOT this function's to
  // order: the resume handler already stops it unconditionally, on purpose,
  // because the OS may have stopped it behind our back and "we think it is
  // not running" is not a reason to skip the call. Returning "stop" here
  // would duplicate that and make a foreground transfer change emit a stop
  // per event.
  if (args.appActive) return "none";

  const active = isTransferActive(args.transfers, args.now);
  if (active && !args.serviceStartedForWindow) return "start";
  if (!active && args.serviceStartedForWindow) return "stop";
  return "none";
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
 *
 * This arms nothing. Nothing in RN schedules the window: the worklet emits
 * `host-idle-grace-elapsed` and RN re-runs the predicate on that event. This
 * is a description a log line can carry, not a schedule.
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
