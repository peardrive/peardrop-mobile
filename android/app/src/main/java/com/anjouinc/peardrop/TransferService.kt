package com.anjouinc.peardrop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Sprint 6R's dataSync foreground service, restored by 7D as a harness row.
 *
 * A copy of the archived spike (Unify_process/spikes/6R-foreground-service/),
 * not a rewrite, with the three additions 7D needs. It still holds no state,
 * moves no bytes and talks to no other component; its only job is to raise the
 * process's priority so a measurement can establish whether that is enough to
 * prevent the OS freezing the process.
 *
 * ## Why it is back
 *
 * 6R's null result — 96-99% frozen with and without the service — was measured
 * on Xiaomi with Autostart off, where nothing but Autostart would have helped.
 * On a Pixel or a Samsung a foreground service is the *standard* mechanism,
 * and it has never been tested there. That is the question the harness rows
 * exist to answer, and it is a different question from the one 6R answered.
 *
 * ## What 7D added
 *
 * 1. `outcomes` — an in-process queue drained by TransferServiceModule.
 *    `Log.i`/`Log.e` under PeardropFgs never reach the app's debug log, so an
 *    exported log from a borrowed device carried no evidence of whether
 *    `startForeground` actually succeeded. `TransferServiceModule.start()`
 *    resolves "started" before `onStartCommand` has even run, so the JS string
 *    proves nothing. This queue is the only in-process proof there is.
 * 2. `onTimeout` — Android 15's dataSync timeout. Target SDK is 36, so failing
 *    to stop promptly throws ForegroundServiceDidNotStopInTimeException.
 * 3. A notification that shows real progress rather than a static string.
 *
 * ## Sprint 8A: this ships
 *
 * The `<service>` element and FOREGROUND_SERVICE_DATA_SYNC moved into the
 * real `src/main/AndroidManifest.xml`, and `TransferServicePackage` is
 * registered unconditionally. 7D's arrangement — manifest overlay and module
 * registration armed together by `-PdevInstrumentation=true` — is gone.
 *
 * The lifecycle rule lives on the RN side: started from the AppState →
 * background transition when `transferActivity.ts` says a transfer is in
 * flight, stopped on return to foreground or when that predicate goes false.
 * This class stays deliberately dumb about when it should run.
 */
class TransferService : Service() {

  companion object {
    const val CHANNEL_ID = "transfer-service"
    const val NOTIFICATION_ID = 4711
    private const val TAG = "PeardropFgs"

    /** request code for the Cancel action's PendingIntent. */
    private const val CANCEL_REQUEST_CODE = 4712

    /**
     * request code for the body tap's PendingIntent.
     *
     * Must differ from CANCEL_REQUEST_CODE: an equal code with equal flags
     * makes the two PendingIntents the same object, and the body tap would
     * fire Cancel.
     */
    private const val CONTENT_REQUEST_CODE = 4713

    /**
     * What the service observed about itself, waiting to be drained into the
     * app's debug log.
     *
     * Concurrent because `onStartCommand` / `onTimeout` / `onDestroy` run on
     * the main thread while the drain arrives from the bridge's native modules
     * thread. Bounded by discarding the oldest: a runaway service must not be
     * able to grow this without limit, and the newest lines are the ones worth
     * keeping.
     */
    private val outcomes = ConcurrentLinkedQueue<String>()
    private const val MAX_OUTCOMES = 64

    private fun record(line: String) {
      outcomes.add(line)
      while (outcomes.size > MAX_OUTCOMES) outcomes.poll()
    }

    /** Take everything recorded so far. Safe to call when nothing is pending. */
    fun drainOutcomes(): List<String> {
      val drained = ArrayList<String>(outcomes.size)
      while (true) {
        val next = outcomes.poll() ?: break
        drained.add(next)
      }
      return drained
    }

    /**
     * what the ongoing notification currently says.
     *
     * A static rather than instance state so `updateNotification` can refresh
     * it without a binder to the running service. `@Volatile` because the
     * bridge writes from the native-modules thread and `onStartCommand`
     * reads from the main thread.
     *
     * `percent < 0` means indeterminate — a transfer that has connected but
     * has not reported progress yet. The engine's percent is unreliable
     * early on (it clamps at 99 and can sit at 0 through a fast transfer),
     * so an honest spinner beats a wrong number.
     */
    @Volatile private var currentTitle: String = "PearDrop"
    @Volatile private var currentText: String = "Transferring…"
    @Volatile private var currentPercent: Int = -1

    /**
     * the Cancel action's label, and the plumbing behind it.
     *
     * `ACTION_CANCEL` arrives back at `onStartCommand` via a
     * `PendingIntent.getService` on the notification button. A service
     * PendingIntent rather than a `BroadcastReceiver` because the `<service>`
     * element already exists (8A hand-edit #4) and a receiver would need a
     * new manifest entry on a file whose hand-edits do not survive
     * `expo prebuild`. It buys nothing here.
     *
     * The label states scope — "Cancel" for one active transfer, "Cancel all"
     * for several — because there is only ever ONE notification and it
     * carries no driveId, so the button necessarily stops everything.
     */
    const val ACTION_CANCEL = "com.anjouinc.peardrop.action.CANCEL_TRANSFERS"

    /** The JS-side event name. Must match `EVENT_CANCEL_ALL` in foregroundService.ts. */
    const val EVENT_CANCEL_ALL = "PeardropCancelAllTransfers"

    @Volatile private var currentCancelLabel: String = "Cancel"

    /**
     * Set when a cancel was requested but could not be delivered to JS.
     *
     * The emit needs a live `ReactContext`. The foreground service exists
     * precisely to keep the process (and therefore the JS thread) alive, so
     * the expected case is that one is available — but "expected" is not
     * "guaranteed", and a cancel the user tapped that silently evaporates is
     * the worst outcome available here.
     *
     * So a failed emit is recorded instead, and `drainPendingCancel` lets the
     * JS side pick it up on its next foreground transition. Same shape as
     * `outcomes`/`drainOutcomes` below, and for the same reason: a pull is
     * the only delivery that does not depend on the other realm being ready
     * at the moment of the push.
     */
    private val pendingCancel = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Take the pending-cancel flag, clearing it. */
    fun drainPendingCancel(): Boolean = pendingCancel.getAndSet(false)

    /**
     * Rebuild the ongoing notification from the current title/text/percent.
     *
     * Shared by `onStartCommand` (which passes it to `startForeground`) and
     * by `updateNotification` (which re-posts it under the same id).
     */
    fun buildNotification(context: Context): Notification {
      val builder = Notification.Builder(context, CHANNEL_ID)
        .setContentTitle(currentTitle)
        .setContentText(currentText)
        .setSmallIcon(R.drawable.notification_icon)
        .setOngoing(true)
        // Suppress the timestamp: an ongoing transfer notification showing a
        // start time reads as a missed event rather than as work in progress.
        .setShowWhen(false)
      if (currentPercent in 0..100) {
        builder.setProgress(100, currentPercent, false)
      } else {
        builder.setProgress(0, 0, true)
      }

      // tapping the body opens the app; without this Cancel is the only
      // working target, i.e. a destructive action as the sole affordance.
      //
      // getActivity, not getService: a service PendingIntent would deliver to
      // onStartCommand and open no UI. The launcher intent resumes the
      // existing task rather than stacking a second MainActivity.
      //
      // No setAutoCancel: the notification belongs to a running foreground
      // service, and dismissing it on tap would detach the user from it.
      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (launchIntent != null) {
        builder.setContentIntent(
          PendingIntent.getActivity(
            context,
            CONTENT_REQUEST_CODE,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
          )
        )
      }

      // the Cancel action.
      //
      // FLAG_IMMUTABLE is mandatory from API 31 and this app targets 36; a
      // mutable PendingIntent would throw at creation. It is also correct on
      // the merits — nothing downstream needs to fill in extras, so handing
      // out a fillable intent would be pure attack surface.
      //
      // FLAG_UPDATE_CURRENT so repeated posts reuse one PendingIntent rather
      // than accumulating; the intent never varies, so there is nothing to
      // update, but it keeps the system from holding stale copies.
      val cancelIntent = Intent(context, TransferService::class.java).apply {
        action = ACTION_CANCEL
      }
      val cancelPending = PendingIntent.getService(
        context,
        CANCEL_REQUEST_CODE,
        cancelIntent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
      builder.addAction(
        Notification.Action.Builder(
          null as android.graphics.drawable.Icon?,
          currentCancelLabel,
          cancelPending
        ).build()
      )

      return builder.build()
    }

    /**
     * Refresh the notification in place. No-op if the service is not running:
     * Android drops a `notify` for an id no foreground service owns, so this
     * cannot resurrect a stopped service.
     */
    fun updateNotification(
      context: Context,
      title: String,
      text: String,
      percent: Int,
      cancelLabel: String
    ) {
      currentTitle = title
      currentText = text
      currentPercent = percent
      // blank would render an unlabelled button, which is worse
      // than a slightly stale one.
      if (cancelLabel.isNotBlank()) currentCancelLabel = cancelLabel
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      ensureChannel(context)
      manager.notify(NOTIFICATION_ID, buildNotification(context))
    }

    /**
     * Registered here rather than from JS because the service can be started
     * before any JS-side channel registration has run, and posting to a
     * missing channel is dropped silently by Android.
     *
     * IMPORTANCE_LOW: no sound, no heads-up. The existing "transfers" channel
     * is IMPORTANCE_DEFAULT and would alert on every start; channel
     * importance is frozen after creation, so a separate channel is the only
     * way to get a quiet ongoing notification.
     */
    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Transfer in progress",
        NotificationManager.IMPORTANCE_LOW
      )
      channel.description = "Shown while a transfer is running in the background."
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /**
   * hand the cancel to the JS realm.
   *
   * This is the FIRST native→JS push in this app — every other bridge call
   * here is JS-initiated, and `drainServiceLog` is pull-based precisely
   * because push did not exist.
   *
   * `ReactApplication.reactHost` rather than `reactNativeHost`: the app runs
   * `newArchEnabled=true` (android/gradle.properties:38) on RN 0.81.6, where
   * `reactNativeHost` is deprecated for exactly this and `ReactHost` is the
   * bridgeless accessor. `ReactHost.currentReactContext` is nullable by
   * declaration, and `ReactContext.emitDeviceEvent` is RN's own public
   * helper over `getJSModule(RCTDeviceEventEmitter)`.
   *
   * **This is an event, not a timer.** Delivery rides the bridge's call
   * queue, so it does not depend on the Choreographer-driven `setInterval`
   * that this project has measured as dead in the background. That is the
   * whole reason this design can work with the screen locked — but it has
   * not been observed on a device yet, and it is tagged INFERRED until it is.
   *
   * Returns false when no context was available, so the caller can fall back
   * to the pending flag rather than dropping the user's tap.
   */
  private fun emitCancelToJs(): Boolean {
    return try {
      val host = (application as? com.facebook.react.ReactApplication)?.reactHost
      val reactContext = host?.currentReactContext
      if (reactContext == null) {
        record("cancel: no ReactContext — queued for drain")
        false
      } else {
        reactContext.emitDeviceEvent(EVENT_CANCEL_ALL)
        record("cancel: emitted $EVENT_CANCEL_ALL to JS")
        true
      }
    } catch (e: Exception) {
      record("cancel: emit THREW ${e.javaClass.simpleName}: ${e.message ?: ""}")
      false
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // the notification's Cancel button arrives here.
    //
    // Handled BEFORE `startForeground`, and returns early. Re-promoting on a
    // cancel would be wrong in both directions: the service is already
    // foreground (the notification the user just tapped is proof), and
    // re-posting would redraw a progress bar for a transfer that is being
    // stopped.
    //
    // The service does NOT stop itself here. Releasing it is the JS side's
    // job, through the single `isTransferActive` predicate that already owns
    // the lifecycle — a second stop path is how the two halves of a
    // start/stop pair drift apart. The cancel reaches the engine, the engine
    // emits `transfer-cancelled`, the predicate goes false, and the existing
    // release effect stops the service and takes the notification with it.
    if (intent?.action == ACTION_CANCEL) {
      Log.i(TAG, "cancel action received startId=$startId")
      record("cancel: action received startId=$startId")
      if (!emitCancelToJs()) pendingCancel.set(true)
      return START_NOT_STICKY
    }

    ensureChannel(this)

    // real progress, not a static string. Built from whatever the
    // JS side last pushed via `update`, so a restart mid-transfer keeps the
    // current figure rather than resetting to a generic line.
    val notification: Notification = buildNotification(this)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      Log.i(TAG, "startForeground ok startId=$startId")
      // The notification passed above IS the evidence: a visible ongoing
      // notification means this call succeeded. Recorded so an exported log
      // says so too, since the shade is not in the log.
      record("startForeground ok startId=$startId sdk=${Build.VERSION.SDK_INT}")
    } catch (e: Exception) {
      // On Android 12+ a background start throws
      // ForegroundServiceStartNotAllowedException. That is a RESULT of this
      // spike, not a crash: record it and stop rather than taking the app
      // down.
      Log.e(TAG, "startForeground threw: ${e.javaClass.simpleName}: ${e.message}")
      record("startForeground THREW ${e.javaClass.simpleName}: ${e.message ?: ""}")
      stopSelf()
      return START_NOT_STICKY
    }

    // Not sticky: if the system kills this, silently restarting it would
    // muddy the measurement.
    return START_NOT_STICKY
  }

  /**
   * Android 15's dataSync foreground-service timeout.
   *
   * A dataSync service gets roughly six hours in any 24, after which the
   * system calls this and expects `stopSelf` promptly; not stopping throws
   * ForegroundServiceDidNotStopInTimeException and takes the app down. This
   * is unreachable in a twenty-minute borrowed-device session and entirely
   * reachable if someone taps Start and walks away, which is exactly why it
   * is here.
   *
   * Both overloads are overridden: API 35 calls the one-argument form, and
   * API 36 added the two-argument one. Target SDK is 36, so which arrives
   * depends on the device, and the handling is identical either way.
   */
  override fun onTimeout(startId: Int) {
    Log.i(TAG, "onTimeout startId=$startId — stopping")
    record("onTimeout startId=$startId — stopped cleanly")
    stopSelf()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.i(TAG, "onTimeout startId=$startId fgsType=$fgsType — stopping")
    record("onTimeout startId=$startId fgsType=$fgsType — stopped cleanly")
    stopSelf()
  }

  override fun onDestroy() {
    Log.i(TAG, "onDestroy")
    record("onDestroy")
    super.onDestroy()
  }
}
