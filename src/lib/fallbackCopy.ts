/**
 * what to say when the foreground service has failed on this
 * device, and where to send the user.
 *
 * Pure and import-free so the strings are testable and so the prompt and the
 * Settings row read from ONE source. Two copies would drift, and the failure
 * mode is specific: the user lands on a list of every app and is told to look
 * for a control that is not on that screen.
 *
 * ## What this copy must not do
 *
 * It must not promise a fix. The service already tried on this device and
 * failed three times — that is the only reason this text is reachable. The
 * honest framing is that the phone is stopping PearDrop and this setting
 * usually helps, not that changing it will work.
 *
 * It must also not alarm. The user has a working app that sometimes stops in
 * the background; that is a real problem and a small one, and the register
 * should match.
 */

export type FallbackBrand = "xiaomi" | "samsung" | "generic";

export type FallbackCopy = {
  /** Prompt title. */
  title: string;
  /** Prompt body. */
  body: string;
  /**
   * Settings row subtitle — THE ONLY PART OF THE ROW THAT VARIES.
   *
   * NAMES THE SETTING AND THE BRAND, because every destination is a global
   * list rather than PearDrop's own page — the user has to know what to look
   * for once they arrive. This is the 7B lesson.
   */
  rowSubtitle: string;
};

/**
 * One label for every manufacturer.
 *
 * The row names the same user-facing capability wherever it points, so it
 * reads the same. Deliberately names NO mechanism — not Autostart, not
 * battery, not sleeping apps — because all three are brand-specific and
 * belong in the subtitle. A label that named one would be wrong on the other
 * two destinations.
 *
 * Framed as a repair rather than a capability, unlike the row 7A/7B put here.
 * That one was always present and had to describe something the user might
 * want; this one appears only after the device has actually defeated the
 * foreground service, so "your phone is doing this to you" is the honest
 * register, and it matches the prompt's title.
 */
export const FALLBACK_ROW_LABEL = "Stop your phone pausing PearDrop";

/**
 * One icon for every manufacturer, and deliberately not a battery.
 *
 * A battery glyph would be wrong on Xiaomi, where the row opens Autostart —
 * the battery screen was measured to be the weakest lever on that platform.
 * A pulse reads as "keep running", which is what the row is for on all three.
 */
export const FALLBACK_ROW_ICON = "pulse-outline";

const CONFIRM = "Open settings";
const CANCEL = "Not now";

export const FALLBACK_CONFIRM_LABEL = CONFIRM;
export const FALLBACK_CANCEL_LABEL = CANCEL;

/**
 * Xiaomi goes to Autostart, not the battery screen — measured, not assumed.
 *
 * On 2026-09-13 with the battery restriction REMOVED and no service, the
 * Redmi still produced ten gaps over 20 s, a 115 s stall and a completion
 * 49 s late. The battery restriction was set to "restricted" throughout all
 * five clean Autostart runs of 2026-09-06/07. Battery is the weakest lever
 * on that platform, and sending a Xiaomi user there would send them to the
 * screen already known not to help.
 */
const XIAOMI: FallbackCopy = {
  title: "Your phone keeps stopping PearDrop",
  body:
    "PearDrop tried to keep transfers running in the background, and this " +
    "phone stopped it anyway.\n\n" +
    "Turning on Autostart for PearDrop usually fixes it. It's in the list " +
    "that opens.",
  rowSubtitle: "Opens Autostart. Find PearDrop in the list and turn it on.",
};

/**
 * Samsung goes to the "Unmonitored apps" allowlist. Both components in that
 * ladder launched on three devices across two One UI versions; the candidate
 * every community list puts first does not exist on any of them.
 */
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

/**
 * Everything else. Untested — no device outside Xiaomi and Samsung has ever
 * run this, so the copy is deliberately vaguer about what the user will find
 * rather than naming a control that may not be there.
 */
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
