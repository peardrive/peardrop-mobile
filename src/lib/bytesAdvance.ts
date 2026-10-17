// When a transfer's byte figure last rose: the engine re-emits every second, so `lastEventAt` stays fresh on a dead peer.

/** The byte figures an event may carry. Both are optional on the wire. */
export type BytesAdvanceEvent = {
  readonly totalSentBytes?: number;
  readonly bytesTransferred?: number;
};

/** The previous row. `lastBytesAt` is carried forward when nothing rose. */
export type BytesAdvancePrev = {
  readonly totalSentBytes?: number;
  readonly bytesTransferred?: number;
  readonly lastBytesAt?: number | null;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The larger of the two figures, or null when neither is usable. The receive side fills
 * `bytesTransferred` and the host side `totalSentBytes`, and one handler serves both. */
export function byteFigureOf(
  source: BytesAdvanceEvent | BytesAdvancePrev | null | undefined
): number | null {
  if (!source) return null;
  const sent = finite(source.totalSentBytes);
  const moved = finite(source.bytesTransferred);
  if (sent === null && moved === null) return null;
  return Math.max(sent ?? 0, moved ?? 0);
}

/** `now` if a figure rose, else the previous stamp. A first reading above zero counts,
 * so the stamp does not wait for a second event; equal or lower means no new bytes. */
export function bytesAdvanceAt(
  event: BytesAdvanceEvent | null | undefined,
  prev: BytesAdvancePrev | null | undefined,
  now: number = Date.now()
): number | null {
  const next = byteFigureOf(event);
  if (next === null) return prev?.lastBytesAt ?? null;
  const before = byteFigureOf(prev);
  if (before === null) return next > 0 ? now : (prev?.lastBytesAt ?? null);
  return next > before ? now : (prev?.lastBytesAt ?? null);
}
