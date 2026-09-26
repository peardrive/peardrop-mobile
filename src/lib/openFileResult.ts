/**
 * Deciding whether an `ACTION_VIEW` launch actually did anything.
 * `IntentLauncher.startActivityAsync` resolves with `{ resultCode }` even when
 * the activity refused and finished at once, so a refusal is indistinguishable
 * from success to code that ignores it. `RESULT_CANCELED` alone is not failure
 * — a viewer dismissed with the back button returns it too — so the judgement
 * is elapsed time: a cancel that arrives implausibly fast is the signal. The
 * heuristic is biased toward silence rather than a wrong error toast.
 */

/** `android.app.Activity.RESULT_CANCELED`. */
export const RESULT_CANCELED = 0;

/**
 * Below this, a `RESULT_CANCELED` means the target never presented UI.
 *
 * Not a timeout and not a latency budget — see the header. Raising it starts
 * flagging real "user glanced and pressed back" opens as errors; lowering it
 * starts missing genuine refusals.
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
    // Named specifically because the generic line would send the user looking
    // for a missing app, and no app is missing — Android declined to install.
    //
    // this used to say "Use Save a copy", a menu item that no
    // longer exists under that name — 9G renamed it, so the message was
    // directing users to a label they could not find. It now names "Save to
    // Downloads", which is both a real menu item and the better route: it
    // puts the APK in a folder the file manager can open directly, and the
    // file manager is the thing that holds the install permission PearDrop
    // deliberately does not request.
    return "Android wouldn't install this from PearDrop. Use Save to Downloads, then open the APK from your Files app.";
  }
  return "Nothing on this phone opened that file.";
}
