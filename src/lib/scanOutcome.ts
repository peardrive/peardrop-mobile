import { parseIncomingShareLink } from "./links";

/**
 * What a scanned QR actually was; a non-PearDrop code must not flash success and then do nothing.
 * One message per rejection class, because `bad-key-charset` leaks parser internals the user cannot act on.
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

  // `"reason" in parsed` rather than relying on `parsed.ok` to narrow: ts-jest runs `strict: false`,
  // and without strictNullChecks a boolean-literal discriminant does not narrow. `in` is structural.
  const reason = "reason" in parsed ? parsed.reason : undefined;

  // Only `not-a-peardrop-link` is worth separating — true, actionable, and overwhelmingly common.
  // Every other reason collapses to one message, exactly as the deep-link path does.
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
