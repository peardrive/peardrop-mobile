/** Whether the picker may grab yet, and what its one action slot says. */
// Gated on the lookup state, not the session id, so the disabled button prevents a tap the engine would refuse anyway.
import { PICKER_STATUS_COPY, type PickerStatusState } from "./pickerStatus";

/** One slot, one button. "Look again" replaces Grab rather than joining it. */
export type PickerActionKind = "grab" | "lookAgain";

export type PickerGrabGate = {
  kind: PickerActionKind;
  /** What the slot reads. Empty is never correct. */
  label: string;
  /** The slot is tappable. */
  enabled: boolean;
  /** Draw a spinner in place of the label. */
  busy: boolean;
  /**
   * A grab may actually be initiated. The belt-and-braces guard at the top of
   * the press handler reads this, so a future layout change cannot re-create a
   * tappable button whose handler returns.
   */
  grabAllowed: boolean;
};

export type PickerGrabGateInput = {
  lookupState: PickerStatusState;
  downloadAllBusy: boolean;
  /** The found-state label, from `sharePreviewCopy.previewPrimaryLabel`. */
  grabLabel: string;
};

export function pickerGrabGate(input: PickerGrabGateInput): PickerGrabGate {
  // Settled with nothing to grab from: offer the retry instead. Both states
  // mean "no manifest, no resolve running" — they differ only in what the
  // status line says above.
  if (input.lookupState === "notFoundYet" || input.lookupState === "unreadable") {
    return {
      kind: "lookAgain",
      label: PICKER_STATUS_COPY.grabLabelLookAgain,
      enabled: true,
      busy: false,
      grabAllowed: false,
    };
  }

  // A grab is in flight: the spinner is the whole message, so the label is
  // irrelevant and a second tap must not reach the engine.
  if (input.lookupState === "starting") {
    return {
      kind: "grab",
      label: input.grabLabel,
      enabled: false,
      busy: true,
      grabAllowed: false,
    };
  }

  // A real failure keeps the selection and the live button: the whole point of
  // the error state is that trying again is the next sensible act.
  if (input.lookupState === "error") {
    return {
      kind: "grab",
      label: input.grabLabel,
      enabled: !input.downloadAllBusy,
      busy: input.downloadAllBusy,
      grabAllowed: !input.downloadAllBusy,
    };
  }

  // Still looking: keep Grab in the slot so nothing jumps, disabled, and say
  // what it is waiting for rather than inviting a tap that cannot work.
  if (input.lookupState !== "found") {
    return {
      kind: "grab",
      label: PICKER_STATUS_COPY.grabLabelWaiting,
      enabled: false,
      busy: false,
      grabAllowed: false,
    };
  }

  // The label is passed through, never rewritten: pluralisation and the byte
  // count belong to `sharePreviewCopy`.
  return {
    kind: "grab",
    label: input.grabLabel,
    enabled: !input.downloadAllBusy,
    busy: input.downloadAllBusy,
    grabAllowed: !input.downloadAllBusy,
  };
}
