/** The lifecycle state a stored row plus its live transfer amount to: the reducer owns transitions, this owns the reading. */
// So the row, the picker header and its file rows cannot disagree about what state the share is in.

import { rowProgress, type ProgressFile } from "./rowProgress";
import {
  PAUSE_REASONS,
  initialRowLifecycle,
  type PauseReason,
  type FileNote,
  type RowLifecycleState,
} from "./rowLifecycle";
import type { WaitingStatus } from "./waitingStatus";

export type ShareLike = {
  readonly status: WaitingStatus;
  readonly selection?: readonly string[];
  readonly missing?: readonly string[];
  readonly files: readonly ProgressFile[];
  readonly pauseReason?: string;
  readonly stallRetries?: number;
};

export type TransferLike = {
  /** The engine's `bytesFromPeers` for the attempt in flight. */
  readonly bytesFromPeers?: number | null;
  readonly bytesTransferred?: number | null;
};

/** Validated against the reducer's own exported list, not a copy of it. */
// The local copy this replaces had been mangled by a rename sweep into a duplicate and a missing entry, which would have silently downgraded one pause reason to another on every read.
function asReason(raw: unknown): PauseReason | null {
  return typeof raw === "string" && (PAUSE_REASONS as readonly string[]).includes(raw)
    ? (raw as PauseReason)
    : null;
}

/** Build the state. A missing file becomes a per-file note rather than a row line of its own, so the row says only that it is paused with a short reason. */
// The pause reason falls back for a record written before the field existed, which is the honest default: it is the reason the waiting loop exists and needs no information an older record never carried.
export function rowLifecycleFromShare(
  share: ShareLike,
  transfer?: TransferLike | null,
): RowLifecycleState {
  const selection = share.selection ?? [];
  const fileNotes: Record<string, FileNote> = {};
  for (const gone of share.missing ?? []) fileNotes[gone] = "gone";

  const progress = rowProgress({
    files: share.files,
    selection,
    // `bytesFromPeers`, not `bytesTransferred`: the latter includes what is already counted as held, double-counting every finished file.
    bytesThisAttempt: transfer?.bytesFromPeers ?? 0,
  });

  const stored = asReason(share.pauseReason);
  const pauseReason: PauseReason | null =
    share.status === "paused"
      ? // A missing file outranks a stored generic reason, for the reason the
        // reducer gives: it names something the user or the host can act on.
        ((share.missing ?? []).length > 0 ? "filesGone" : (stored ?? "senderOffline"))
      : null;

  return initialRowLifecycle({
    status: share.status,
    selection: [...selection],
    pauseReason,
    pct: share.status === "done" ? 100 : progress.pct,
    filesDone: share.status === "done" && progress.filesDone === 0
      ? selection.length
      : progress.filesDone,
    fileNotes,
    stallRetries:
      typeof share.stallRetries === "number" && Number.isFinite(share.stallRetries)
        ? Math.max(0, Math.floor(share.stallRetries))
        : 0,
  });
}
