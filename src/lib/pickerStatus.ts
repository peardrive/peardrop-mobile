/** The one thing the picker says about finding the sender and starting a grab. */
// It carried five indicators and three could speak at once; one status means no second surface can contradict it.
import { RESOLVE_HINT_FIRST_MS, RESOLVE_HINT_SECOND_MS } from "./resolveHint";
import type { LinkNoticeTone } from "./resolveNotice";

export type PickerStatusState =
  /** Discovery is running. Grab is disabled. */
  | "looking"
  /** A peer served the manifest. Grab is live once something is picked. */
  | "found"
  /** A grab is in flight: the button spinner is the whole message. */
  | "starting"
  /** A real failure, already ruled out as an absent sender. */
  | "error"
  /** Settled with no manifest. The slot offers a retry. */
  | "notFoundYet"
  /** Something answered and could not be read. */
  | "unreadable";

export type PickerStatusInput = {
  /** An openLink RPC is in flight. */
  resolving: boolean;
  /** Non-null once the manifest arrived — proof a peer served us. */
  sessionDriveId: string | null;
  /** A download RPC is in flight for this picker. */
  grabbing: boolean;
  /** A grab failed for a reason that is not an absent sender: a missing peer never reaches here, because it queues the selection and closes the picker. */
  grabFailed: boolean;
  /** Tone of the current link notice, if any. */
  noticeTone: LinkNoticeTone | null;
  /** Milliseconds since the picker opened. */
  elapsedMs: number;
};

export const PICKER_STATUS_COPY = {
  looking: "Looking for the sender…",
  lookingFirst: "Still looking for the sender…",
  lookingSecond: "Still looking. The first connection can take a little longer.",
  found: "Sender found. Choose files.",
  /** The spinner is the message. Any text here would be a second one. */
  starting: "",
  error: "Couldn't start the download. Try again.",
  notFoundYet: "No sender found yet — tap Look again.",
  unreadable: "Couldn't read what's in this share yet — tap Look again.",
  /** Grab's label while a lookup is running. Disabled, but still the slot. */
  grabLabelWaiting: "Waiting for the sender…",
  /** Takes Grab's slot once the lookup has settled with nothing. */
  grabLabelLookAgain: "Look again",
} as const;

/** Same staged thresholds as the Receive sheet, so the two waits read alike. */
function lookingCopy(elapsedMs: number): string {
  // Validate at the boundary: NaN >= 5_000 is false, which would read as
  // "not long enough yet" instead of "this value is garbage".
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return PICKER_STATUS_COPY.looking;
  if (elapsedMs >= RESOLVE_HINT_SECOND_MS) return PICKER_STATUS_COPY.lookingSecond;
  if (elapsedMs >= RESOLVE_HINT_FIRST_MS) return PICKER_STATUS_COPY.lookingFirst;
  return PICKER_STATUS_COPY.looking;
}

/** Exactly one state, by a fixed precedence: a grab in flight outranks everything because it is the most recent thing the user did, and a failure outranks the found line it would otherwise sit beside. */
export function pickerStatus(input: PickerStatusInput): {
  state: PickerStatusState;
  text: string;
} {
  if (input.grabbing) {
    return { state: "starting", text: PICKER_STATUS_COPY.starting };
  }
  if (input.grabFailed) {
    return { state: "error", text: PICKER_STATUS_COPY.error };
  }
  // Having been served is a fact, not an inference, so it outranks a stale
  // wait notice from an earlier attempt.
  if (input.sessionDriveId) {
    return { state: "found", text: PICKER_STATUS_COPY.found };
  }
  if (input.resolving) {
    return { state: "looking", text: lookingCopy(input.elapsedMs) };
  }
  // A settled wait notice with no manifest is "something answered and could
  // not be read", not "nothing answered".
  if (input.noticeTone === "wait") {
    return { state: "unreadable", text: PICKER_STATUS_COPY.unreadable };
  }
  return { state: "notFoundYet", text: PICKER_STATUS_COPY.notFoundYet };
}
