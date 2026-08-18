/**
 * Pure decision logic for what happens after the OS-native send-side picker
 * returns.
 *
 * The picker is system UI; all that's controllable is how its result is read.
 * There are exactly three outcomes — a selection came back, the user backed
 * out, or the picker returned nothing — and only the first proceeds into share
 * creation. Kept out of MainScreen so the cancel/empty contract is testable
 * without mounting React Native or the picker native modules.
 */

export type PickedFile = { name: string; size?: number; uri: string };

export type PickerOutcome =
  | { kind: "selected"; files: PickedFile[] }
  | { kind: "cancelled" }
  | { kind: "empty" };

/**
 * Classify a picker return.
 *
 * `canceled` is the modern expo result flag. Legacy / OEM result shapes
 * can omit it entirely, in which case an empty asset list is the only
 * signal available — we report "empty" rather than guessing at intent,
 * because "empty" and "cancelled" get different user-facing treatment.
 *
 * Assets without a `uri` are dropped: an asset we can't read is not a
 * selection, and letting one through produces a share of nothing.
 */
export function classifyPickerResult(
  canceled: boolean | undefined,
  files: PickedFile[] | null | undefined,
): PickerOutcome {
  if (canceled) return { kind: "cancelled" };
  const usable = (files ?? []).filter((f) => !!f && !!f.uri);
  if (!usable.length) return { kind: "empty" };
  return { kind: "selected", files: usable };
}

/**
 * What the screen must do for a given outcome.
 *
 * Expressed as data rather than inline branches so the load-bearing
 * invariant is directly assertable: every non-selected outcome restores
 * the surface the picker was launched from and never proceeds. That's the
 * "land back exactly where you'd be if you'd never opened the picker"
 * requirement, and it's the part that regressed.
 */
export type PickerExitPlan = {
  /** Reopen the Send sheet the picker was launched from. */
  reopenSendSheet: boolean;
  /** Toast text, or null for a silent return. */
  toast: string | null;
  /** Fire the one-time "how to back out of the picker" hint. */
  showBackHint: boolean;
  /** Continue into share creation with the returned files. */
  proceed: boolean;
};

export function pickerExitPlan(
  outcome: PickerOutcome,
  labels: { empty: string },
): PickerExitPlan {
  switch (outcome.kind) {
    case "selected":
      return {
        reopenSendSheet: false,
        toast: null,
        showBackHint: false,
        proceed: true,
      };
    case "cancelled":
      // A deliberate back-out is silent — no toast, no error. The only noise
      // is the one-time hint teaching the return gesture, for OEM pickers
      // that ship no visible back affordance.
      return {
        reopenSendSheet: true,
        toast: null,
        showBackHint: true,
        proceed: false,
      };
    case "empty":
      // Picker returned without a cancel signal and without assets. Rare,
      // and distinct enough from a deliberate back-out to say so plainly
      // instead of leaving the user wondering why nothing happened.
      return {
        reopenSendSheet: true,
        toast: labels.empty,
        showBackHint: false,
        proceed: false,
      };
  }
}

/**
 * Some pickers report a back-out by throwing instead of returning a
 * canceled result — expo-file-system's directory picker does, and so do
 * several OEM gallery activities. Message text is vendor- and
 * locale-dependent, so check the documented error codes first and only
 * fall back to a substring probe on the message.
 */
const CANCEL_CODES = new Set([
  "ERR_CANCELED",
  "ERR_CANCELLED",
  "E_PICKER_CANCELED",
  "E_PICKER_CANCELLED",
  "USER_CANCELED",
  "USER_CANCELLED",
  "ERR_DOCUMENT_PICKER_CANCELED",
]);

export function isPickerCancellation(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CANCEL_CODES.has(code.toUpperCase())) {
    return true;
  }
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  // Catches both spellings; deliberately broad because the alternative is
  // surfacing a red error toast on an ordinary back-out.
  return msg.includes("cancel");
}

/** Structural shape of an `expo-image-picker` asset — only what we read. */
export type ImageAssetLike = {
  uri?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
};

/**
 * Map image-picker assets onto the shared `PickedFile` shape.
 * `expo-image-picker` uses `fileName`/`fileSize` where the document
 * picker uses `name`/`size`, so the two paths can't share a mapper.
 *
 * `stamp` is passed in rather than read from `Date.now()` so the mapping
 * stays pure and the synthesized-name branch is testable.
 */
export function mapImageAssets(
  assets: ImageAssetLike[] | null | undefined,
  stamp: number,
): PickedFile[] {
  return (assets ?? [])
    .filter((a) => !!a?.uri)
    .map((a) => ({
      name:
        a.fileName ||
        (a.uri ? String(a.uri).split("/").pop() : null) ||
        `photo_${stamp}.jpg`,
      size: typeof a.fileSize === "number" ? a.fileSize : undefined,
      uri: String(a.uri),
    }));
}
