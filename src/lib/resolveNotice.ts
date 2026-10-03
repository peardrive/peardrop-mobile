/**
 * tone-tagged link notices.
 *
 * The two NORMAL waits — "no sender found yet" and "sender still syncing" —
 * must not terminate in the same red styling as real failures. Every message
 * that lands in
 * `ShareLinkFlowContext.linkError` now carries a tone:
 *
 *  - `"wait"`  — nothing failed; the other pear just hasn't answered yet.
 *    Exactly two triggers qualify: the no-manifest rejection
 *    (`RESOLVE_NO_MANIFEST_MESSAGE`, whether raised RN-side by
 *    `rejectUnusableResolve` or engine-side through `runGuardedResolve`'s
 *    `onFailure` — two routes, one sentence, one tone) and the 30 s resolve
 *    timeout from `src/state/resolveGuard.ts`.
 *  - `"error"` — everything else: malformed link, engine error,
 *    ok-without-driveId, grab failure, generic throw.
 *
 * Surfaces render `"wait"` in `theme.muted` with an info icon (or an info
 * toast); `"error"` stays `theme.danger` exactly as before.
 *
 * This lives in `src/lib/` because a `.tsx` cannot be imported by jest in
 * this project, so both the tone decision and the copy are only testable
 * from here. Asserted in `src/lib/__tests__/resolveNotice.test.ts`.
 */

import { RESOLVE_NO_MANIFEST_MESSAGE } from "./resolveDisposition";

export type LinkNoticeTone = "wait" | "error";

export type LinkNotice = {
  text: string;
  tone: LinkNoticeTone;
  /**
   * What produced it. Four triggers share the `wait` tone, and the picker has
   * to suppress exactly ONE of them (`no-manifest`, now carried by the status
   * line) while still showing the other two, which have no other surface.
   * Tone is too coarse for that — gating on it rendered two messages red.
   */
  trigger: LinkNoticeTrigger;
};

/**
 * Shown (as an info toast, top level) when the 30 s resolve guard fires.
 *
 * Deliberately does NOT say "offline", "network" or "timed out" — the deny-list
 * in `resolveHint.test.ts` / `scripts/check-copy.mjs` bans all three, because
 * PearDrop has no connectivity detection and cannot tell "the host is offline"
 * from "DHT discovery is still running". Links never expire, so nothing here
 * may imply they do.
 */
export const RESOLVE_TIMEOUT_MESSAGE =
  "No sender found yet — try again in a moment.";

/**
 * Grab tapped before the manifest arrived. Shown in the preview's own banner,
 * not as a toast — a toast raised over an open modal cannot be tapped.
 */
export const STILL_RESOLVING_MESSAGE =
  "Still finding the sender — give it a moment.";

/** The partial-dedup acknowledgement, in the banner for the same reason. */
export const ALREADY_HELD_MESSAGE = "You already have some of these.";

/**
 * Every producer of a link notice, named for the event rather than the copy.
 * The tone decision keys on this, which is what makes it one-test-per-trigger
 * unit-testable.
 */
export type LinkNoticeTrigger =
  | "still-resolving"
  | "already-held"
  | "no-manifest"
  | "timeout"
  | "malformed"
  | "missing-drive-id"
  | "engine-error"
  | "grab-failure"
  | "generic-throw";

/** The tone rule: exactly the two normal-wait triggers are `"wait"`. */
export function linkNoticeToneFor(trigger: LinkNoticeTrigger): LinkNoticeTone {
  // The two in-preview notices join the wait set: neither is a failure, and
  // rendering either red would be the same red-for-normal-wait defect.
  return trigger === "no-manifest" ||
    trigger === "timeout" ||
    trigger === "still-resolving" ||
    trigger === "already-held"
    ? "wait"
    : "error";
}

/** Convenience constructor used at every `setLinkError` call site. */
export function linkNotice(trigger: LinkNoticeTrigger, text: string): LinkNotice {
  return { text, tone: linkNoticeToneFor(trigger), trigger };
}

/**
 * The `onFailure` route needs one more distinction: the engine's
 * `receive.no-manifest` rejection arrives through `runGuardedResolve`'s
 * `onFailure` carrying the SAME sentence as the RN-side guard
 * (`resolveDisposition.ts`: "Two routes, one sentence"). Rendering that
 * sentence muted on one route and red on the other would be incoherent, so the
 * match is on the message. Every other failure message is a real error.
 */
export function noticeForResolveFailure(message: string): LinkNotice {
  return message === RESOLVE_NO_MANIFEST_MESSAGE
    ? linkNotice("no-manifest", message)
    : linkNotice("engine-error", message);
}
