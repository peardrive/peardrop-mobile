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
 * Sprint 6R's foreground-service bridge, restored by 7D as a harness row.
 *
 * A plain bridge module rather than a TurboModule — it works under both
 * architectures via the interop layer, and nothing here is hot enough to care.
 *
 * Both methods resolve rather than reject on failure, returning the exception
 * class name instead. A background start on Android 12+ is EXPECTED to fail
 * with ForegroundServiceStartNotAllowedException; that outcome is data the
 * harness exists to collect, so it must reach JS as a value rather than as an
 * unhandled rejection.
 *
 * ## No getConstants() here — deliberately
 *
 * The original carried `getConstants()` returning `isDebugBuild`. That is not
 * spike code: it is the gate signal for every dev-only surface in the app, and
 * split it out into BuildInfoModule (`"PeardropBuildInfo"`) so that
 * retiring this spike could not silently disable it. Restoring it here would
 * register the same constant under a second module name, and the gates would
 * break silently. The archive's README says so explicitly; it stays deleted.
 *
 * ## Why drainServiceLog exists
 *
 * `start()` resolves as soon as `startForegroundService` returns, which is
 * BEFORE `onStartCommand` has run — so the "started" string proves the call
 * was accepted, not that the service reached foreground state. Only
 * `TransferService` itself knows that, and it only said so to logcat, which
 * never reaches an exported log. This drains what the service recorded so the
 * JS side can write it into the debug log.
 */
class TransferServiceModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PeardropTransferService"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val context = reactApplicationContext
      TransferService.ensureChannel(context)
      val intent = Intent(context, TransferService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      promise.resolve("started")
    } catch (e: Exception) {
      promise.resolve("error:${e.javaClass.simpleName}:${e.message ?: ""}")
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val context = reactApplicationContext
      context.stopService(Intent(context, TransferService::class.java))
      promise.resolve("stopped")
    } catch (e: Exception) {
      promise.resolve("error:${e.javaClass.simpleName}:${e.message ?: ""}")
    }
  }

  /**
   * is the screen on?
   *
   * `PowerManager.isInteractive()` requires NO permission — it is the reason
   * the richer freeze attribution is obtainable at all. A screen-locked
   * window and a screen-on one are different tests of the same mechanism,
   * and every measurement in this project's record that mattered was taken
   * screen-locked; without this, an exported log cannot say which kind of
   * window produced a verdict.
   *
   * Lives on this module rather than BuildInfoModule because it is a
   * changing value, not a build constant, and BuildInfoModule is
   * constants-only and load-bearing for every dev gate.
   */
  @ReactMethod
  fun isScreenInteractive(promise: Promise) {
    try {
      val pm =
        reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
      promise.resolve(pm?.isInteractive ?: true)
    } catch (e: Exception) {
      // Unknown reads as "on": the conservative direction, since a
      // screen-locked claim is the stronger evidence and should not be made
      // on a failed read.
      promise.resolve(true)
    }
  }

  /**
   * refresh the ongoing notification's text and progress.
   *
   * `percent` outside 0..100 renders an indeterminate bar. Resolves rather
   * than rejects on failure — a notification refresh must never be able to
   * break the transfer it is describing.
   */
  @ReactMethod
  fun update(
    title: String,
    text: String,
    percent: Double,
    cancelLabel: String,
    promise: Promise
  ) {
    try {
      TransferService.updateNotification(
        reactApplicationContext,
        title,
        text,
        percent.toInt(),
        cancelLabel
      )
      promise.resolve("updated")
    } catch (e: Exception) {
      promise.resolve("error:${e.javaClass.simpleName}:${e.message ?: ""}")
    }
  }

  /**
   * was a Cancel tapped that could not be delivered to JS?
   *
   * The notification's Cancel emits `PeardropCancelAllTransfers` directly
   * when a `ReactContext` is available, which is the expected path — the
   * foreground service exists to keep the process alive, so one should be.
   * This is the fallback for when it is not: the tap is recorded and the JS
   * side drains it on its next foreground transition, so a cancel the user
   * pressed is never silently lost.
   *
   * Clears the flag as it reads, so draining twice does not cancel twice.
   */
  @ReactMethod
  fun drainPendingCancel(promise: Promise) {
    try {
      promise.resolve(TransferService.drainPendingCancel())
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * Take everything TransferService has recorded about itself since the last
   * drain — `startForeground` success or failure, `onTimeout`, `onDestroy`.
   * Resolves an empty array when nothing is pending, never rejects.
   */
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
