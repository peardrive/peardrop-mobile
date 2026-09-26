/**
 * the OEM background-settings candidate table.
 *
 * A TEST INSTRUMENT, not a feature. Nothing here is wired into
 * `openBackgroundSettings()` / `openAutostartSettings()`; the shipping Xiaomi
 * ladder in `settingsLadder.ts` is untouched and remains the only thing users
 * ever reach. Every consumer of this file is behind `IS_DEBUG_BUILD`.
 *
 * Split from `oemProbe.ts` for the same reason `settingsLadder.ts` is split
 * from `openBackgroundSettings.ts`: this module imports nothing, so the table
 * and the error classifier are readable and unit-testable under jest's "node"
 * environment, which cannot load react-native or expo-intent-launcher.
 *
 * ## Where these came from
 *
 * Primary source is `judemanutd/AutoStarter` @ master
 * (`AutoStartPermissionHelper.kt`), the most-maintained OEM autostart library.
 * Its README splits its own support list into tested (Xiaomi, Redmi, Letv,
 * Huawei, Samsung, Asus) and untested (Honor, Oppo, Vivo, OnePlus); `source`
 * and `libraryTested` below record that per candidate so a null result can be
 * weighed against how much confidence the candidate ever had.
 *
 * ## Two things that shape how a result must be read
 *
 * 1. **The library dispatches on `Build.BRAND`. `isXiaomiDevice()` matches
 *    `Build.MANUFACTURER`.** Both fields are in the readout precisely
 *    because the most-maintained library in this space picked the other one.
 *
 * 2. **Android 11+ package visibility.** With no `<queries>` block — and none
 *    is declared here — a start into a package this app cannot
 *    see throws `ActivityNotFoundException` whether or not the activity
 *    exists. So `not-found` means "could not launch", NOT "does not exist".
 *    A `launched` result is unambiguous; a `not-found` is not. The shipping
 *    `miui-power-detail` rung proves explicit starts into
 *    `com.miui.securitycenter` do succeed without a `<queries>` block, so the
 *    restriction is evidently not absolute for OEM system packages.
 */

/**
 * Three outcomes, not two.
 *
 * `not-found` and `error` are kept apart because they are different findings:
 * a `SecurityException` from a component that exists but is not `exported`
 * says the destination is real and reachable only by a system caller, which
 * is a different conclusion from a package that is not installed. Collapsing
 * both into "didn't work" throws that away.
 */
export type ProbeOutcome = "launched" | "not-found" | "error";

/** Where a candidate came from. Reported per row, and written to the log. */
export type ProbeSource =
  /** In AutoStarter and in the 7D prompt's table. */
  | "library+prompt"
  /** In AutoStarter only — the prompt's table omits it. */
  | "library"
  /** In the prompt's table only — absent from AutoStarter. */
  | "prompt"
  /** Already in this project's shipping ladder, measured on a real device. */
  | "peardrop-measured";

export type ProbeCandidate = {
  /** Stable key. Appears in the log so runs can be collated across devices. */
  key: string;
  /** Row label — names the destination, not the brand. */
  label: string;
  /** Row subtitle — names the brands this targets. */
  subtitle: string;
  /** Intent action. Explicit-component candidates use ACTION_MAIN. */
  action: string;
  /**
   * Explicit component. Both or neither: expo-intent-launcher only reads
   * `packageName` inside `params.className?.let { … }`, so a `packageName`
   * passed without a `className` is silently dropped and the intent goes out
   * implicit. Rather than pass something inert, action-only candidates leave
   * both unset and record the intended package in `note`.
   */
  packageName?: string;
  className?: string;
  extra?: Record<string, string>;
  /** `app-details` goes through `Linking.openSettings()`, which has no intent. */
  via: "intent" | "app-details";
  source: ProbeSource;
  /** Whether AutoStarter's README lists this brand as tested. */
  libraryTested: boolean;
  /** Anything a reader of the results needs to know about this row. */
  note?: string;
};

/**
 * This app. Several OEM screens take it as an extra to scope themselves.
 *
 * Must track `applicationId` from `android/app/build.gradle`, not `namespace`
 * — an OEM settings screen resolves the extra against the installed package.
 */
const PACKAGE = "com.anjouinc.peardrop";

/** Explicit components are started with ACTION_MAIN — see the module header. */
const MAIN = "android.intent.action.MAIN";

/**
 * Ordered as the operator taps: by brand, and within each brand the candidate
 * most likely to work first, so a session that runs short still produces the
 * most useful data.
 *
 * Brand order is Xiaomi (the device in hand, and the only measured one), then
 * the brands AutoStarter's README calls tested, then Nokia (present in the
 * library's code but in neither README bucket), then the brands it calls
 * untested, then Meizu (absent from the library entirely), then the two AOSP
 * destinations, which resolve everywhere and so prove least.
 *
 * Within a brand the order is AutoStarter's own fallback order, except for
 * Xiaomi, where this project's device measurements outrank it.
 */
export const OEM_PROBE_CANDIDATES: readonly ProbeCandidate[] = [
  // ---------------------------------------------------------------
  // Xiaomi / Redmi / Poco — measured on HyperOS V816
  // ---------------------------------------------------------------
  {
    key: "miui-autostart-op",
    label: "Autostart (implicit action)",
    subtitle: "Xiaomi, Redmi, Poco — measured working",
    action: "miui.intent.action.OP_AUTO_START",
    via: "intent",
    source: "peardrop-measured",
    libraryTested: true,
    note: "Rung 1 of the shipping autostart ladder. Read off the device, not guessed.",
  },
  {
    key: "miui-autostart-management",
    label: "Autostart (explicit component)",
    subtitle: "Xiaomi, Redmi, Poco — alternate, measured working",
    action: MAIN,
    packageName: "com.miui.securitycenter",
    className: "com.miui.permcenter.autostart.AutoStartManagementActivity",
    via: "intent",
    source: "peardrop-measured",
    libraryTested: true,
    note: "AutoStarter's only Xiaomi candidate; also rung 2 of the shipping ladder.",
  },
  {
    key: "miui-power-detail",
    label: "Battery details",
    subtitle: "Xiaomi, Redmi, Poco — measured working",
    action: MAIN,
    packageName: "com.miui.securitycenter",
    className: "com.miui.powercenter.legacypowerrank.PowerDetailActivity",
    extra: { package_name: PACKAGE },
    via: "intent",
    source: "peardrop-measured",
    libraryTested: true,
    note: "Rung 1 of the shipping battery ladder. Not in AutoStarter.",
  },
  {
    key: "miui-power-keeper",
    label: "Battery (legacy MIUI)",
    subtitle: "Xiaomi, Redmi, Poco — alternate",
    action: "miui.intent.action.HIDDEN_APPS_CONFIG_ACTIVITY",
    via: "intent",
    source: "peardrop-measured",
    libraryTested: true,
    note:
      "Rung 2 of the shipping battery ladder; measured NOT to resolve on " +
      "HyperOS V816. Included to find a build where it does. Package " +
      "com.miui.powerkeeper cannot be pinned — action-only, see ProbeCandidate.",
  },

  // ---------------------------------------------------------------
  // Huawei / Honor — library-tested (Huawei); Honor marked untested
  // ---------------------------------------------------------------
  {
    key: "huawei-startup-mgr",
    label: "Startup manager",
    subtitle: "Huawei",
    action: MAIN,
    packageName: "com.huawei.systemmanager",
    className: "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: true,
  },
  {
    key: "huawei-protect",
    label: "Protected apps",
    subtitle: "Huawei, Honor — alternate on Huawei, primary on Honor",
    action: MAIN,
    packageName: "com.huawei.systemmanager",
    className: "com.huawei.systemmanager.optimize.process.ProtectActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
    note: "AutoStarter's README lists Huawei as tested and Honor as untested.",
  },

  // ---------------------------------------------------------------
  // Samsung — library-tested
  // ---------------------------------------------------------------
  {
    key: "samsung-battery-lool",
    label: "Battery usage",
    subtitle: "Samsung",
    action: MAIN,
    packageName: "com.samsung.android.lool",
    className: "com.samsung.android.sm.ui.battery.BatteryActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: true,
  },
  {
    key: "samsung-battery-checkable",
    label: "Unmonitored apps",
    subtitle: "Samsung — alternate",
    action: MAIN,
    packageName: "com.samsung.android.lool",
    className: "com.samsung.android.sm.battery.ui.usage.CheckableAppListActivity",
    via: "intent",
    source: "library",
    libraryTested: true,
  },
  {
    key: "samsung-battery-ui",
    label: "Battery (One UI)",
    subtitle: "Samsung — alternate",
    action: MAIN,
    packageName: "com.samsung.android.lool",
    className: "com.samsung.android.sm.battery.ui.BatteryActivity",
    via: "intent",
    source: "library",
    libraryTested: true,
  },
  {
    key: "samsung-battery-sm",
    label: "Battery (legacy SM package)",
    subtitle: "Samsung — alternate",
    action: MAIN,
    packageName: "com.samsung.android.sm",
    className: "com.samsung.android.sm.ui.battery.BatteryActivity",
    via: "intent",
    source: "prompt",
    libraryTested: true,
    note:
      "AutoStarter dropped the com.samsung.android.sm package and now uses " +
      "com.samsung.android.lool with three component names. Kept as a fourth " +
      "Samsung probe in case an older One UI still carries it.",
  },

  // ---------------------------------------------------------------
  // Asus — library-tested
  // ---------------------------------------------------------------
  {
    key: "asus-power-saver",
    label: "Power saver settings",
    subtitle: "Asus",
    action: MAIN,
    packageName: "com.asus.mobilemanager",
    className: "com.asus.mobilemanager.powersaver.PowerSaverSettings",
    via: "intent",
    source: "library",
    libraryTested: true,
  },
  {
    key: "asus-autostart",
    label: "Auto-start manager",
    subtitle: "Asus — alternate",
    action: MAIN,
    packageName: "com.asus.mobilemanager",
    className: "com.asus.mobilemanager.autostart.AutoStartActivity",
    via: "intent",
    source: "library",
    libraryTested: true,
  },
  {
    key: "asus-function-entry",
    label: "Mobile Manager entry",
    subtitle: "Asus — alternate",
    action: MAIN,
    packageName: "com.asus.mobilemanager",
    className: "com.asus.mobilemanager.entry.FunctionActivity",
    via: "intent",
    source: "prompt",
    libraryTested: true,
    note:
      "The 7D prompt's only Asus candidate; appears nowhere in AutoStarter, " +
      "which uses the two above. Ordered last for Asus on that basis.",
  },

  // ---------------------------------------------------------------
  // Letv / LeEco — library-tested
  // ---------------------------------------------------------------
  {
    key: "letv-autoboot",
    label: "Autoboot manager",
    subtitle: "LeEco, Letv",
    action: MAIN,
    packageName: "com.letv.android.letvsafe",
    className: "com.letv.android.letvsafe.AutobootManageActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: true,
  },

  // ---------------------------------------------------------------
  // Nokia / HMD — in AutoStarter's code, in neither README bucket
  // ---------------------------------------------------------------
  {
    key: "nokia-power-exception",
    label: "Power saver exceptions",
    subtitle: "Nokia, HMD",
    action: MAIN,
    packageName: "com.evenwell.powersaving.g3",
    className: "com.evenwell.powersaving.g3.exception.PowerSaverExceptionActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
    note: "Present in AutoStarter's source but absent from its README's tested and untested lists.",
  },

  // ---------------------------------------------------------------
  // Oppo / Realme — library marks UNTESTED. AutoStarter's fallback order.
  // ---------------------------------------------------------------
  {
    key: "oppo-coloros-startup",
    label: "Startup manager",
    subtitle: "Oppo, Realme",
    action: MAIN,
    packageName: "com.coloros.safecenter",
    className: "com.coloros.safecenter.permission.startup.StartupAppListActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
  },
  {
    key: "oppo-safe-startup",
    label: "Startup manager (old ColorOS)",
    subtitle: "Oppo, Realme — alternate",
    action: MAIN,
    packageName: "com.oppo.safe",
    className: "com.oppo.safe.permission.startup.StartupAppListActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
  },
  {
    key: "oppo-coloros-startupapp",
    label: "Startup manager (flat package)",
    subtitle: "Oppo, Realme — alternate",
    action: MAIN,
    packageName: "com.coloros.safecenter",
    className: "com.coloros.safecenter.startupapp.StartupAppListActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
  },

  // ---------------------------------------------------------------
  // Vivo / iQOO — library marks UNTESTED. AutoStarter's fallback order.
  // ---------------------------------------------------------------
  {
    key: "vivo-iqoo-whitelist",
    label: "Background whitelist",
    subtitle: "Vivo, iQOO",
    action: MAIN,
    packageName: "com.iqoo.secure",
    className: "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
  },
  {
    key: "vivo-bg-startup",
    label: "Background start manager",
    subtitle: "Vivo, iQOO — alternate",
    action: MAIN,
    packageName: "com.vivo.permissionmanager",
    className: "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
  },
  {
    key: "vivo-iqoo-bgstartup",
    label: "Background start (iQOO)",
    subtitle: "Vivo, iQOO — alternate",
    action: MAIN,
    packageName: "com.iqoo.secure",
    className: "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
    via: "intent",
    source: "library",
    libraryTested: false,
  },

  // ---------------------------------------------------------------
  // OnePlus — library marks UNTESTED
  // ---------------------------------------------------------------
  {
    key: "oneplus-chain-launch",
    label: "Chain launch",
    subtitle: "OnePlus",
    action: MAIN,
    packageName: "com.oneplus.security",
    className: "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
    via: "intent",
    source: "library+prompt",
    libraryTested: false,
  },
  {
    key: "oneplus-bg-optimize",
    label: "Background optimize",
    subtitle: "OnePlus — alternate",
    action: "com.android.settings.action.BACKGROUND_OPTIMIZE",
    via: "intent",
    source: "library",
    libraryTested: false,
    note: "AutoStarter's second OnePlus attempt, by action. Absent from the 7D prompt's table.",
  },

  // ---------------------------------------------------------------
  // Meizu — absent from AutoStarter entirely
  // ---------------------------------------------------------------
  {
    key: "meizu-appsec",
    label: "App security",
    subtitle: "Meizu",
    action: "com.meizu.safe.security.SHOW_APPSEC",
    extra: { packageName: PACKAGE },
    via: "intent",
    source: "prompt",
    libraryTested: false,
    note:
      "The 7D prompt's table lists this in its Activity column; it is an " +
      "ACTION, not a class name. Intended package com.meizu.safe cannot be " +
      "pinned — action-only, see ProbeCandidate. Community-sourced only.",
  },

  // ---------------------------------------------------------------
  // AOSP — resolve on every device, so they prove the least
  // ---------------------------------------------------------------
  {
    key: "aosp-battery-optimization",
    label: "Battery optimization list",
    subtitle: "All brands — standard Android screen",
    action: "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
    via: "intent",
    source: "prompt",
    libraryTested: true,
    note:
      "The system-wide list, not this app's page, and it needs no permission " +
      "— unlike REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, which is Play-policy " +
      "restricted and is deliberately not probed.",
  },
  {
    key: "aosp-app-details",
    label: "App info",
    subtitle: "All brands — standard Android screen",
    action: "android.settings.APPLICATION_DETAILS_SETTINGS",
    via: "app-details",
    source: "library+prompt",
    libraryTested: true,
    note:
      "Goes through Linking.openSettings(), the same call the shipping " +
      "ladder ends on. A failure here means something is wrong with the " +
      "device, not with a candidate.",
  },
];

/** Full component or action, for the log line. */
export function describeTarget(c: ProbeCandidate): string {
  if (c.via === "app-details") return "Linking.openSettings()";
  if (c.className) return `${c.packageName}/${c.className}`;
  return `action ${c.action}`;
}

/** Short form for a toast, where the full component does not fit. */
export function shortTarget(c: ProbeCandidate): string {
  if (c.via === "app-details") return "openSettings()";
  if (c.className) return c.className.slice(c.className.lastIndexOf(".") + 1);
  return c.action.slice(c.action.lastIndexOf(".") + 1);
}

/**
 * Any fully-qualified Java class name ending in Exception or Error.
 *
 * expo-intent-launcher rejects with `e.toCodedException()`, and for a plain
 * Throwable that is `UnexpectedException(throwable)`, whose message is
 * `throwable.toString()` — i.e. "android.content.ActivityNotFoundException:
 * Unable to find explicit activity class {…}". The class name therefore
 * survives into the JS error message, which is the only place it appears:
 * the CodedError's `code` is a flat "ERR_UNEXPECTED" for every native throw.
 */
const JAVA_THROWABLE = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Exception|Error))\b/;

export type ProbeFailure = {
  outcome: "not-found" | "error";
  /** Simple class name where one could be recovered, else the code or name. */
  exceptionClass: string;
  message: string;
};

/**
 * Turn a rejection into one of the two failure outcomes.
 *
 * `ActivityNotFoundException` alone means `not-found`. Everything else —
 * `SecurityException` from a non-exported component, `NullPointerException`
 * from an activity that starts and immediately dies, expo's own
 * `ActivityAlreadyStartedException` — is `error`, carrying its class so the
 * distinction survives into the log.
 */
export function classifyProbeError(err: unknown): ProbeFailure {
  const message =
    String((err as { message?: unknown })?.message ?? err ?? "").trim() ||
    "(no message)";
  const qualified = JAVA_THROWABLE.exec(message)?.[1] ?? "";
  const simple = qualified.slice(qualified.lastIndexOf(".") + 1);
  const code = String((err as { code?: unknown })?.code ?? "");
  const name = String((err as { name?: unknown })?.name ?? "");
  return {
    outcome: simple === "ActivityNotFoundException" ? "not-found" : "error",
    exceptionClass: simple || code || name || "UnknownError",
    message,
  };
}
