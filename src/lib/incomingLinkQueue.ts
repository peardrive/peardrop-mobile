/**
 * An incoming link must never swap what the user is already looking at, and
 * must never be silently dropped. With a preview open or a grab in flight the
 * link is held rather than applied, and every `queue` outcome carries a
 * `notice` so the user knows it is waiting. A second link replaces the held
 * one and says so; the same link arriving twice is absorbed, because Android
 * re-delivers intents on resume. The queue is in memory; a kill loses it.
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

/**
 * Decide what to do with a link that has just arrived.
 *
 * Pure: the caller owns the held slot and applies the decision. That is what
 * makes this assertable at all — `IncomingLinkBridge.tsx` is a `.tsx` and the
 * suite collects only `*.test.ts` (Amendment A-3).
 */
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
 * Is the held link ready to be applied?
 *
 * Separate from `decideIncomingLink` because it answers a different question at
 * a different moment: not *"what do I do with this arrival"* but *"is the user
 * free yet"*. The caller polls it as its own state settles.
 */
export function shouldDrain(state: IncomingLinkState): boolean {
  return !!state.heldLink && !isBusy(state);
}
