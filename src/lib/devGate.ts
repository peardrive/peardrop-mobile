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
 *   build                      __DEV__   BuildConfig.DEBUG   gate
 *   Metro dev server            true          true           ON
 *   standalone debug APK        false         true           ON   <- the fix
 *   release APK                 false         false          OFF
 *
 * Falls back to `__DEV__` when the constant is unavailable (iOS, or a build
 * predating the native module). That fallback errs toward OFF in a release
 * build, which is the safe direction.
 */
const nativeFlag = (
  NativeModules as { PeardropBuildInfo?: { isDebugBuild?: boolean } }
).PeardropBuildInfo?.isDebugBuild;

export const IS_DEBUG_BUILD: boolean =
  typeof nativeFlag === "boolean" ? nativeFlag : __DEV__;

/**
 * Kept as a function for call sites that read more naturally that way. Same
 * value; resolved once at module load, so it is safe in effect bodies and in
 * render.
 */
export function isDebugBuild(): boolean {
  return IS_DEBUG_BUILD;
}

/** Platform note for logs: which signal actually decided the gate. */
export const DEV_GATE_SOURCE: string =
  typeof nativeFlag === "boolean"
    ? `BuildConfig.DEBUG=${nativeFlag}`
    : `__DEV__=${__DEV__} (native constant unavailable on ${Platform.OS})`;
