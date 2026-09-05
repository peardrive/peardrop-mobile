import { Linking, Platform } from "react-native";
import * as IntentLauncher from "expo-intent-launcher";

import { log as debugLog } from "./debugLog";

/**
 * Open the screen where the user can allow this app to run in the background.
 *
 * There is no API to request this permission, so the best available action is
 * to land the user somewhere they can grant it themselves.
 *
 * Candidates are tried in order and EVERY one is wrapped, because OEM
 * activity names are undocumented, differ between versions, and vanish
 * without notice. A missing activity throws, and that must degrade to the
 * next candidate rather than crash. The final fallback is the app's own
 * details page, which exists on every Android device — so this function
 * always lands somewhere sensible even when every specific guess fails.
 *
 * Deliberately NOT attempted: reading or requesting the setting
 * programmatically, and any reflection into OEM internals.
 */

const PACKAGE = "com.peardrop.mobile";

type Candidate = {
  label: string;
  run: () => Promise<unknown>;
};

/**
 * Xiaomi's battery-restriction screens. Undocumented and version-dependent —
 * present on many HyperOS/MIUI builds, absent on others, and absent on every
 * non-Xiaomi device. Tried before the generic fallback only because they are
 * the exact screen the setting lives on when they do exist.
 */
const xiaomiCandidates: Candidate[] = [
  {
    /**
     * "Battery details" for one app: Battery saver → No restrictions /
     * Battery saver / Close after 10 min / Restrict. Exactly the screen the
     * prompt's copy describes.
     *
     * Launched by explicit component rather than via the AOSP
     * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS action, which MIUI does route
     * here (its filter carries priority 999) but which requires holding the
     * permission of the same name — a Play-policy-restricted permission this
     * app has no other reason to declare. The component is `exported=true`,
     * so a normal app can start it without one.
     *
     * Verified on HyperOS V816 (Redmi 25062RN2DA, Android 15):
     * `package_name` alone is enough; the screen resolves the right app.
     */
    label: "miui-power-detail",
    run: () =>
      IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
        // packageName + className become ComponentName(packageName,
        // className) natively, so they must stay separate — a single
        // "pkg/cls" string does not work.
        packageName: "com.miui.securitycenter",
        className: "com.miui.powercenter.legacypowerrank.PowerDetailActivity",
        extra: { package_name: PACKAGE },
      }),
  },
  {
    /**
     * Older MIUI's per-app battery screen. Kept below the one above because
     * it does NOT resolve on HyperOS V816 (measured: no matching component),
     * but it is still the right screen on builds where it exists.
     */
    label: "miui-power-keeper",
    run: () =>
      IntentLauncher.startActivityAsync("miui.intent.action.HIDDEN_APPS_CONFIG_ACTIVITY", {
        packageName: "com.miui.powerkeeper",
        extra: { package_name: PACKAGE, package_label: "PearDrop" },
      }),
  },
  // Deliberately NOT tried: miui.intent.action.APP_PERM_EDITOR. It resolves
  // on HyperOS and therefore wins, but it opens the app PERMISSIONS editor
  // (autostart, location) — not a battery screen at all, so the prompt's
  // "find PearDrop's battery setting" leads nowhere. A candidate that
  // succeeds at opening the wrong screen is worse than none, because it
  // shadows the generic fallback below, which does at least reach Battery.
];

/** Always present. The honest fallback: the user can reach Battery from here. */
const appDetails: Candidate = {
  label: "app-details",
  run: () => Linking.openSettings(),
};

/**
 * Try each candidate until one succeeds. Returns the label that worked, or
 * null if even the app-details fallback failed (which would mean something is
 * very wrong with the device, not with this code).
 */
export async function openBackgroundSettings(): Promise<string | null> {
  if (Platform.OS !== "android") return null;

  const isXiaomi = /xiaomi|redmi|poco/i.test(String(Platform.constants?.Manufacturer ?? ""));
  const candidates: Candidate[] = isXiaomi
    ? [...xiaomiCandidates, appDetails]
    : [appDetails];

  for (const candidate of candidates) {
    try {
      await candidate.run();
      debugLog("info", "rn.bgsettings", `opened via ${candidate.label}`);
      return candidate.label;
    } catch (err: unknown) {
      debugLog(
        "warn",
        "rn.bgsettings",
        `${candidate.label} unavailable — ${String((err as Error)?.message || err)}`
      );
    }
  }

  debugLog("error", "rn.bgsettings", "no settings screen could be opened");
  return null;
}
