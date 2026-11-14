// The one live copy of the modal queue (see modalStack.ts for the rule and why iOS needs it).
// Kept apart from the React component so plain modules (opening a file, the pickers) can wait
// for the screen to be free without importing UI code.

import { Platform } from "react-native";
import { EMPTY_MODAL_STACK, dismissed, isSettled, type ModalStackState } from "./modalStack";

/** How long to wait for iOS to report a modal closed before assuming it has. */
const DISMISS_FALLBACK_MS = 900;

let state: ModalStackState = EMPTY_MODAL_STACK;
let nextId = 1;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function newModalId(): string {
  return `modal-${nextId++}`;
}

export function getModalStack(): ModalStackState {
  return state;
}

export function subscribeModalStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Apply a transition from modalStack.ts to the live queue. */
export function updateModalStack(change: (s: ModalStackState) => ModalStackState): void {
  const next = change(state);
  if (next === state) return;
  state = next;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (state.hiding && state.shown !== null) {
    // If the close report never arrives (the modal was unmounted, or never really appeared),
    // free the screen anyway so the next modal is not left waiting forever.
    const waitingFor = state.shown;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      updateModalStack((s) => dismissed(s, waitingFor));
    }, DISMISS_FALLBACK_MS);
  }
  for (const l of Array.from(listeners)) l();
}

/**
 * Resolves once no modal is in the middle of closing. Await it before opening anything iOS
 * presents itself (the share sheet, a file or photo picker) right after closing a modal:
 * iOS drops a presentation requested while another screen is still animating away.
 * Resolves at once on Android.
 */
export function whenModalsSettled(timeoutMs = 1500): Promise<void> {
  if (Platform.OS !== "ios") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    let giveUp: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      if (giveUp) clearTimeout(giveUp);
      resolve();
    };
    giveUp = setTimeout(finish, timeoutMs);
    // The close that led here has usually not reached the queue yet (React commits it after
    // the tap handler returns), so look only after the next frame or two.
    setTimeout(() => {
      if (done) return;
      if (isSettled(state)) {
        finish();
        return;
      }
      unsubscribe = subscribeModalStack(() => {
        if (isSettled(state)) finish();
      });
    }, 80);
  });
}
