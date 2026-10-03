/**
 * What the offline picker can honestly say about the sender.
 *
 * `openStoredSharePicker` paints the file list from disk and then fires
 * `void runResolve(...)` underneath it, so a reopened share is already looking
 * for the sender — there was no UI bound to it, and the modal sat
 * static for up to the engine's 25 s budget.
 *
 * The app has NO connectivity detection, so "not found yet" is the strongest
 * negative statement available: it cannot distinguish a sender that is offline
 * from discovery that is still running. Copy lives here, not in the `.tsx`, so
 * the deny-list test reaches it.
 */
import { RESOLVE_HINT_FIRST_MS, RESOLVE_HINT_SECOND_MS } from "./resolveHint";
import type { LinkNoticeTone } from "./resolveNotice";

export type PickerLookupState =
  | "looking"
  | "found"
  | "notFoundYet"
  | "unreadable";

export type PickerLookupInput = {
  /** An openLink RPC is in flight. */
  resolving: boolean;
  /** Non-null once the manifest arrived — proof a peer served us. */
  sessionDriveId: string | null;
  /**
   * Tone of the current link notice, if any. A `wait` notice with no manifest
   * and no resolve in flight means something came back that could not be read —
   * which is a different sentence from "nothing answered", and used to render
   * as a SECOND banner saying the same thing as this line.
   */
  noticeTone: LinkNoticeTone | null;
  /** Milliseconds since the picker opened. */
  elapsedMs: number;
};

export const PICKER_LOOKUP_COPY = {
  looking: "Looking for the sender…",
  lookingFirst: "Still looking for the sender…",
  lookingSecond: "Still looking. The first connection can take a little longer.",
  found: "Sender found — ready to grab.",
  // Grab is disabled here now; this points at the
  // control that does work.
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
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return PICKER_LOOKUP_COPY.looking;
  if (elapsedMs >= RESOLVE_HINT_SECOND_MS) return PICKER_LOOKUP_COPY.lookingSecond;
  if (elapsedMs >= RESOLVE_HINT_FIRST_MS) return PICKER_LOOKUP_COPY.lookingFirst;
  return PICKER_LOOKUP_COPY.looking;
}

export function pickerLookupStatus(input: PickerLookupInput): {
  state: PickerLookupState;
  text: string;
} {
  // The manifest outranks everything else, including a stale wait notice from
  // an earlier attempt: having been served is a fact, not an inference.
  if (input.sessionDriveId) {
    return { state: "found", text: PICKER_LOOKUP_COPY.found };
  }
  if (input.resolving) {
    return { state: "looking", text: lookingCopy(input.elapsedMs) };
  }
  // A settled `wait` notice with no manifest is "something answered and could
  // not be read", not "nothing answered". Saying so here is what lets the
  // modal drop the duplicate banner.
  if (input.noticeTone === "wait") {
    return { state: "unreadable", text: PICKER_LOOKUP_COPY.unreadable };
  }
  return { state: "notFoundYet", text: PICKER_LOOKUP_COPY.notFoundYet };
}
