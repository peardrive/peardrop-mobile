/**
 * pure decision logic for what happens after the OS-native
 * send-side picker returns.
 *
 * The picker itself is system UI we can't touch; everything we control is
 * how we read its result. There are exactly three outcomes — a selection
 * came back, the user backed out, or the picker returned with nothing —
 * and only the first should ever proceed into share creation. Extracted
 * here (rather than left as inline branches in MainScreen) so the
 * cancel/empty contract is unit-testable without mounting React Native or
 * the picker native modules. Same pure-module pattern as `format.ts` /
 * `links.ts`.
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
      // contract: a deliberate back-out is silent —
      // no toast, no error. The only noise is the one-time hint teaching
      // the return gesture, for the OEM pickers that ship no visible back
      // affordance.
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
  /** `'image' | 'video' | 'livePhoto' | 'pairedVideo'`, or null when the
   *  Android ContentProvider didn't say. */
  type?: string | null;
  mimeType?: string | null;
  /** Video length in ms; null for stills. A useful third signal when
   *  both `type` and `mimeType` come back empty. */
  duration?: number | null;
};

export type PickedAssetKind = "image" | "video";

/**
 * what kind of thing did the picker hand us?
 *
 * Three independent signals, because any one of them can be missing:
 * expo documents `type` as nullable ("rare but can happen with some
 * Android ContentProviders"), `mimeType` as optional, and `duration` as
 * null for stills. Checked in descending order of directness.
 *
 * Defaults to "image" only when nothing at all indicates video — this is
 * a photo picker, so image is the right prior for a total unknown.
 */
export function assetKind(asset: ImageAssetLike): PickedAssetKind {
  const declared = String(asset?.type ?? "").toLowerCase();
  if (declared === "video" || declared === "pairedvideo") return "video";
  if (declared === "image" || declared === "livephoto") return "image";

  const mime = String(asset?.mimeType ?? "").toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";

  if (typeof asset?.duration === "number" && asset.duration > 0) return "video";

  return "image";
}

/** MIME subtypes whose spelling differs from the extension we want. */
const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "video/3gpp": "3gp",
};

/**
 * Does this name already carry a usable extension?
 *
 * "Usable" means 1–8 trailing alphanumerics after a non-leading dot —
 * the same plausibility rule `truncateMiddle` uses in `files.ts`. A
 * content-URI basename like `1234` or `media%3A5567` has none, and
 * treating it as a filename is how a video ends up with no type at all
 * on the receiving device.
 */
export function hasUsableExtension(name: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(String(name || ""));
}

/**
 * Extension to use when we have to supply one.
 * Falls back to the kind's most common container.
 */
export function extensionForAsset(asset: ImageAssetLike): string {
  const mime = String(asset?.mimeType ?? "").toLowerCase();
  const mapped = MIME_EXTENSION[mime];
  if (mapped) return mapped;

  const subtype = mime.split("/")[1] ?? "";
  if (/^[a-z0-9]{1,8}$/.test(subtype)) return subtype;

  return assetKind(asset) === "video" ? "mp4" : "jpg";
}

/**
 * Map image-picker assets onto the shared `PickedFile` shape.
 * `expo-image-picker` uses `fileName`/`fileSize` where the document
 * picker uses `name`/`size`, so the two paths can't share a mapper.
 *
 * `stamp` is passed in rather than read from `Date.now()` so the mapping
 * stays pure and the synthesized-name branch is testable.
 *
 * ## Why the naming is this careful
 *
 * `fileName || uriBasename || photo_<stamp>.jpg` is harmless only while the
 * picker is locked to images. Once videos are allowed, both fallbacks are
 * actively wrong:
 *
 *   - The synthesized name hard-coded `.jpg`, so a video with no
 *     `fileName` shipped as a JPEG.
 *   - The URI basename is used **whenever it is truthy**, and a
 *     `content://` basename is frequently a bare numeric id with no
 *     extension at all — which wins over the synthesized name and
 *     produces a file with no type.
 *
 * The extension is not cosmetic here. It is the ONLY thing that travels
 * to the other device: `previewModeFor`, `fileIconName` and
 * `mimeFromName` all key off it, and `mimeFromName` feeds the
 * `ACTION_VIEW` intent. A video named `.jpg` arrives claiming to be a
 * picture, fails to preview, and opens as `image/jpeg` in whatever the
 * receiver uses for photos, which is a worse outcome than a missing video.
 *
 * So: keep a real filename, keep a URI basename only when it carries a
 * usable extension, and otherwise build the name from the asset's
 * actual kind.
 */
export function mapImageAssets(
  assets: ImageAssetLike[] | null | undefined,
  stamp: number,
): PickedFile[] {
  return (assets ?? [])
    .filter((a) => !!a?.uri)
    .map((a) => ({
      name: pickedAssetName(a, stamp),
      size: typeof a.fileSize === "number" ? a.fileSize : undefined,
      uri: String(a.uri),
    }));
}

/** Name for one asset. Exported for direct testing of the fallback ladder. */
export function pickedAssetName(asset: ImageAssetLike, stamp: number): string {
  const declaredName = String(asset?.fileName ?? "").trim();
  if (declaredName && hasUsableExtension(declaredName)) return declaredName;

  const uriPath = String(asset?.uri ?? "").split(/[?#]/)[0] ?? "";
  const uriBase = uriPath.split("/").pop();
  if (uriBase && hasUsableExtension(uriBase)) return uriBase;

  const kind = assetKind(asset);
  // Preserve a declared-but-extensionless name rather than discarding it
  // — the user recognizes their own filename.
  const stem = declaredName || `${kind === "video" ? "video" : "photo"}_${stamp}`;
  return `${stem}.${extensionForAsset(asset)}`;
}
