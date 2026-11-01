/** Who gets told that a sender turned up, how often, and what the line says. Pure, so the throttle is assertable. */

/** At most one alert per share key in this window. A flapping sender is the case it exists for. */
export const SENDER_ALERT_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** One row whose sender has just answered. */
export type SenderAlertCandidate = {
  readonly shareKey: string;
  /** The share's name, for the single-row line. Empty falls back to a neutral one. */
  readonly shareName?: string;
  /** The row's own stored link, carried rather than rebuilt: one builder, one spelling. */
  readonly shareLink?: string;
};

/** Last alert per share key. Session-scoped: a restart may re-alert once, which is better than a store that outlives the share. */
export type SenderAlertState = Readonly<Record<string, number>>;

export const EMPTY_SENDER_ALERT_STATE: SenderAlertState = {};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether this key may alert now. An unparseable stamp reads as never alerted rather than as recent. */
export function alertAllowed(
  state: SenderAlertState,
  shareKey: string,
  now: number,
): boolean {
  const at = finite(state[shareKey]);
  if (at === null) return true;
  const since = now - at;
  // A stamp in the future is a clock that moved, and must not silence the key until it catches up.
  if (since < 0) return true;
  return since >= SENDER_ALERT_MIN_INTERVAL_MS;
}

export function recordAlerts(
  state: SenderAlertState,
  keys: readonly string[],
  now: number,
): SenderAlertState {
  const at = finite(now);
  if (at === null) return state;
  const next: Record<string, number> = { ...state };
  for (const key of keys) {
    if (typeof key === "string" && key) next[key] = at;
  }
  return next;
}

/** Drops the keys the throttle silences, keeping first-seen order. */
export function selectAlertable(
  candidates: readonly SenderAlertCandidate[],
  state: SenderAlertState,
  now: number,
): SenderAlertCandidate[] {
  const seen = new Set<string>();
  const out: SenderAlertCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate?.shareKey;
    if (typeof key !== "string" || !key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!alertAllowed(state, key, now)) continue;
    out.push(candidate);
  }
  return out;
}

export type SenderAlert = {
  readonly title: string;
  readonly body: string;
  /** The share to open on a tap, or null when the alert covers several. */
  readonly shareKey: string | null;
  /** The link the tap opens. Null for the coalesced alert, which opens the list. */
  readonly link: string | null;
};

/** One line for one sender, a count above that. Null when nothing survived the throttle. */
export function describeSenderAlert(
  candidates: readonly SenderAlertCandidate[],
): SenderAlert | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const one = candidates[0]!;
    const name = typeof one.shareName === "string" ? one.shareName.trim() : "";
    const link = typeof one.shareLink === "string" ? one.shareLink.trim() : "";
    return {
      title: name ? `${name} is available` : "A sender is available",
      body: "Tap to choose what to receive.",
      shareKey: one.shareKey,
      link: link || null,
    };
  }
  return {
    title: `${candidates.length} senders are available`,
    body: "Tap to see which ones.",
    shareKey: null,
    link: null,
  };
}

/**
 * A distinct notification identity per share key, which is what keeps one tap from opening
 * whichever share was alerted first. The coalesced alert has no key and takes a fixed id.
 */
export function senderAlertId(shareKey: string | null): string {
  return shareKey ? `sender-available:${shareKey}` : "sender-available:many";
}

/** What a tap on an available alert opens: its own share, or the list for the alert that names several. */
export function intentForAlertTap(
  identifier: unknown,
  link: unknown,
): { kind: "share-link" | "show-shares"; value: string } | null {
  if (typeof link === "string" && link.trim()) return { kind: "share-link", value: link.trim() };
  if (identifier === senderAlertId(null)) return { kind: "show-shares", value: "" };
  return null;
}
