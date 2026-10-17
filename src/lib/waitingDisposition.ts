/** Which resolve failures mean the sender was not there, and which stay ordinary errors: one branch saves a row and keeps looking, the other does not. */
// Wrong in either direction costs: a malformed link saved as a row is looked up forever, and an absent sender shown as an error is the defect being removed. Pure and import-free.

export type ResolveFailureKind =
  /** Nobody answered. Save the row and keep looking. */
  | "no-peer"
  /** The link itself is wrong. No row — there is nothing to look up. */
  | "invalid-link"
  /** Something on this device is wrong. A row would not help. */
  | "local"
  /** The user stopped it. No row, no error. */
  | "cancelled"
  /** Unrecognised. Treated as an ordinary error, never as a saved row. */
  | "other";

/** The engine causes, by what they mean for a waiting row. Anything absent is
 * `other`, so an unrecognised failure never becomes a row looked up for a week. */
const BY_CAUSE: Record<string, ResolveFailureKind> = {
  "receive-no-manifest": "no-peer",
  "receive-open-fail": "no-peer",
  "peer-not-found": "no-peer",
  "invalid-link": "invalid-link",
  "manifest-unavailable": "local",
  "not-initialized": "local",
  "open-cancelled": "cancelled",
  "transfer-cancelled": "cancelled",
};

export const RESOLVE_FAILURE_KINDS: Readonly<Record<string, ResolveFailureKind>> = BY_CAUSE;

export type ResolveFailureInput = {
  /** The engine's machine-readable cause, via `errorCause`. */
  readonly cause?: string | null;
  /** RN's own 30 s timeout fired. No cause exists for this. */
  readonly timedOut?: boolean;
  /** `classifyResolve`'s verdict when the resolve returned ok with no usable
   * manifest: the sender's head arrived and its content did not. */
  readonly verdict?: "usable" | "no-manifest";
};

export function classifyResolveFailure(input: ResolveFailureInput): ResolveFailureKind {
  // Checked first, with no cause to compete with: nothing answered at all,
  // which is the clearest absent sender there is.
  if (input.timedOut === true) return "no-peer";
  if (input.verdict === "no-manifest") return "no-peer";
  const cause = typeof input.cause === "string" ? input.cause : "";
  return BY_CAUSE[cause] ?? "other";
}

/** Only this kind creates or keeps a waiting row. */
export function savesWaitingRow(kind: ResolveFailureKind): boolean {
  return kind === "no-peer";
}

/** Grab-time causes, which the resolve table does not contain. A download has
 * its own ways of finding nobody there. */
const BY_GRAB_CAUSE: Record<string, ResolveFailureKind> = {
  "session-not-found": "no-peer",
  "peer-not-found": "no-peer",
  "receive-no-manifest": "no-peer",
  "no-files-selected": "other",
  "already-downloading": "other",
};

export const GRAB_FAILURE_KINDS: Readonly<Record<string, ResolveFailureKind>> =
  BY_GRAB_CAUSE;

/** A per-file cause that means the bytes never came. On its own it says nothing
 * about why; the peer count is what separates an absent sender from a bad link. */
export const STALL_CAUSE = "file-stall";

export type GrabFailureInput = {
  /** The engine's top-level cause, when the call failed outright. */
  readonly cause?: string | null;
  /** The per-file causes. A grab whose every file stalled returns success with no files and no top-level error, which is why reading the top-level cause alone classified it as an ordinary failure. */
  readonly fileCauses?: readonly (string | null | undefined)[];
  /** Peers attached to this drive when the grab gave up. */
  readonly peersConnected?: number;
};

/** Whether a failed grab is an absent sender, which queues it, or a real error. */
// A stall counts as absent only with no peers attached: the same timeout with a peer there is a slow or broken link, and queueing that would hide a fault behind a wait the sender cannot end.
export function classifyGrabFailure(input: GrabFailureInput): ResolveFailureKind {
  const cause = typeof input.cause === "string" ? input.cause : "";
  const known = BY_GRAB_CAUSE[cause] ?? BY_CAUSE[cause];
  if (known) return known;

  const peers =
    typeof input.peersConnected === "number" && Number.isFinite(input.peersConnected)
      ? input.peersConnected
      : 0;
  const stalled = (input.fileCauses ?? []).some((c) => c === STALL_CAUSE);
  if (stalled && peers <= 0) return "no-peer";
  if (stalled) return "other";

  // No cause the table knows and no stall: an unrecognised failure stays a real
  // error rather than becoming a row looked up for a week.
  return "other";
}

/** What a link-only row is called before the share has ever resolved: a few hex of the key, because the bare word cannot tell two rows apart. */
// Replaced the moment the share resolves, and it invents no name the sender never sent.
export function waitingRowName(shareKey: string): string {
  const key = String(shareKey || "")
    .trim()
    .toLowerCase();
  const short = key.slice(0, 6);
  // A key too short to shorten is not a key. Falling back to the bare word
  // keeps this from rendering a trailing separator with nothing after it.
  return /^[a-f0-9]{6}$/.test(short) ? `Share · ${short}` : "Share";
}

/** Shown when a link is saved instead of resolved. */
export const WAITING_SAVED_TOAST = "Saved. We'll keep looking for the sender.";

/** Shown when a grab is stored against a sender who is not reachable. */
export const WAITING_QUEUED_TOAST =
  "Saved. Your files will download when the sender is back.";

export function senderAvailableToast(shareName: string): string {
  const name = String(shareName || "").trim() || "Share";
  return `${name} is available. Choose files.`;
}

export function resumedToast(shareName: string): string {
  const name = String(shareName || "").trim() || "Share";
  return `Resumed: ${name}`;
}
