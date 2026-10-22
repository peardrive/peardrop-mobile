/**
 * `startActivityAsync` resolves with `{resultCode}` even when the activity refused and finished at
 * once, so the judgement is elapsed time: a cancel arriving implausibly fast is the signal.
 */

/** `android.app.Activity.RESULT_CANCELED`. */
export const RESULT_CANCELED = 0;

/**
 * Below this, a `RESULT_CANCELED` means the target never presented UI. Raising it flags real
 * back-button opens as errors; lowering it misses genuine refusals.
 */
export const INSTANT_CANCEL_MS = 1000;

export type OpenAttempt = {
  /** What `startActivityAsync` resolved with. */
  resultCode: number;
  /** Wall-clock ms from launch to resolution. */
  elapsedMs: number;
  /** Lower-cased extension of the file, for a more specific message. */
  ext: string;
};

/**
 * The message to show the user, or null when the open looks genuine.
 *
 * Returning null is the common case and must stay the common case.
 */
export function describeOpenFailure(attempt: OpenAttempt): string | null {
  const { resultCode, elapsedMs, ext } = attempt;
  if (resultCode !== RESULT_CANCELED) return null;
  // A non-finite elapsed time means we cannot judge, and guessing "failed"
  // would put a false error in front of the user.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs >= INSTANT_CANCEL_MS) return null;

  if (ext === "apk") {
    // Named specifically: the generic line would send the user looking for a missing app, and no
    // app is missing — Android declined to install.
    return "Android wouldn't install this from PearDrop. Use Save to Downloads, then open the APK from your Files app.";
  }
  return "Nothing on this phone opened that file.";
}
