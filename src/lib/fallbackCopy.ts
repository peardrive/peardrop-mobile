/**
 * What to say when the foreground service has failed on this device, and
 * where to send the user. Pure and import-free so the prompt and the Settings
 * row read from one source; two copies drift, and the failure mode is a user
 * hunting a list of every app for a control that is not on that screen. The
 * copy must not promise a fix, and must not alarm.
 */

export type FallbackBrand = "xiaomi" | "samsung" | "generic";

export type FallbackCopy = {
  /** Prompt title. */
  title: string;
  /** Prompt body. */
  body: string;
  /** Settings row subtitle, the only part of the row that varies. It names
   *  the setting and the brand, because every destination is a global list
   *  rather than PearDrop's own page. */
  rowSubtitle: string;
};

/** One label for every manufacturer. Deliberately names no mechanism —
 *  Autostart, battery and sleeping apps are all brand-specific and belong in
 *  the subtitle, and a label naming one would be wrong on the other two.
 *  Framed as a repair, because the row appears only after a real failure. */
export const FALLBACK_ROW_LABEL = "Stop your phone pausing PearDrop";

/** One icon for every manufacturer, and deliberately not a battery: a battery
 *  glyph would be wrong on Xiaomi, where the row opens Autostart. A pulse
 *  reads as "keep running", which is what the row is for everywhere. */
export const FALLBACK_ROW_ICON = "pulse-outline";

const CONFIRM = "Open settings";
const CANCEL = "Not now";

export const FALLBACK_CONFIRM_LABEL = CONFIRM;
export const FALLBACK_CANCEL_LABEL = CANCEL;

/** Xiaomi goes to Autostart, not the battery screen — measured, not assumed.
 *  With the battery restriction removed and no service the device still
 *  stalled, so battery is the weakest lever there, and sending a Xiaomi user
 *  to that screen sends them somewhere already known not to help. */
const XIAOMI: FallbackCopy = {
  title: "Your phone keeps stopping PearDrop",
  body:
    "PearDrop tried to keep transfers running in the background, and this " +
    "phone stopped it anyway.\n\n" +
    "Turning on Autostart for PearDrop usually fixes it. It's in the list " +
    "that opens.",
  rowSubtitle: "Opens Autostart. Find PearDrop in the list and turn it on.",
};

/** Samsung goes to the "Unmonitored apps" allowlist. Both components in that
 *  ladder launched on every device measured; the candidate community lists
 *  put first exists on none of them. */
const SAMSUNG: FallbackCopy = {
  title: "Your phone keeps stopping PearDrop",
  body:
    "PearDrop tried to keep transfers running in the background, and this " +
    "phone stopped it anyway.\n\n" +
    "Adding PearDrop to the apps your phone doesn't put to sleep usually " +
    "fixes it. It's in the list that opens.",
  rowSubtitle:
    "Opens Samsung's battery settings. Add PearDrop to the apps that " +
    "aren't put to sleep.",
};

/** Everything else. Untested, so the copy is deliberately vaguer about what
 *  the user will find rather than naming a control that may not be there. */
const GENERIC: FallbackCopy = {
  title: "Your phone keeps stopping PearDrop",
  body:
    "PearDrop tried to keep transfers running in the background, and this " +
    "phone stopped it anyway.\n\n" +
    "Allowing PearDrop to run without battery restrictions usually fixes it.",
  rowSubtitle:
    "Opens your phone's battery settings. Allow PearDrop to run without " +
    "restrictions.",
};

export function fallbackCopyFor(brand: FallbackBrand): FallbackCopy {
  if (brand === "xiaomi") return XIAOMI;
  if (brand === "samsung") return SAMSUNG;
  return GENERIC;
}
