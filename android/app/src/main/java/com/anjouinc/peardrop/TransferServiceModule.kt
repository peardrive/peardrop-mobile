package com.anjouinc.peardrop

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Foreground-service bridge. Both methods resolve rather than reject: a blocked background start on
 * Android 12+ is an expected outcome the caller needs as a value, not an unhandled rejection.
 */
class TransferServiceModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PeardropTransferService"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val context = reactApplicationContext
      TransferService.ensureChannels(context)
      val intent = Intent(context, TransferService::class.java)
      TransferService.noteStartRequested()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      promise.resolve("started")
    } catch (e: Exception) {
      TransferService.noteStartFailed()
      promise.resolve("error:${e.javaClass.simpleName}:${e.message ?: ""}")
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val context = reactApplicationContext
      if (!TransferService.requestStop(context)) {
        // The service stops itself once promoted, and its `onDestroy` clears both rows.
        promise.resolve("deferred")
        return
      }
      // `stopService` is asynchronous, so both rows are cleared here too;
      // `cancel` on an already-cancelled id is a no-op.
      TransferService.clearRows(context)
      promise.resolve("stopped")
    } catch (e: Exception) {
      promise.resolve("error:${e.javaClass.simpleName}:${e.message ?: ""}")
    }
  }

  /** Screen state. `isInteractive()` needs no permission, which is what makes freeze attribution obtainable. */
  @ReactMethod
  fun isScreenInteractive(promise: Promise) {
    try {
      val pm =
        reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
      promise.resolve(pm?.isInteractive ?: true)
    } catch (e: Exception) {
      // Unknown reads as "on": a screen-locked claim is the stronger one and must not rest on a failed read.
      promise.resolve(true)
    }
  }

  /**
   * Flat parameters so nothing here parses or validates, and it resolves rather
   * than rejects: a refresh must not break the transfer it describes.
   */
  @ReactMethod
  fun updateRows(
    receivingPresent: Boolean,
    receivingTitle: String,
    receivingText: String,
    receivingSubline: String,
    receivingPercent: Double,
    sharingPresent: Boolean,
    sharingTitle: String,
    sharingText: String,
    sharingSubline: String,
    sharingPercent: Double,
    serviceRow: String,
    promise: Promise
  ) {
    try {
      TransferService.applyRows(
        reactApplicationContext,
        receivingPresent,
        receivingTitle,
        receivingText,
        receivingSubline,
        receivingPercent.toInt(),
        sharingPresent,
        sharingTitle,
        sharingText,
        sharingSubline,
        sharingPercent.toInt(),
        serviceRow
      )
      promise.resolve("updated")
    } catch (e: Exception) {
      promise.resolve("error:${e.javaClass.simpleName}:${e.message ?: ""}")
    }
  }

  /** Drains a Cancel tap that could not be delivered to JS. Clears as it reads, so draining twice cannot cancel twice. */
  @ReactMethod
  fun drainPendingCancel(promise: Promise) {
    try {
      promise.resolve(TransferService.drainPendingCancel())
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /** Drains a platform timeout that could not be delivered to JS. Clears as it reads, so the notice is posted once. */
  @ReactMethod
  fun drainPendingTimeout(promise: Promise) {
    try {
      promise.resolve(TransferService.drainPendingTimeout())
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /** Everything TransferService recorded since the last drain. Resolves empty when nothing is pending, never rejects. */
  @ReactMethod
  fun drainServiceLog(promise: Promise) {
    try {
      val array = Arguments.createArray()
      for (line in TransferService.drainOutcomes()) array.pushString(line)
      promise.resolve(array)
    } catch (e: Exception) {
      val array = Arguments.createArray()
      array.pushString("drain THREW ${e.javaClass.simpleName}: ${e.message ?: ""}")
      promise.resolve(array)
    }
  }
}
