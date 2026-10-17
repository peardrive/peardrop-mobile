/** A live-session refusal is not a failure: the engine is saying the work is already in hand. */
// No status write, no error, no toast — the running session owns the row's status and its progress events move it.

/** The engine's cause for "one is already running for this drive". */
export const LIVE_SESSION_CAUSE = "already-downloading";

/** The minimum of a `DownloadResult` this has to read. */
export type DownloadReplyLike = {
  readonly ok?: boolean;
  readonly error?: unknown;
  readonly files?: readonly unknown[] | null;
};

export type DownloadCallOutcome =
  /** Files came back. The caller proceeds as normal. */
  | "ok"
  /** A session for this drive is already running. Do nothing: no status write, no error, no toast, because the running session owns the row. */
  | "live-session"
  /** Anything else. The caller's existing failure handling applies. */
  | "failed";

/** Pull a cause off whatever shape the engine's error arrived in. */
function causeOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const e = error as { cause?: unknown; error?: unknown };
  if (typeof e.cause === "string") return e.cause;
  // One level of nesting, because the RPC boundary has wrapped the engine's error in an envelope before now.
  if (e.error && typeof e.error === "object") {
    const inner = e.error as { cause?: unknown };
    if (typeof inner.cause === "string") return inner.cause;
  }
  return "";
}

/** Is this reply the single-flight guard refusing a duplicate? Matched on the cause, never the message, because the message is user-facing text that may be reworded. */
export function isLiveSessionRefusal(reply: DownloadReplyLike | null | undefined): boolean {
  if (!reply) return false;
  if (reply.ok === true) return false;
  return causeOf(reply.error) === LIVE_SESSION_CAUSE;
}

/** What a caller should do with a download reply. */
// The refusal is checked before the success test, and the order is the point: it arrives as a failure with no files, which is indistinguishable from a failed grab to any check that looks at those two fields first.
export function downloadCallOutcome(
  reply: DownloadReplyLike | null | undefined,
): DownloadCallOutcome {
  if (isLiveSessionRefusal(reply)) return "live-session";
  if (reply?.ok === true && (reply.files?.length ?? 0) >= 0) return "ok";
  return "failed";
}
