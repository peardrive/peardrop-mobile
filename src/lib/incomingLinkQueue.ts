/**
 * An incoming link never swaps what the user is looking at and is never silently dropped: it is
 * held with a `notice`. A repeat of the same link is absorbed, because Android re-delivers intents.
 */

export type IncomingLinkDecision =
  /** Nothing is in the way — resolve it now. */
  | { action: "resolve"; link: string }
  /** Something is on screen or in flight. Hold it, and say so. */
  | { action: "hold"; link: string; notice: string }
  /** Already holding exactly this link. Say nothing; it is already waiting. */
  | { action: "already-held"; link: string };

export type IncomingLinkState = {
  /** A preview modal is open. */
  previewVisible: boolean;
  /** A grab is in flight. */
  downloadBusy: boolean;
  /** A resolve is in flight. */
  resolving: boolean;
  /** The link already waiting, if any. */
  heldLink: string | null;
};

/** Is the user in the middle of something a new link would disturb? */
export function isBusy(state: Pick<IncomingLinkState, "previewVisible" | "downloadBusy" | "resolving">): boolean {
  return state.previewVisible || state.downloadBusy || state.resolving;
}

/** Pure: the caller owns the held slot and applies the decision, which is what makes it assertable. */
export function decideIncomingLink(
  link: string,
  state: IncomingLinkState,
): IncomingLinkDecision {
  const incoming = String(link || "").trim();
  if (!incoming) {
    // Nothing to hold and nothing to resolve. Reported as `already-held` with
    // an empty link so the caller has no branch that can act on it.
    return { action: "already-held", link: "" };
  }
  if (!isBusy(state)) return { action: "resolve", link: incoming };
  if (state.heldLink === incoming) return { action: "already-held", link: incoming };
  return {
    action: "hold",
    link: incoming,
    notice: state.heldLink
      ? "Saved the newer link — you'll see it when this finishes."
      : "Saved that link — you'll see it when this finishes.",
  };
}

/**
 * Is the held link ready to apply? A different question at a different moment from
 * `decideIncomingLink` — not "what do I do with this arrival" but "is the user free yet".
 */
export function shouldDrain(state: IncomingLinkState): boolean {
  return !!state.heldLink && !isBusy(state);
}
