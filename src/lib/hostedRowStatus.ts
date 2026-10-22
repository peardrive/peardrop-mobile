/**
 * A cancelled hosted row must read as cancelled rather than fall past `transferring` to `completed`.
 * No react-native imports: jest runs this under `testEnvironment: "node"`.
 */

import { cancelledRowLabel, clampReceivePercent } from "./receiveProgress";

/** Minimal shape read off a `TransferSummary`. */
export type HostedTransferLike = {
  percent: number | null;
  completed: boolean;
  /**
   * Required for the same reason it is required on `ReceiveTransferLike`:
   * the defect was a deriver that structurally could not see this field.
   */
  cancelled: boolean;
};

export type HostedRowState =
  | "idle"
  | "sharing"
  | "cancelled"
  | "completed"
  | "active";

export type HostedRowStatus = {
  state: HostedRowState;
  /** Rendered after the `<Type> · ` prefix the row already builds. */
  label: string;
  tone: "warning" | "primary" | "danger" | "muted";
};

/**
 * Maps a hosted transfer plus its activation onto a row status. `state: "idle"` means render
 * nothing — the caller drops the sub-line and falls back to the row's `meta`.
 */
export function hostedRowStatus(
  transfer: HostedTransferLike | null | undefined,
  opts: { isActive: boolean },
): HostedRowStatus {
  const t = transfer ?? null;

  // FIRST, ahead of everything: `markCancelled` writes `completed: true` alongside `cancelled`, so
  // this branch placed below `completed` is unreachable code that looks like a fix.
  if (t?.cancelled) {
    return { state: "cancelled", label: cancelledRowLabel(null), tone: "muted" };
  }

  // Same guard as the chain this replaces: strictly between 0 and 100, and
  // not yet complete. `percent >= 100` is excluded on purpose — a hosted
  // drive's byte counter is unreliable (UDX sockets expose no
  // `bytesWritten`), so a pinned 100 is not evidence of anything.
  const raw = t?.percent ?? 0;
  if (t && !t.completed && raw > 0 && raw < 100) {
    return {
      state: "sharing",
      label: `Sharing (${clampReceivePercent(raw)}%)`,
      tone: "warning",
    };
  }

  if (t?.completed) {
    return { state: "completed", label: "Completed", tone: "primary" };
  }

  if (opts.isActive) {
    return { state: "active", label: "Active", tone: "primary" };
  }

  return { state: "idle", label: "", tone: "muted" };
}
