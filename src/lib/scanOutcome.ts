import { parseIncomingShareLink } from "./links";

/**
 * What a scanned QR code actually was. A scan that is not a PearDrop link must
 * not flash a success haptic and a "Got it" message and then do nothing.
 *
 * The deep-link path's model is reused rather than a second taxonomy invented:
 * one message for every rejection class, because the user cannot act on
 * `bad-key-charset` and naming it leaks parser internals, and the same strict
 * `parseIncomingShareLink`. A scan is retryable in place, unlike a deep link,
 * so `retryable` lets the sheet clear its latch and read the next code.
 *
 * Copy bans: no "check your network", no bare "network" or "offline", and no
 * claim that a link expired — links do not expire, and a scan that fails to
 * parse says nothing about connectivity the app never measured.
 */

export type ScanOutcome =
  /** A real PearDrop link. `link` is the normalized form to resolve. */
  | { kind: "accepted"; link: string }
  /**
   * Not a PearDrop link, or a damaged one. `message` is user-facing and
   * carries no parser internals.
   */
  | { kind: "rejected"; title: string; message: string };

/** What the QR said, and whether it is something this app can open. */
export function classifyScan(raw: unknown): ScanOutcome {
  const parsed = parseIncomingShareLink(raw);
  if (parsed.ok) return { kind: "accepted", link: parsed.link };

  // `"reason" in parsed` rather than relying on `parsed.ok` to have narrowed
  // the union. It has here, but the jest transform runs ts-jest with
  // `strict: false` while `tsconfig.json` is `strict: true`, and without
  // `strictNullChecks` a boolean-literal discriminant does NOT narrow — the
  // suite fails to compile while `tsc` is perfectly happy. An `in` check is
  // structural and behaves the same under both.
  const reason = "reason" in parsed ? parsed.reason : undefined;

  // `not-a-peardrop-link` is worth separating from the damaged classes — and
  // only that one. "This isn't a PearDrop code" is true, actionable, and the
  // overwhelmingly common case (any other QR in the world). Every remaining
  // reason collapses to the one message, exactly as the deep-link path does.
  if (reason === "not-a-peardrop-link" || reason === "empty") {
    return {
      kind: "rejected",
      title: "That's not a PearDrop code",
      message: "Point the camera at the QR code PearDrop showed the sender.",
    };
  }
  return {
    kind: "rejected",
    title: "That link looks damaged",
    message: "Ask whoever sent it to share the link again.",
  };
}
