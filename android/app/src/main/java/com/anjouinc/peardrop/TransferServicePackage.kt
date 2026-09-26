package com.anjouinc.peardrop

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the foreground-service bridge module.
 *
 * Added to the package list only when `BuildConfig.DEV_INSTRUMENTATION` is
 * set — the same flag that adds the `<service>` element to the manifest. The
 * two must move together: a registered module with no manifest entry would
 * make every Start row fail with an opaque "Unable to start service" instead
 * of reporting cleanly that this build has no service to start.
 */
class TransferServicePackage : ReactPackage {

  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(TransferServiceModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
