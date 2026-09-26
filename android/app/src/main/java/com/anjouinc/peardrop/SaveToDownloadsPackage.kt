package com.anjouinc.peardrop

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * registers the MediaStore save bridge.
 *
 * Registered unconditionally. Unlike `TransferServicePackage`, there is no
 * manifest element that has to move with it — `SaveToDownloadsModule` needs
 * no permission, no `<service>`, no `<provider>` and no `<queries>` entry, so
 * there is no second half for the registration to get out of step with.
 *
 * Like every other hand-written source in this directory, this file and its
 * `MainApplication.kt` registration are NOT regenerable by `expo prebuild`.
 */
class SaveToDownloadsPackage : ReactPackage {

  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(SaveToDownloadsModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
