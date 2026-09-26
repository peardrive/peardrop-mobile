import type { ToastKind } from "./toastKind";

/**
 * The re-share decision for a received share, and every word it says. A
 * hydrated received copy is `active` while announcing nothing, so the gates
 * key off the swarm mode rather than the row. `activate`'s `serve` is a
 * tri-state and this module never produces the absent case. Stop sharing is
 * `serve: false`, not `deactivate`, which would leave the persisted intent to
 * re-announce at the next launch. A live `activate` reply wins when present.
 */

/** The three swarm modes `activate` can report. Mirrors `DriveSwarmMode`. */
export type ReshareMode = "server" | "client" | "none";

/**
 * The toast kinds a re-share outcome can carry.
 *
 * `Extract` rather than `ToastKind` itself, and that is the point:
 * `MainScreen`'s `showToast` wrapper (`src/screens/MainScreen.tsx:761-765`)
 * accepts only these three, so declaring the wider `ToastKind` here made every
 * call site a `TS2345` on `"warning"` — a kind this module never emits and that
 * surface cannot render. Narrowing the producer is the fix; widening the
 * wrapper would have added a state nothing asked for.
 *
 * Deriving it from `ToastKind` rather than retyping the union keeps the
 * relationship checked: if `ToastKind` ever loses one of the three, this stops
 * compiling instead of silently diverging.
 */
export type ReshareTone = Extract<ToastKind, "info" | "success" | "error">;

// ---------------------------------------------------------------------------
// Copy. One owner per sentence.
// ---------------------------------------------------------------------------

/**
 * The disabled Share control's entire explanation, and also the toast when the
 * engine refuses a `serve: true` with `serveRefused: "incomplete"`.
 *
 * ONE constant for both on purpose: the control and the refusal are the same
 * fact stated at two moments, and two literals agree only until someone edits
 * one of them — the argument `cancelledRowLabel` already won in
 * `src/lib/receiveProgress.ts:340-350`.
 *
 * It says what happened and never why anything on the far side is or is not
 * reachable. `scripts/check-copy.mjs` is the gate on that.
 */
export const RESHARE_INCOMPLETE_HINT = "Finish downloading to share it.";

/** Confirmation that this phone is now announcing the received copy. */
export const RESHARE_STARTED_TEXT =
  "Sharing this copy — anyone with the link can grab it.";

/** Confirmation that it has stopped. */
export const RESHARE_STOPPED_TEXT = "Stopped sharing this copy.";

/**
 * The fallback when a start did not end with the phone announcing.
 *
 * Deliberately says only what happened. The app cannot observe why, and the
 * refusal case — the one cause it CAN name — has its own sentence above.
 */
export const RESHARE_START_FAILED_TEXT = "Couldn't start sharing that one.";

/** The same, for the other direction. */
export const RESHARE_STOP_FAILED_TEXT = "Couldn't stop sharing that one.";

/** The enabled/disabled Share control's label. */
export const RESHARE_SHARE_LABEL = "Share";

/** The Stop control's label. */
export const RESHARE_STOP_LABEL = "Stop sharing";

// ---------------------------------------------------------------------------
// Is it announcing?
// ---------------------------------------------------------------------------

/**
 * Everything the decision reads. Structural rather than an import of
 * `DriveRow` / `DriveRecord`, so this module stays free of `src/state/types.ts`
 * and therefore of react-native.
 */
export type ReshareSignals = {
  /** `"received"` enables the control. Anything else gets `kind: "none"`. */
  origin?: string | null;
  /**
   * Every file in the share's manifest is held on this device — i.e.
   * `describeHoldings(share.files).allHeld`. The caller passes the predicate
   * rather than the files so there is one implementation of "complete".
   */
  complete: boolean;
  /**
   * The ENGINE `driveId` backing this share (contract C-4, persisted on
   * `ReceivedShare`). `null` when the app has never learned one — the row's own
   * `share:<shareKey>` id is not a driveId and `engineActivateDrive` answers
   * `drive-not-found` for it, a string `check-copy.mjs` now bans outright.
   */
  driveId?: string | null;
  /**
   * `engineListDrives`' persisted re-share intent (contract C-2). **Not "is it
   * announcing"** — see the header.
   */
  reshared?: boolean | null;
  /** The engine has a live, non-failed session for this share. */
  sessionUp?: boolean | null;
  /**
   * `mode` from the most recent `activate` reply THIS session, or `null` when
   * this session has not called it. A live reading and the only one that can
   * contradict the persisted pair.
   */
  observedMode?: ReshareMode | null;
};

/**
 * Is this phone announcing the received share right now?
 *
 * Precedence, and the order is the substance:
 *
 *  1. **A live `activate` reply wins, in both directions.** `mode === "client"`
 *     from a real call means client-only however hopeful the stored flag is.
 *  2. Otherwise the boot rule's own two inputs — `reshared` AND `complete` —
 *     plus a live session, because the rule cannot have run for a drive that
 *     failed to hydrate.
 *
 * Never `active`. A hydrated received drive is active and announces nothing.
 */
export function receivedShareIsAnnouncing(s: ReshareSignals): boolean {
  if (s.observedMode) return s.observedMode === "server";
  return s.reshared === true && s.complete === true && s.sessionUp === true;
}

// ---------------------------------------------------------------------------
// Which control?
// ---------------------------------------------------------------------------

export type ReshareControl = {
  /** `"none"` renders nothing at all. */
  kind: "none" | "share" | "stop";
  label: string;
  enabled: boolean;
  /** The one sentence a disabled control carries. `null` when enabled. */
  disabledReason: string | null;
};

const NO_CONTROL: ReshareControl = {
  kind: "none",
  label: "",
  enabled: false,
  disabledReason: null,
};

/**
 * The control a received row gets.
 *
 * Clause order is load-bearing:
 *
 *  - **Not received → nothing.** Hosted rows keep Start sharing / Stop sharing
 *    exactly as they were; this module has no opinion about them.
 *  - **Announcing → Stop sharing.** Ahead of the completeness clause, because a
 *    copy can be announcing and then have a file removed under it, and offering
 *    a disabled Share to someone currently serving would be nonsense.
 *  - **Incomplete → Share, DISABLED, with the hint.** A received copy can only
 *    be shared on once it is complete, and the control stays visible so it can
 *    say why it cannot be used. A hidden control teaches nothing.
 *  - **No driveId → nothing.** Below the incomplete clause on purpose. An
 *    incomplete share is the case the user most needs explained, and the
 *    explanation does not require a driveId; an enabled button does, because
 *    without one the only reachable outcome is the engine's `drive-not-found`.
 */
export function reshareControl(s: ReshareSignals): ReshareControl {
  if (s.origin !== "received") return NO_CONTROL;
  if (receivedShareIsAnnouncing(s)) {
    return {
      kind: "stop",
      label: RESHARE_STOP_LABEL,
      enabled: true,
      disabledReason: null,
    };
  }
  if (s.complete !== true) {
    return {
      kind: "share",
      label: RESHARE_SHARE_LABEL,
      enabled: false,
      disabledReason: RESHARE_INCOMPLETE_HINT,
    };
  }
  if (!s.driveId) return NO_CONTROL;
  return {
    kind: "share",
    label: RESHARE_SHARE_LABEL,
    enabled: true,
    disabledReason: null,
  };
}

// ---------------------------------------------------------------------------
// What happened?
// ---------------------------------------------------------------------------

/** The fields of `DriveActivateResult` these readers consult. */
export type ReshareReply = {
  ok?: boolean;
  mode?: ReshareMode | null;
  serveRefused?: "incomplete" | null;
};

export type ReshareOutcome = {
  kind:
    | "announcing"
    | "refused-incomplete"
    | "not-announcing"
    | "stopped"
    | "not-stopped"
    | "failed";
  /** The post-call mode, defaulted to `"none"` when the reply omitted it. */
  mode: ReshareMode;
  /** What to show. On `"failed"` this is the FALLBACK for `userFacingError`. */
  text: string;
  tone: ReshareTone;
  /** Is the phone announcing after this call? What the gates are updated from. */
  announcing: boolean;
};

function replyMode(res: ReshareReply | null | undefined): ReshareMode {
  const m = res?.mode;
  return m === "server" || m === "client" || m === "none" ? m : "none";
}

/**
 * Read a `serve: true` reply.
 *
 * **`serveRefused` is consulted BEFORE `mode`, and that ordering is the whole
 * reason this function exists.** A refusal answers `mode: "client"`, and so
 * does a promotion that was attempted and failed — the engine says as much at
 * `backend/hyperdrive-engine.mjs:4382-4386`. A control that inferred the reason
 * from `mode` alone would tell a user whose transfer is 40% done that something
 * went wrong, and a user whose swarm genuinely failed that they should finish a
 * download that is already finished. Same shape as the `cancelled`-above-
 * `completed` ordering in `src/lib/receiveProgress.ts:197-215`.
 *
 * `ok: false` is checked first because a refusal still returns `ok: true` —
 * the drive WAS activated and only the announce was declined.
 */
export function reshareStartOutcome(
  res: ReshareReply | null | undefined,
): ReshareOutcome {
  const mode = replyMode(res);
  if (!res || res.ok !== true) {
    return {
      kind: "failed",
      mode,
      text: RESHARE_START_FAILED_TEXT,
      tone: "error",
      announcing: false,
    };
  }
  if (res.serveRefused === "incomplete") {
    return {
      kind: "refused-incomplete",
      mode,
      text: RESHARE_INCOMPLETE_HINT,
      // Not "error". The engine did exactly the right thing and the user asked
      // for something reasonable; there is nothing to apologise for, only
      // something to finish. Same reading `grabCompletionMessage` gives a
      // cancel (`src/lib/receiveProgress.ts:296-308`).
      tone: "info",
      announcing: false,
    };
  }
  if (mode === "server") {
    return {
      kind: "announcing",
      mode,
      text: RESHARE_STARTED_TEXT,
      tone: "success",
      announcing: true,
    };
  }
  return {
    kind: "not-announcing",
    mode,
    text: RESHARE_START_FAILED_TEXT,
    tone: "error",
    announcing: false,
  };
}

/**
 * Read a `serve: false` reply.
 *
 * `mode === "server"` after a stop is a stop that did not take, and it must not
 * report success — the gates would hide the link while the phone kept
 * announcing.
 */
export function reshareStopOutcome(
  res: ReshareReply | null | undefined,
): ReshareOutcome {
  const mode = replyMode(res);
  if (!res || res.ok !== true) {
    return {
      kind: "failed",
      mode,
      text: RESHARE_STOP_FAILED_TEXT,
      tone: "error",
      // Unknown, so the safe reading: keep offering the link rather than hide a
      // link that still resolves. `mode` is what the caller records.
      announcing: mode === "server",
    };
  }
  if (mode === "server") {
    return {
      kind: "not-stopped",
      mode,
      text: RESHARE_STOP_FAILED_TEXT,
      tone: "error",
      announcing: true,
    };
  }
  return {
    kind: "stopped",
    mode,
    text: RESHARE_STOPPED_TEXT,
    tone: "success",
    announcing: false,
  };
}
