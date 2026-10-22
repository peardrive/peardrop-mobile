/** Whether a share arriving from the share sheet may be applied now, and the slot it waits in. */
// The rule `incomingLinkQueue` applies to links: never swap what the user is looking at.

import type { ShareIntakeDropped, ShareIntakeFile } from "./shareIntakePayload";

export type ShareIntakeDecision =
  /** Nothing is in the way — hand it to the naming step now. */
  | { action: "apply"; shareId: string }
  /** Something is on screen or in flight. Hold it, and say so. */
  | { action: "hold"; shareId: string; notice: string }
  /** Already holding this share. Say nothing; it is already waiting. */
  | { action: "already-held"; shareId: string };

export type ShareIntakeBusy = {
  /** The naming step is open, or a picker is. Published by the screen that owns them. */
  readonly screenBusy: boolean;
  readonly previewVisible: boolean;
  readonly downloadBusy: boolean;
  readonly resolving: boolean;
  readonly heldShareId: string | null;
};

export function isShareIntakeBusy(
  state: Omit<ShareIntakeBusy, "heldShareId">,
): boolean {
  return (
    state.screenBusy || state.previewVisible || state.downloadBusy || state.resolving
  );
}

export function decideShareIntake(
  shareId: string,
  state: ShareIntakeBusy,
): ShareIntakeDecision {
  const incoming = String(shareId || "").trim();
  if (!incoming) return { action: "already-held", shareId: "" };
  if (!isShareIntakeBusy(state)) return { action: "apply", shareId: incoming };
  if (state.heldShareId === incoming) return { action: "already-held", shareId: incoming };
  return {
    action: "hold",
    shareId: incoming,
    notice: state.heldShareId
      ? "Saved the newer files — you'll see them when this finishes."
      : "Saved those files — you'll see them when this finishes.",
  };
}

/** Not "what do I do with this arrival" but "is the user free yet". */
export function shouldDrainShareIntake(state: ShareIntakeBusy): boolean {
  return !!state.heldShareId && !isShareIntakeBusy(state);
}

export type ShareHandoff = {
  readonly shareId: string;
  readonly files: ShareIntakeFile[];
  readonly dropped: ShareIntakeDropped[];
};

/** The one slot between the bridge, which decides, and the screen, which owns the naming step. */
let handoff: ShareHandoff | null = null;
let screenBusy = false;
const handoffListeners = new Set<(next: ShareHandoff) => void>();
const busyListeners = new Set<(busy: boolean) => void>();

/** Published by the screen, which the bridge cannot see. It NOTIFIES as well as stores: a module
 *  variable changing re-runs no effect, so a held share would otherwise sit there for ever. */
export function setShareScreenBusy(busy: boolean): void {
  if (screenBusy === busy) return;
  screenBusy = busy;
  for (const listener of Array.from(busyListeners)) {
    try {
      listener(busy);
    } catch {
      // One bad subscriber must not strand the rest.
    }
  }
}

export function subscribeShareScreenBusy(listener: (busy: boolean) => void): () => void {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}

export function isShareScreenBusy(): boolean {
  return screenBusy;
}

export function publishShareHandoff(next: ShareHandoff): void {
  handoff = next;
  for (const listener of Array.from(handoffListeners)) {
    try {
      listener(next);
    } catch {
      // One bad subscriber must not strand the slot.
    }
  }
}

export function subscribeShareHandoff(
  listener: (next: ShareHandoff) => void,
): () => void {
  handoffListeners.add(listener);
  if (handoff) {
    try {
      listener(handoff);
    } catch {
      // see publishShareHandoff
    }
  }
  return () => {
    handoffListeners.delete(listener);
  };
}

/** Clear the slot. Called by the screen once it has parked the selection. */
export function clearShareHandoff(shareId: string): void {
  if (handoff?.shareId === shareId) handoff = null;
}

/** Reset module state. Test-only. */
export function resetShareIntakeQueue(): void {
  handoff = null;
  screenBusy = false;
  handoffListeners.clear();
  busyListeners.clear();
}
