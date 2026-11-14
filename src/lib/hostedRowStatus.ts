/**
 * Which of the universal states a share of this phone's own is in. The word, the colour and the
 * bar for each state come from Pearkit (`ShareState`), the same list the desktop app uses.
 * No react-native imports: jest runs this under `testEnvironment: "node"`.
 */

import type { ShareStateInput } from "../vendor/pearkit/ShareState/shareState";
import { clampReceivePercent } from "./receiveProgress";

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

/**
 * - Someone is taking the files right now: Sharing, with how far.
 * - Switched on: Active. A finished upload is Active again, not "Completed".
 * - Switched off: Inactive.
 */
export function hostedShareState(
  transfer: HostedTransferLike | null | undefined,
  opts: { isActive: boolean },
): ShareStateInput {
  const t = transfer ?? null;
  const resting: ShareStateInput = { kind: opts.isActive ? "active" : "inactive" };

  // FIRST, ahead of everything: `markCancelled` writes `completed: true` alongside `cancelled`,
  // and a stopped upload must never read as one that is still moving.
  if (t?.cancelled) return resting;

  // Strictly between 0 and 100, and not yet complete. `percent >= 100` is excluded on purpose: a
  // hosted drive's byte counter is unreliable (UDX sockets expose no `bytesWritten`), so a pinned
  // 100 is not evidence of anything.
  const raw = t?.percent ?? 0;
  if (t && !t.completed && raw > 0 && raw < 100) {
    return { kind: "sharing", percent: clampReceivePercent(raw) };
  }

  return resting;
}
