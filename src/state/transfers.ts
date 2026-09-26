import type {
  TransferDirection,
  TransferOrigin,
  TransferSummary,
} from "./types";

export const TRANSFERS_MAX = 80;

export function deriveDirection(origin: TransferOrigin): TransferDirection {
  if (origin === "hosted") return "upload";
  if (origin === "received") return "download";
  return "unknown";
}

export function baseTransfer(
  driveId: string,
  origin: TransferOrigin,
  now: number = Date.now()
): TransferSummary {
  return {
    driveId,
    origin,
    direction: deriveDirection(origin),
    percent: null,
    bytesTransferred: 0,
    totalBytes: null,
    driveSize: null,
    totalSentBytes: 0,
    peersConnected: 0,
    peerIds: [],
    completed: false,
    cancelled: false,
    // null, not 0. Nothing has been cancelled, so there
    // is no kept-count to report — and 0 would render as "nothing saved".
    filesKept: null,
    progressEverReceived: false,
    stalled: false,
    lastEventAt: now,
    // No peer has ever left a transfer that has just been created.
    lastPeerLeftAt: null,
  };
}

export type TransferUpdate =
  | Partial<TransferSummary>
  | ((prev: TransferSummary) => TransferSummary);

export type OriginResolver = (driveId: string) => TransferOrigin;

/**
 * Pure reducer over the transfers array, holding the origin resolution and
 * the per-driveId insert, update and cap bookkeeping in one place, free of
 * React so tests can drive it. An object patch is merged into the base; a
 * function hands the caller full control. Either way origin and direction
 * are re-asserted afterwards, so a dropped field cannot desync routing.
 */
export function upsertTransfer(
  transfers: TransferSummary[],
  driveId: string,
  update: TransferUpdate,
  originResolver: OriginResolver,
  now: number = Date.now()
): TransferSummary[] {
  if (!driveId) return transfers;

  const idx = transfers.findIndex((t) => t.driveId === driveId);
  const existing = idx >= 0 ? transfers[idx] : undefined;
  const origin = originResolver(driveId);
  const base: TransferSummary = existing ?? baseTransfer(driveId, origin, now);

  const resolvedOrigin: TransferOrigin =
    base.origin === "unknown" && origin !== "unknown" ? origin : base.origin;

  const nextItem =
    typeof update === "function"
      ? update(base)
      : {
          ...base,
          ...update,
          origin: resolvedOrigin,
          direction: deriveDirection(resolvedOrigin),
          lastEventAt: now,
        };

  const normalized: TransferSummary = {
    ...nextItem,
    origin: resolvedOrigin,
    direction: deriveDirection(resolvedOrigin),
  };

  if (idx < 0) return [normalized, ...transfers].slice(0, TRANSFERS_MAX);
  const clone = transfers.slice();
  clone[idx] = normalized;
  return clone;
}
