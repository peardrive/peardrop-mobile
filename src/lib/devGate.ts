import { NativeModules, Platform } from "react-native";

/**
 * The signal that decides whether development-only instrumentation is active.
 *
 * NOT `__DEV__`. That constant means "this JS was bundled by Metro in dev
 * mode", which is a different question from "is this a debug build". Building
 * the standalone sideload APK sets `debuggableVariants = []`, so the JS is
 * bundled with `--dev false` and `__DEV__` is FALSE — in exactly the build
 * used for on-device testing. Gating on it strips the instrumentation from
 * the only artifact that can be tested unplugged.
 *
 * `BuildConfig.DEBUG` tracks the build variant, which is what the gates mean.
 * It is surfaced as a synchronous native constant so it can be read here, at
 * module-evaluation time, by gates that cannot await.
 *
 * Truth table:
 *
 *   build                              isDebugBuild   gate
 *   Metro dev server                       true       ON
 *   standalone debug APK                   true       ON
 *   release APK                            false      OFF
 *   release APK + -PdevInstrumentation     true       ON   <- non-debuggable
 *
 * Falls back to `__DEV__` when the constant is unavailable (iOS, or a build
 * predating the native module). That fallback errs toward OFF in a release
 * build, which is the safe direction.
 *
 * A 2026-09-06 device session produced five logs with no instrumentation in
 * any of them, because the installed APK was a release build and nothing in
 * the log said so. The gate was correct; the silence was the defect. Every
 * value below is therefore also published — into the export header, into a
 * log line on the rising edge of the Debugging flag, and into a Settings
 * row — so a log can never again be silently worthless. `DEV_GATE_SOURCE`
 * in particular exists to name WHICH signal decided the gate, so a missing
 * native module reads differently from a release build.
 */

type BuildInfoConstants = {
  isDebugBuild?: boolean;
  isDebuggable?: boolean;
  buildType?: string;
  versionName?: string;
  versionCode?: number;
};

const native: BuildInfoConstants | undefined = (
  NativeModules as { PeardropBuildInfo?: BuildInfoConstants }
).PeardropBuildInfo;

const nativeFlag = native?.isDebugBuild;
const nativeResolved = typeof nativeFlag === "boolean";

export const IS_DEBUG_BUILD: boolean = nativeResolved ? nativeFlag : __DEV__;

/**
 * Kept as a function for call sites that read more naturally that way. Same
 * value; resolved once at module load, so it is safe in effect bodies and in
 * render.
 */
export function isDebugBuild(): boolean {
  return IS_DEBUG_BUILD;
}

/**
 * Whether the OS considers this package debuggable (`FLAG_DEBUGGABLE`).
 *
 * Deliberately separate from `IS_DEBUG_BUILD`: `-PdevInstrumentation=true`
 * arms the gate on a release build, which is NOT debuggable. Some OEM power
 * managers treat debuggable packages differently, so a measurement is only
 * interpretable if this value is recorded alongside the gate state.
 *
 * `null` when the native module did not resolve — unknown, not false.
 */
export const IS_DEBUGGABLE: boolean | null =
  typeof native?.isDebuggable === "boolean" ? native.isDebuggable : null;

/**
 * Version compiled into the APK (`BuildConfig.VERSION_NAME`), not the value
 * read from `app.json` at runtime. `app.json` is prebuilt into
 * `versionName` in `android/app/build.gradle`, so this is the same number —
 * but it is the one that actually shipped, and it cannot drift from the
 * artifact the way a source read could.
 */
export const APP_VERSION: string = native?.versionName ?? "unknown";
export const APP_VERSION_CODE: number | null =
  typeof native?.versionCode === "number" ? native.versionCode : null;

/** `"debug"` / `"release"` from `BuildConfig.BUILD_TYPE`. */
export const BUILD_TYPE: string = native?.buildType ?? "unknown";

/** Platform note for logs: which signal actually decided the gate. */
export const DEV_GATE_SOURCE: string = nativeResolved
  ? `PeardropBuildInfo.isDebugBuild=${nativeFlag} buildType=${BUILD_TYPE} ` +
    `debuggable=${IS_DEBUGGABLE === null ? "?" : IS_DEBUGGABLE}`
  : `__DEV__=${__DEV__} (PeardropBuildInfo unavailable on ${Platform.OS})`;

/**
 * Everything a reader needs to decide whether a log is worth reading, as one
 * object. Consumed by the export header and the boot line; kept plain so
 * `debugLogFormat.ts` can stay free of react-native imports.
 */
export type BuildIdentity = {
  appVersion: string;
  appVersionCode: number | null;
  buildType: string;
  isDebugBuild: boolean;
  isDebuggable: boolean | null;
  gateSource: string;
  platform: string;
};

export function buildIdentity(): BuildIdentity {
  return {
    appVersion: APP_VERSION,
    appVersionCode: APP_VERSION_CODE,
    buildType: BUILD_TYPE,
    isDebugBuild: IS_DEBUG_BUILD,
    isDebuggable: IS_DEBUGGABLE,
    gateSource: DEV_GATE_SOURCE,
    platform: Platform.OS,
  };
}

/** One-line form for the boot log entry. */
export function describeBuild(): string {
  const armed = IS_DEBUG_BUILD ? "ARMED" : "OFF";
  const dbg = IS_DEBUGGABLE === null ? "?" : IS_DEBUGGABLE ? "yes" : "no";
  const code = APP_VERSION_CODE === null ? "?" : APP_VERSION_CODE;
  return (
    `instrumentation=${armed} app=${APP_VERSION} (${code}) ` +
    `buildType=${BUILD_TYPE} debuggable=${dbg} platform=${Platform.OS} ` +
    `gate-source=${DEV_GATE_SOURCE}`
  );
}
