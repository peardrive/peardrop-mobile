/**
 * Which OEM settings screens to try, in which order, for a given destination.
 *
 * Split out from openBackgroundSettings.ts so the ordering and the
 * manufacturer gate are unit-testable: that module imports react-native and
 * expo-intent-launcher, which jest.config.js (testEnvironment "node") cannot
 * load. Same division as freezeDetect.ts / transferStall.ts — decision here,
 * effects there.
 *
 * This is the source of truth for order. openBackgroundSettings.ts maps these
 * labels to runners, so a label that appears here and nowhere there is a
 * build-time type error rather than a silent gap.
 *
 * Whether an intent actually RESOLVES is device-only and untestable here.
 * Nothing in this file mocks that; the runtime ladder falls through to the
 * next candidate on failure and ends at the app-details screen, which exists
 * everywhere.
 */

export type LadderKind =
  /** Where the OS decides whether to throttle or freeze us. */
  | "battery"
  /** Xiaomi's Autostart permission — measured to be the actual gate. */
  | "autostart"
  /**
   * where to send a user whose device froze the app THREE TIMES
   * with the foreground service running. One destination per manufacturer,
   * each landing on a specific screen rather than a generic page.
   */
  | "fallback";

export type CandidateLabel =
  | "miui-power-detail"
  | "miui-power-keeper"
  | "miui-autostart-op"
  | "miui-autostart-management"
  /**
   * Both of these launched on three Samsung handsets across One UI 8.0 and
   * 8.5, and `dumpsys` confirmed both exist and are exported on all three.
   *
   * Deliberately NOT included: `com.samsung.android.sm.ui.battery.BatteryActivity`
   * — the candidate AutoStarter's README and every community gist list FIRST
   * for Samsung — which is absent from both packages on all three devices.
   * Nor the legacy `com.samsung.android.sm` package, which is installed but
   * carries none of the three activities.
   */
  | "samsung-battery-checkable"
  | "samsung-battery-ui"
  /** AOSP's system-wide battery-optimization list. Needs no permission. */
  | "aosp-battery-optimization"
  | "app-details";

/**
 * Xiaomi's sub-brands ship the same MIUI/HyperOS security centre. Matched on
 * `Platform.constants.Manufacturer`, which is `Build.MANUFACTURER` — lowercase
 * on some builds, capitalised on others, hence the case-insensitive test.
 */
export function isXiaomiManufacturer(
  manufacturer: string | null | undefined
): boolean {
  return /xiaomi|redmi|poco/i.test(String(manufacturer ?? ""));
}

/**
 * The ladder for a destination on a given device.
 *
 * Always ends with `app-details`, which resolves on every Android device, so
 * the caller can never be left with nowhere to send the user. On non-Xiaomi
 * devices that is the entire ladder: there is no known per-app autostart
 * concept to aim at, and guessing at other OEMs' undocumented activities
 * would risk landing on the wrong screen, which is worse than the generic one.
 */
/**
 * Samsung ships the same Device Care package across One UI versions. Matched
 * on `Build.MANUFACTURER`, which reads "samsung" (lowercase) on every device
 * measured. Other implementations dispatch on `Build.BRAND` instead; on every
 * Samsung measured both fields agree, so a rebranded handset would be needed
 * to settle the choice.
 */
export function isSamsungManufacturer(
  manufacturer: string | null | undefined
): boolean {
  return /samsung/i.test(String(manufacturer ?? ""));
}

export function ladderFor(
  kind: LadderKind,
  manufacturer: string | null | undefined
): CandidateLabel[] {
  if (kind === "fallback") {
    // Xiaomi goes to Autostart, not the battery screen: removing the battery
    // restriction was measured not to help there, so the battery page is the
    // screen known not to help. Delegated, not restated — writing the rungs
    // out again here would let a future change reach only one of the two.
    if (isXiaomiManufacturer(manufacturer)) {
      return ladderFor("autostart", manufacturer);
    }
    if (isSamsungManufacturer(manufacturer)) {
      return ["samsung-battery-checkable", "samsung-battery-ui", "app-details"];
    }
    // Untested everywhere else. The AOSP list exists on every device and is
    // at least the right KIND of screen, which is more than a guess at an
    // OEM activity would be.
    return ["aosp-battery-optimization", "app-details"];
  }
  if (!isXiaomiManufacturer(manufacturer)) return ["app-details"];
  if (kind === "autostart") {
    // Both rungs land on the same "Background autostart" screen; they differ
    // only in how they name it. The implicit action survives the class being
    // renamed or moved, the explicit component survives the action being
    // renamed, and neither is a superset of the other — hence both.
    return ["miui-autostart-op", "miui-autostart-management", "app-details"];
  }
  return ["miui-power-detail", "miui-power-keeper", "app-details"];
}
