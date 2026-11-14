// iOS shows one full-screen layer per view controller. React Native's <Modal> asks the screen's
// controller to present it; if that controller is already presenting another modal, iOS refuses
// ("Attempt to present … which is already presenting …") and React Native still believes the
// modal is up. The modal that was refused never appears, and once the first one closes the whole
// screen stops taking touches. Android gives every modal its own window, so nothing shows there.
//
// The rule that keeps iOS safe: at most ONE top-level modal is on screen, and the next one is
// only presented after the previous one has finished closing. This module is that rule as a
// pure state machine; `src/ui/AppModal.tsx` wires it to the real <Modal>.

export type ModalStackState = {
  /** Modals that want to be open, oldest first. The last one is the one the user should see. */
  stack: readonly string[];
  /** The modal that holds the screen right now, including while it is closing. */
  shown: string | null;
  /** True while `shown` is on its way out; nothing else may be presented until it has gone. */
  hiding: boolean;
};

export const EMPTY_MODAL_STACK: ModalStackState = { stack: [], shown: null, hiding: false };

function top(state: ModalStackState): string | null {
  return state.stack[state.stack.length - 1] ?? null;
}

/** Apply the rule: a modal that is not on top starts closing; a free screen goes to the top one. */
function settle(state: ModalStackState): ModalStackState {
  const want = top(state);
  if (state.shown === null) {
    return want === null ? state : { ...state, shown: want, hiding: false };
  }
  if (!state.hiding && state.shown !== want) return { ...state, hiding: true };
  return state;
}

/** A modal asks to be open. Asking again while already asked changes nothing. */
export function requestOpen(state: ModalStackState, id: string): ModalStackState {
  if (state.stack.includes(id)) return state;
  return settle({ ...state, stack: [...state.stack, id] });
}

/** A modal no longer wants to be open (closed by the user, or unmounted). */
export function requestClose(state: ModalStackState, id: string): ModalStackState {
  if (!state.stack.includes(id)) return state;
  return settle({ ...state, stack: state.stack.filter((x) => x !== id) });
}

/** iOS reports that `id` has finished closing (or the safety timer gave up waiting). */
export function dismissed(state: ModalStackState, id: string): ModalStackState {
  if (state.shown !== id || !state.hiding) return state;
  return settle({ ...state, shown: null, hiding: false });
}

/** Whether `id` should be handed to the native modal as visible right now. */
export function isPresented(state: ModalStackState, id: string): boolean {
  return state.shown === id && !state.hiding;
}

/** True when nothing is in the middle of closing, so native UI (share sheet, pickers) is safe. */
export function isSettled(state: ModalStackState): boolean {
  return !state.hiding;
}
