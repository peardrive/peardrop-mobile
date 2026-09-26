package com.anjouinc.peardrop

import android.content.pm.ApplicationInfo
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Surfaces build-variant facts that JS cannot determine for itself.
 *
 * A plain bridge module rather than a TurboModule — it works under both
 * architectures via the interop layer, and a single constant read once at
 * startup is not hot enough to care.
 */
class BuildInfoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PeardropBuildInfo"

  /**
   * Synchronous constants, readable at JS module-evaluation time.
   *
   * `isDebugBuild` is the gate signal for development-only instrumentation.
   * It is NOT `__DEV__`: that constant means "Metro dev bundle", and this
   * project sideloads standalone debug APKs whose JS is bundled with
   * `--dev false`, so `__DEV__` is false in exactly the build used for device
   * testing. `BuildConfig.DEBUG` tracks the build variant instead, which is
   * what the gates actually mean.
   *
   * `DEV_INSTRUMENTATION` widens it to a release build on demand:
   *
   *     ./gradlew -p android assembleRelease -PdevInstrumentation=true
   *
   * That produces an APK with the gate armed but `FLAG_DEBUGGABLE` unset.
   * It exists because every device measurement in this project so far was
   * taken on a debuggable package, and some OEM power managers treat those
   * differently — without this the debuggable variable cannot be separated
   * from the freeze behaviour being measured. Defaults to false, so a plain
   * `assembleRelease` is byte-identical in behaviour to before.
   *
   * `isDebuggable` reports `FLAG_DEBUGGABLE` itself and is deliberately NOT
   * folded into `isDebugBuild`: with the property set the two disagree, and
   * that disagreement is exactly what a measurement needs recorded.
   *
   * `versionName` / `versionCode` / `buildType` identify the artifact. They
   * are read from BuildConfig rather than from `app.json` at runtime so they
   * describe what actually shipped and cannot drift from the APK.
   *
   * Exposed as constants rather than methods because several gates run
   * during module evaluation, where awaiting a bridge call is not possible.
   *
   * This module was carved out of the foreground-service spike's bridge when
   * that spike was retired, precisely so removing the spike could not
   * silently drop the gate signal and disable every dev-only surface in the
   * sideload APK. Consumer: src/lib/devGate.ts.
   *
   * ## Sprint 7D: three Build fields, and only three
   *
   * React Native's own PlatformConstants already exposes MANUFACTURER, BRAND,
   * MODEL, RELEASE and SDK_INT as `Platform.constants`. `DEVICE`, `PRODUCT`
   * and `DISPLAY` are not among them, so they are added here rather than
   * through a second native module — a second module is how the gate constant
   * nearly got registered twice, and once is enough.
   *
   * `DISPLAY` is the one that matters most: it is the ROM build ID, which is
   * what actually names a HyperOS / MIUI / One UI version. `MODEL` says
   * "25062RN2DA"; `DISPLAY` says which ROM is on it, and OEM activity names
   * change between ROM versions, not between model numbers.
   *
   * Nothing above this line changed. `isDebugBuild` in particular is
   * load-bearing for every dev gate in the app and is untouched.
   *
   * ## D-45: `buildStamp`
   *
   * `versionName` and `versionCode` say which DROP this is. They cannot say
   * which BUILD within the drop, and every build this project had produced
   * called itself `0.1.0 (1)` - so no tester result could be attached to a
   * build and no fix could be proved to have shipped.
   *
   * `BuildConfig.BUILD_STAMP` is generated at Gradle configuration time in
   * `android/app/build.gradle` (timestamp + sprint label + random nonce) and
   * changes on every build. It is NOT derived from git: there is no `.git` in
   * the development tree and git is forbidden in all three trees.
   *
   * It is exposed here, beside `versionName`, for the same reason those are:
   * it describes what actually shipped and cannot drift from the APK.
   * Consumer: src/lib/devGate.ts, then the Settings version row (ungated, so
   * a release tester can read it out) and the export log header.
   */
  override fun getConstants(): Map<String, Any> {
    val debuggable =
      (reactApplicationContext.applicationInfo.flags and
        ApplicationInfo.FLAG_DEBUGGABLE) != 0
    return mapOf(
      "isDebugBuild" to (BuildConfig.DEBUG || BuildConfig.DEV_INSTRUMENTATION),
      "isDebuggable" to debuggable,
      "buildType" to BuildConfig.BUILD_TYPE,
      "versionName" to BuildConfig.VERSION_NAME,
      "versionCode" to BuildConfig.VERSION_CODE,
      // identifier 2 - distinguishes two builds of the same versionCode.
      "buildStamp" to BuildConfig.BUILD_STAMP,
      // not available via Platform.constants. Nullable in theory
      // on a badly-built ROM, hence the fallbacks: an empty readout line is
      // harder to interpret than an explicit "unknown".
      "buildDevice" to (Build.DEVICE ?: "unknown"),
      "buildProduct" to (Build.PRODUCT ?: "unknown"),
      "buildDisplay" to (Build.DISPLAY ?: "unknown"),
    )
  }
}
