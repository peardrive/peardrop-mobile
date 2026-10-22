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

/** Whether the event's figure is higher than the row's; the stall verdict and the `lastBytesAt`
 *  stamp ask this same question, so neither decides for itself what "bytes moved" means. */
export function bytesAdvanced(
  event: BytesAdvanceEvent | null | undefined,
  prev: BytesAdvancePrev | null | undefined
): boolean {
  const next = byteFigureOf(event);
  if (next === null) return false;
  const before = byteFigureOf(prev);
  if (before === null) return next > 0;
  return next > before;
}

/** `now` if a figure rose, else the previous stamp. */
export function bytesAdvanceAt(
  event: BytesAdvanceEvent | null | undefined,
  prev: BytesAdvancePrev | null | undefined,
  now: number = Date.now()
): number | null {
  return bytesAdvanced(event, prev) ? now : (prev?.lastBytesAt ?? null);
}
