import { NativeModules, Platform } from "react-native";

/**
 * The signal that decides whether development-only instrumentation is active.
 * Not `__DEV__`, which means "bundled by Metro in dev mode": the standalone
 * sideload APK is bundled with `--dev false`, so gating on it would strip the
 * instrumentation from the only artifact that can be tested unplugged.
 * `BuildConfig.DEBUG` tracks the build variant, which is what the gates mean,
 * and every value here is published so a log can never be silently worthless.
 */

type BuildInfoConstants = {
  isDebugBuild?: boolean;
  isDebuggable?: boolean;
  buildType?: string;
  versionName?: string;
  versionCode?: number;
  /** `BuildConfig.BUILD_STAMP`, generated at Gradle configuration time so two
   *  builds of one version can be told apart. Optional, because a build
   *  predating the field, or iOS, will not carry it. */
  buildStamp?: string;
};

const native: BuildInfoConstants | undefined = (
  NativeModules as { PeardropBuildInfo?: BuildInfoConstants }
).PeardropBuildInfo;

const nativeFlag = native?.isDebugBuild;
const nativeResolved = typeof nativeFlag === "boolean";

export const IS_DEBUG_BUILD: boolean = nativeResolved ? nativeFlag : __DEV__;

/** Kept as a function for call sites that read more naturally that way. Same
 *  value, resolved once at module load, so it is safe in effects and render. */
export function isDebugBuild(): boolean {
  return IS_DEBUG_BUILD;
}

/** Whether the OS considers this package debuggable (`FLAG_DEBUGGABLE`).
 *  Separate from `IS_DEBUG_BUILD`, which can be armed on a release build that
 *  is not debuggable. Some OEM power managers treat debuggable packages
 *  differently, so a measurement needs both. `null` is unknown, not false. */
export const IS_DEBUGGABLE: boolean | null =
  typeof native?.isDebuggable === "boolean" ? native.isDebuggable : null;

/** Version compiled into the APK (`BuildConfig.VERSION_NAME`), not the value
 *  read from `app.json` at runtime. It is the number that actually shipped,
 *  so it cannot drift from the artifact the way a source read could. */
export const APP_VERSION: string = native?.versionName ?? "unknown";
export const APP_VERSION_CODE: number | null =
  typeof native?.versionCode === "number" ? native.versionCode : null;

/** Which build produced this artifact, as opposed to which version it calls
 *  itself. Two builds of one version are indistinguishable by `versionName`
 *  and `versionCode`; this is generated per Gradle configuration. `"unknown"`
 *  rather than `""`, because a false attribution is worse than none. */
export const BUILD_STAMP: string = native?.buildStamp ?? "unknown";

/** `"debug"` / `"release"` from `BuildConfig.BUILD_TYPE`. */
export const BUILD_TYPE: string = native?.buildType ?? "unknown";

/** Platform note for logs: which signal actually decided the gate. */
export const DEV_GATE_SOURCE: string = nativeResolved
  ? `PeardropBuildInfo.isDebugBuild=${nativeFlag} buildType=${BUILD_TYPE} ` +
    `debuggable=${IS_DEBUGGABLE === null ? "?" : IS_DEBUGGABLE}`
  : `__DEV__=${__DEV__} (PeardropBuildInfo unavailable on ${Platform.OS})`;

/** Everything a reader needs to decide whether a log is worth reading, as one
 *  object. Kept plain so `debugLogFormat.ts` can stay free of react-native
 *  imports. */
export type BuildIdentity = {
  appVersion: string;
  appVersionCode: number | null;
  buildType: string;
  isDebugBuild: boolean;
  isDebuggable: boolean | null;
  gateSource: string;
  platform: string;
  /** which build, not which version. See `BUILD_STAMP`. */
  buildStamp: string;
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
    buildStamp: BUILD_STAMP,
  };
}

/** One-line form for the boot log entry. */
export function describeBuild(): string {
  const armed = IS_DEBUG_BUILD ? "ARMED" : "OFF";
  const dbg = IS_DEBUGGABLE === null ? "?" : IS_DEBUGGABLE ? "yes" : "no";
  const code = APP_VERSION_CODE === null ? "?" : APP_VERSION_CODE;
  return (
    `instrumentation=${armed} app=${APP_VERSION} (${code}) ` +
    // Repeated on the boot line as well as the export header: the header is
    // the un-evictable surface, but this is what a `logcat` reader sees.
    `stamp=${BUILD_STAMP} ` +
    `buildType=${BUILD_TYPE} debuggable=${dbg} platform=${Platform.OS} ` +
    `gate-source=${DEV_GATE_SOURCE}`
  );
}
