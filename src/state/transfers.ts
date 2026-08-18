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
    progressEverReceived: false,
    stalled: false,
    lastEventAt: now,
  };
}

export type TransferUpdate =
  | Partial<TransferSummary>
  | ((prev: TransferSummary) => TransferSummary);

export type OriginResolver = (driveId: string) => TransferOrigin;

/**
 * Pure reducer: given the current transfers array and an update for a single
 * drive, return the new array. Centralizes the "known" origin resolution and
 * the per-driveId insert/update/cap bookkeeping. Kept backend-agnostic so
 * tests can drive it without mounting React.
 *
 * When `update` is an object patch, we merge it into the base and normalize
 * origin/direction from the resolver. When `update` is a function the caller
 * takes full control, but we still re-assert origin/direction after it runs
 * so a dropped field can't desync routing.
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
