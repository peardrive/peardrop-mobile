/**
 * Decide whether an in-flight transfer has genuinely stalled.
 *
 * The RN-side watchdog runs on a 5 s `setInterval` and rules on transfers
 * that have gone quiet for 30 s. That interval is Choreographer-driven, so
 * Android halts it while the app is backgrounded — and on resume the very
 * first tick compared a stale `lastEventAt` against a fresh `now`. After any
 * background window longer than the threshold, EVERY in-flight transfer
 * looked stale: hosted ones were silently marked complete, received ones
 * silently marked stalled. Neither is evidence about the transfer. It is
 * evidence that the app was backgrounded, which on this platform is the
 * normal case — and it is the mechanism behind "it said Sent but nothing
 * arrived".
 *
 * The fix is `foregroundSince`: the watchdog may not rule until the app has
 * been continuously foregrounded for at least the stall threshold, so a
 * resume always restarts the clock. A backgrounded window can no longer
 * produce a verdict, while a genuine stall observed entirely in the
 * foreground still does.
 *
 * Chosen over re-stamping `lastEventAt` on resume because that field is also
 * the recency sort key for the Received list (`receivedFilesStorage`
 * consumers sort on it); rewriting it to satisfy the watchdog would reorder
 * the user's list as a side effect of backgrounding. A guard changes no
 * shared data.
 *
 * Pure by design — data in, verdict out, no React or React Native imports —
 * so jest.config.js can reach it, exactly like freezeDetect.ts.
 */

export type StallOrigin = "hosted" | "received" | "unknown";

export type StallInput = {
  /** Now, in ms. */
  now: number;
  /** When this transfer last produced an event, in ms. */
  lastEventAt: number;
  /** When the app most recently became foreground-active, in ms. */
  foregroundSince: number;
  completed: boolean;
  /** Whether any progress event has ever been seen for this transfer. */
  progressEverReceived: boolean;
  /** Whether it has already been marked stalled. */
  stalled: boolean;
  origin: StallOrigin;
  /** Quiet period after which a transfer is judged. */
  stallMs?: number;
};

export type StallVerdict =
  /** Leave it alone. */
  | "none"
  /** Hosted: the sender did its part; mark complete. */
  | "hosted-complete"
  /** Received: surface "couldn't finish" and let the user dismiss. */
  | "received-stalled";

/**
 * Thirty seconds. Long enough that ordinary gaps between engine events
 * don't trip it, short enough that a dead transfer resolves while the user
 * is still looking at it.
 */
export const DEFAULT_STALL_MS = 30_000;

export function evaluateStall(input: StallInput): StallVerdict {
  const {
    now,
    lastEventAt,
    foregroundSince,
    completed,
    progressEverReceived,
    stalled,
    origin,
    stallMs = DEFAULT_STALL_MS,
  } = input;

  if (completed) return "none";
  // Nothing has ever flowed, so there is no stall to detect — only a
  // transfer that has not started.
  if (!progressEverReceived) return "none";

  // The guard. Anything other than a full uninterrupted foreground window
  // means the quiet period may be an artifact of the app not running, and
  // the watchdog has no standing to rule.
  //
  // Non-finite `foregroundSince` is treated as "not yet foregrounded"
  // rather than as a pass, so a missing value fails closed.
  if (!Number.isFinite(foregroundSince)) return "none";
  if (now - foregroundSince < stallMs) return "none";

  if (now - lastEventAt < stallMs) return "none";

  if (origin === "hosted") return "hosted-complete";
  if (origin === "received" && !stalled) return "received-stalled";
  return "none";
}
