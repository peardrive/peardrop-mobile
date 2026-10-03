/**
 * Whether the picker may grab yet, and what its one action slot says.
 *
 * The reopen picker opens from disk with `sessionDriveId === null` on purpose
 * and resolves underneath itself. Grab was live in that window and the tap was
 * a **silent no-op**: `runDownload` returned at `if (!sessionDriveId)`, and
 * because a `wait` notice is normally already set by then, the inner
 * `if (!linkError)` swallowed even the apology. Nothing reached the engine —
 * it answers `receive.no-session` without a live session anyway — so disabling
 * the button removes nothing functional and replaces an apology with
 * prevention.
 *
 * Gated on `lookupState`, not on `sessionDriveId` directly, so the demo
 * session (`DEMO_DRIVE_ID`) is handled in one place: `pickerLookupStatus`
 * matches any non-null id.
 *
 * Here rather than inline in `SharePreviewModal.tsx` because `npm test`
 * renders no `.tsx` — a decision left in the component is a decision no test
 * can observe. Same reason `receivedRowRoute.ts` exists.
 */
import { PICKER_LOOKUP_COPY, type PickerLookupState } from "./pickerLookupStatus";

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
  lookupState: PickerLookupState;
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
      label: PICKER_LOOKUP_COPY.grabLabelLookAgain,
      enabled: true,
      busy: false,
      grabAllowed: false,
    };
  }

  // Still looking: keep Grab in the slot so nothing jumps, disabled, and say
  // what it is waiting for rather than inviting a tap that cannot work.
  if (input.lookupState !== "found") {
    return {
      kind: "grab",
      label: PICKER_LOOKUP_COPY.grabLabelWaiting,
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
