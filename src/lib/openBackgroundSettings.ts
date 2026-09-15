import { Linking, Platform } from "react-native";
import * as IntentLauncher from "expo-intent-launcher";

import { log as debugLog } from "./debugLog";
import {
  isSamsungManufacturer,
  isXiaomiManufacturer,
  ladderFor,
  type CandidateLabel,
  type LadderKind,
} from "./settingsLadder";

/**
 * Open the screen where the user can let this app keep running in the
 * background. Two destinations, two entry points:
 *
 *   openAutostartSettings()   — Xiaomi's Autostart permission
 *   openBackgroundSettings()  — the battery-restriction screen
 *
 * They are separate functions on purpose. Measurements on 2026-09-06/07
 * (five runs, battery restriction ON throughout, Autostart the only variable)
 * found Autostart to be the gate: with it granted the worklet ticked every
 * 2 s across a ten-minute background window; without it the process froze
 * 60-89% of the window. The battery screen is still the right destination on
 * every non-Xiaomi device and still a useful secondary on Xiaomi, so it stays
 * exactly as it was.
 *
 * There is no API to request either permission, and no API to read whether it
 * was granted, so the best available action is to land the user somewhere they
 * can grant it themselves.
 *
 * Candidates are tried in order and EVERY one is wrapped, because OEM
 * activity names are undocumented, differ between versions, and vanish
 * without notice. A missing activity throws, and that must degrade to the
 * next candidate rather than crash. The final fallback is the app's own
 * details page, which exists on every Android device — so both functions
 * always land somewhere sensible even when every specific guess fails.
 *
 * Deliberately NOT attempted: reading or requesting either setting
 * programmatically, and any reflection into OEM internals. Autostart state in
 * particular cannot be inferred behaviourally either — measured freeze onset
 * ranges from 2.6 s to 88.3 s, so a short observation window can look
 * identical whether or not the permission is held.
 */

const PACKAGE = "com.peardrop.mobile";

/**
 * One runner per label in settingsLadder.ts. The Record is exhaustive by
 * type, so adding a label to the ladder without adding a runner here fails
 * to compile rather than silently skipping a rung.
 */
const RUNNERS: Record<CandidateLabel, () => Promise<unknown>> = {
  /**
   * "Battery details" for one app: Battery saver → No restrictions /
   * Battery saver / Close after 10 min / Restrict.
   *
   * Launched by explicit component rather than via the AOSP
   * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS action, which MIUI does route here
   * (its filter carries priority 999) but which requires holding the
   * permission of the same name — a Play-policy-restricted permission this
   * app has no other reason to declare. The component is `exported=true`, so
   * a normal app can start it without one.
   *
   * Verified on HyperOS V816 (Redmi 25062RN2DA, Android 15) 2026-09-02:
   * `package_name` alone is enough; the screen resolves the right app.
   */
  "miui-power-detail": () =>
    IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
      // packageName + className become ComponentName(packageName, className)
      // natively, so they must stay separate — a single "pkg/cls" string does
      // not work.
      packageName: "com.miui.securitycenter",
      className: "com.miui.powercenter.legacypowerrank.PowerDetailActivity",
      extra: { package_name: PACKAGE },
    }),

  /**
   * Older MIUI's per-app battery screen. Below the one above because it does
   * NOT resolve on HyperOS V816 (measured: no matching component), but it is
   * still the right screen on builds where it exists.
   */
  "miui-power-keeper": () =>
    IntentLauncher.startActivityAsync(
      "miui.intent.action.HIDDEN_APPS_CONFIG_ACTIVITY",
      {
        packageName: "com.miui.powerkeeper",
        extra: { package_name: PACKAGE, package_label: "PearDrop" },
      }
    ),

  /**
   * The Autostart screen, by the implicit action it advertises.
   *
   * Read off the device rather than guessed — `AutoStartManagementActivity`
   * declares exactly one filter on HyperOS V816:
   *
   *     Action:   "miui.intent.action.OP_AUTO_START"
   *     Category: "android.intent.category.DEFAULT"
   *
   * Verified 2026-09-07 (Redmi 25062RN2DA): resolves to
   * com.miui.permcenter.autostart.AutoStartManagementActivity and lands on
   * the screen titled "Background autostart", with PearDrop in the list.
   *
   * First because an implicit action survives the class being renamed or
   * moved, which is the more common OEM churn.
   */
  "miui-autostart-op": () =>
    IntentLauncher.startActivityAsync("miui.intent.action.OP_AUTO_START"),

  /**
   * The same screen, by explicit component. Second because it survives the
   * complementary failure — the action being renamed while the class stays.
   *
   * `enabled=true exported=true` on HyperOS V816, so a normal app may start
   * it. Takes no package extra: MIUI declares none, and the screen is a
   * global list of every app rather than a per-app page.
   */
  "miui-autostart-management": () =>
    IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
      packageName: "com.miui.securitycenter",
      className: "com.miui.permcenter.autostart.AutoStartManagementActivity",
    }),

  /**
   * Samsung's "Unmonitored apps" list — the allowlist that exempts an app
   * from Device Care's background limits.
   *
   * Sprint 8A, from 7D's harness. Verified present and exported via
   * `dumpsys package com.samsung.android.lool` on SM-G990E (One UI 8.0),
   * SM-S928B and SM-S721B (both One UI 8.5). First because it is the
   * per-app allowlist rather than the general battery page.
   */
  "samsung-battery-checkable": () =>
    IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
      packageName: "com.samsung.android.lool",
      className: "com.samsung.android.sm.battery.ui.usage.CheckableAppListActivity",
    }),

  /** Samsung's battery page. Same package, same three devices, same check. */
  "samsung-battery-ui": () =>
    IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
      packageName: "com.samsung.android.lool",
      className: "com.samsung.android.sm.battery.ui.BatteryActivity",
    }),

  /**
   * AOSP's system-wide battery-optimization list.
   *
   * The list, not this app's page, and deliberately NOT
   * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS — that action requires holding the
   * Play-policy-restricted permission of the same name, which this app has
   * no other reason to declare.
   */
  "aosp-battery-optimization": () =>
    IntentLauncher.startActivityAsync(
      "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"
    ),

  /** Always present. The honest fallback: the user can reach both from here. */
  "app-details": () => Linking.openSettings(),
};

/**
 * Whether this device has Xiaomi's Autostart concept at all. Exported so the
 * prompt and the Settings rows gate their copy on the same predicate the
 * ladder uses — two different answers to "is this a Xiaomi" would mean
 * offering a row that lands on the wrong screen.
 */
export function isXiaomiDevice(): boolean {
  if (Platform.OS !== "android") return false;
  return isXiaomiManufacturer(String(Platform.constants?.Manufacturer ?? ""));
}

/**
 * Try each candidate until one succeeds. Returns the label that worked, or
 * null if even the app-details fallback failed (which would mean something is
 * very wrong with the device, not with this code).
 */
async function runLadder(kind: LadderKind, tag: string): Promise<string | null> {
  if (Platform.OS !== "android") return null;

  const labels = ladderFor(kind, String(Platform.constants?.Manufacturer ?? ""));

  for (const label of labels) {
    try {
      await RUNNERS[label]();
      debugLog("info", tag, `opened via ${label}`);
      return label;
    } catch (err: unknown) {
      debugLog(
        "warn",
        tag,
        `${label} unavailable — ${String((err as Error)?.message || err)}`
      );
    }
  }

  debugLog("error", tag, "no settings screen could be opened");
  return null;
}

/**
 * The battery-restriction screen.
 *
 * `miui.intent.action.APP_PERM_EDITOR` is excluded from BOTH ladders, for two
 * different reasons. Do not add it to either.
 *
 * Battery: it opens the app permissions editor, which is not a battery screen
 * at all, so this function's "find PearDrop's battery setting" copy would
 * lead nowhere.
 *
 * Autostart: it was rung 1 of that ladder for one sprint and was removed
 * after a device check on 2026-09-07. It resolves (`isDefault=true`) to
 * `com.miui.permcenter.permissions.PermissionsEditorActivity` and is
 * correctly scoped to this app — the page is titled "PearDrop" — but on
 * HyperOS V816 that page contains exactly one row, "Other permissions", and
 * Autostart is not on it. `extra_pkgname` was being honoured; the
 * destination itself has moved. No extra key can fix that.
 *
 * The shared conclusion, and the reason this comment exists: a candidate that
 * SUCCEEDS at opening the wrong screen is worse than none, because it wins
 * the ladder and shadows a rung that would have worked. It cost a device
 * session to learn twice.
 */
/**
 * NO CALLER, and unlike `openAutostartSettings` below its ladder
 * is unreachable too — nothing resolves `ladderFor("battery", …)` in
 * production any more.
 *
 * Its last call site was the always-present "Battery settings" row, which
 * 8A replaced with the conditional fallback row. Both of the fallback's real
 * destinations are reached through `ladderFor("fallback", …)`, which does not
 * route through here.
 *
 * Kept rather than deleted because the analysis in this comment block — and
 * in particular the APP_PERM_EDITOR note above, which cost two device
 * sessions to learn — is the most expensive thing in this file, and it is
 * attached to this function. `ladderFor("battery", …)` remains covered by
 * settingsLadder.test.ts. Flagged at Gate 5 rather than removed silently.
 */
export function openBackgroundSettings(): Promise<string | null> {
  return runLadder("battery", "rn.bgsettings");
}

/**
 * Xiaomi's Autostart permission — the setting measured to decide whether a
 * backgrounded transfer completes. No-ops into the generic app-details screen
 * on non-Xiaomi devices, which have no equivalent concept to aim at.
 */
/**
 * NO CALLER. Kept deliberately, not overlooked.
 *
 * 8A removed the always-present Xiaomi Autostart row, which was this
 * function's only call site, and routed the fallback prompt through
 * `openFallbackSettings()` instead so that one entry point logs one tag
 * (`rn.fallback`) for the whole fallback journey.
 *
 * The Xiaomi autostart LADDER is still very much live — `ladderFor("fallback",
 * <xiaomi>)` delegates straight to `ladderFor("autostart", …)`, so the rungs
 * below are what a Xiaomi user reaches from the fallback. Only this wrapper
 * is idle, and it is the natural API if a surface ever needs the Autostart
 * screen directly again. Deleting it would save four lines and cost the next
 * sprint the rediscovery.
 */
export function openAutostartSettings(): Promise<string | null> {
  return runLadder("autostart", "rn.autostart");
}

/**
 * the per-OEM destination offered after the foreground service
 * has demonstrably failed on this device — three service-attributed bad
 * background windows, weighted.
 *
 * One destination per manufacturer, each landing on a specific screen. This
 * is the only user-facing settings route that survives 8A; the always-present
 * Autostart row and the 7A/7B freeze prompt are retired, because the service
 * now solves for everyone it can solve for without asking.
 */
export function openFallbackSettings(): Promise<string | null> {
  return runLadder("fallback", "rn.fallback");
}

/**
 * Which brand's copy to show alongside that destination. Exported so the
 * prompt and the Settings row name the same setting the ladder will open —
 * two different answers would mean instructing the user to look for a
 * control that is not on the screen they land on, which is the 7B lesson.
 */
export function fallbackBrand(): "xiaomi" | "samsung" | "generic" {
  if (Platform.OS !== "android") return "generic";
  const manufacturer = String(Platform.constants?.Manufacturer ?? "");
  if (isXiaomiManufacturer(manufacturer)) return "xiaomi";
  if (isSamsungManufacturer(manufacturer)) return "samsung";
  return "generic";
}
