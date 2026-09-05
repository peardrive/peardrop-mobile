package com.peardrop.mobile

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
   * Exposed as a constant rather than a method because several gates run
   * during module evaluation, where awaiting a bridge call is not possible.
   *
   * This module exists for this constant alone. It was carved out of the
   * foreground-service spike's bridge when that spike was retired, precisely
   * so removing the spike could not silently drop the gate signal and
   * disable every dev-only surface in the sideload APK. Consumer:
   * src/lib/devGate.ts.
   */
  override fun getConstants(): Map<String, Any> =
    mapOf("isDebugBuild" to BuildConfig.DEBUG)
}
