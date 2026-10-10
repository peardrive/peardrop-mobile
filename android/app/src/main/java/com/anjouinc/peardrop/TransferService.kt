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

/** The dataSync service and its two rows; the lifecycle rule and all copy come from the RN side. */
class TransferService : Service() {

  companion object {
    /** The receive row's channel. Separate so it can be muted on its own. */
    const val CHANNEL_RECEIVING = "transfer-receiving"

    /** The share row's channel. */
    const val CHANNEL_SHARING = "transfer-sharing"

    /** Deleted on first run so it cannot sit in settings as a toggle that
     * controls nothing. The `transfers` completion channel is untouched. */
    private const val LEGACY_CHANNEL_ID = "transfer-service"

    /** Each row keeps a fixed id and channel: a channel is frozen at first post. */
    const val RECEIVING_NOTIFICATION_ID = 4714
    const val SHARING_NOTIFICATION_ID = 4715

    private const val TAG = "PeardropFgs"

    /** Request code for the Receiving row's Cancel action. */
    private const val CANCEL_REQUEST_CODE = 4712

    /**
     * Request code for a body tap.
     *
     * Must differ from CANCEL_REQUEST_CODE: an equal code with equal flags
     * makes the two PendingIntents the same object, and the body tap would
     * fire Cancel.
     */
    private const val CONTENT_REQUEST_CODE = 4713

    /** `percent` sentinels. Must match `src/lib/notificationContent.ts`. */
    private const val PROGRESS_INDETERMINATE = -1
    private const val PROGRESS_NONE = -2

    /** `serviceRow` values. Must match `ServiceRowId` in the same module. */
    const val ROW_RECEIVING = "receiving"
    const val ROW_SHARING = "sharing"

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
     * What each row says. Static so `applyRows` can refresh them without a
     * binder, and the first `startForeground` carries real content.
     */
    @Volatile private var recvPresent: Boolean = true
    @Volatile private var recvTitle: String = "PearDrop"
    @Volatile private var recvText: String = "Connecting…"
    @Volatile private var recvSubline: String = ""
    @Volatile private var recvPercent: Int = PROGRESS_INDETERMINATE

    @Volatile private var sharePresent: Boolean = false
    @Volatile private var shareTitle: String = ""
    @Volatile private var shareText: String = ""
    @Volatile private var shareSubline: String = ""
    @Volatile private var sharePercent: Int = PROGRESS_NONE

    @Volatile private var serviceRow: String = ROW_RECEIVING

    /**
     * Stops receiving only. The scope is in the name on both sides of the
     * bridge, and the JS half filters to downloads.
     */
    const val ACTION_CANCEL_RECEIVING = "com.anjouinc.peardrop.action.CANCEL_RECEIVING"

    /** Must match `EVENT_CANCEL_RECEIVING` in `foregroundService.ts`: no module
     * is shared, so a rename has to touch both. */
    const val EVENT_CANCEL_RECEIVING = "PeardropCancelReceiving"

    /**
     * Set when a cancel was requested but could not be delivered to JS.
     *
     * `currentReactContext` can be null, so a failed emit is queued here and
     * drained on the next foreground transition rather than dropped.
     */
    private val pendingCancel = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Take the pending-cancel flag, clearing it. */
    fun drainPendingCancel(): Boolean = pendingCancel.getAndSet(false)

    /**
     * Set only after a successful `onStartCommand` and cleared in `onDestroy`,
     * so a re-bind cannot be attempted against a service that is not up.
     */
    @Volatile private var running: TransferService? = null

    /** Which notification id `startForeground` is currently bound to. */
    @Volatile private var foregroundId: Int = RECEIVING_NOTIFICATION_ID

    private fun serviceNotificationId(): Int =
      if (serviceRow == ROW_SHARING) SHARING_NOTIFICATION_ID else RECEIVING_NOTIFICATION_ID

    /**
     * `withCancel` is passed rather than derived from the channel, so intent
     * is explicit at the call site.
     */
    private fun buildRow(
      context: Context,
      channelId: String,
      title: String,
      text: String,
      subline: String,
      percent: Int,
      withCancel: Boolean
    ): Notification {
      val builder = Notification.Builder(context, channelId)
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(R.drawable.notification_icon)
        .setOngoing(true)
        // Suppress the timestamp: an ongoing transfer notification showing a
        // start time reads as a missed event rather than as work in progress.
        .setShowWhen(false)

      // The collapsed template has no third text line, so the sub-line goes in
      // the header beside the app name.
      if (subline.isNotBlank()) builder.setSubText(subline)

      // `PROGRESS_NONE` is the Sharing row, a status rather than a transfer, so
      // `setProgress` is skipped instead of asked for a zero-length bar.
      if (percent >= 0) {
        builder.setProgress(100, percent, false)
      } else if (percent == PROGRESS_INDETERMINATE) {
        builder.setProgress(0, 0, true)
      }

      // Tapping the body opens the app, so Cancel is not the row's only
      // working target.
      //
      // getActivity, not getService: a service PendingIntent would deliver to
      // onStartCommand and open no UI. The launcher intent resumes the
      // existing task rather than stacking a second MainActivity.
      //
      // No setAutoCancel: the row belongs to a running foreground service, and
      // dismissing it on tap would detach the user from it.
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

      if (withCancel) {
        // `FLAG_IMMUTABLE` is mandatory from API 31 and nothing downstream fills
        // extras; `FLAG_UPDATE_CURRENT` keeps repeated posts to one intent.
        val cancelIntent = Intent(context, TransferService::class.java).apply {
          action = ACTION_CANCEL_RECEIVING
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
            // The row title already states the scope, so the label need not.
            "Cancel",
            cancelPending
          ).build()
        )
      }

      return builder.build()
    }

    private fun buildReceiving(context: Context): Notification =
      buildRow(
        context,
        CHANNEL_RECEIVING,
        recvTitle,
        recvText,
        recvSubline,
        recvPercent,
        withCancel = true
      )

    private fun buildSharing(context: Context): Notification =
      buildRow(
        context,
        CHANNEL_SHARING,
        shareTitle,
        shareText,
        shareSubline,
        sharePercent,
        withCancel = false
      )

    fun buildServiceNotification(context: Context): Notification =
      if (serviceNotificationId() == SHARING_NOTIFICATION_ID) buildSharing(context)
      else buildReceiving(context)

    /**
     * Re-binds to the new service row before cancelling any row, because a
     * foreground service's own notification ignores `cancel`.
     */
    fun applyRows(
      context: Context,
      receivingPresent: Boolean,
      receivingTitle: String,
      receivingText: String,
      receivingSubline: String,
      receivingPercent: Int,
      sharingPresent: Boolean,
      sharingTitle: String,
      sharingText: String,
      sharingSubline: String,
      sharingPercent: Int,
      nextServiceRow: String
    ) {
      recvPresent = receivingPresent
      recvTitle = receivingTitle
      recvText = receivingText
      recvSubline = receivingSubline
      recvPercent = receivingPercent
      sharePresent = sharingPresent
      shareTitle = sharingTitle
      shareText = sharingText
      shareSubline = sharingSubline
      sharePercent = sharingPercent
      if (nextServiceRow == ROW_RECEIVING || nextServiceRow == ROW_SHARING) {
        serviceRow = nextServiceRow
      }

      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      ensureChannels(context)

      val svc = running ?: return
      val wantedId = serviceNotificationId()
      if (wantedId != foregroundId) {
        svc.promote(wantedId, buildServiceNotification(context))
        foregroundId = wantedId
        record("serviceRow -> $serviceRow id=$wantedId")
      }

      // Each row is re-posted or cancelled on its own id; `notify` on the
      // foreground id is an in-place refresh and cannot revive a stopped service.
      if (recvPresent) manager.notify(RECEIVING_NOTIFICATION_ID, buildReceiving(context))
      else if (RECEIVING_NOTIFICATION_ID != foregroundId) manager.cancel(RECEIVING_NOTIFICATION_ID)

      if (sharePresent) manager.notify(SHARING_NOTIFICATION_ID, buildSharing(context))
      else if (SHARING_NOTIFICATION_ID != foregroundId) manager.cancel(SHARING_NOTIFICATION_ID)
    }

    /** Remove both rows. Called on every path that ends the service. */
    fun clearRows(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      manager.cancel(RECEIVING_NOTIFICATION_ID)
      manager.cancel(SHARING_NOTIFICATION_ID)
    }

    /**
     * Registered here rather than from JS because the service can be started
     * before any JS-side channel registration has run, and posting to a
     * missing channel is dropped silently by Android.
     *
     * Both are low importance and badge-free; channel importance is frozen after
     * creation, so quiet ongoing rows need channels of their own.
     */
    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return

      if (manager.getNotificationChannel(CHANNEL_RECEIVING) == null) {
        val channel = NotificationChannel(
          CHANNEL_RECEIVING,
          "Receiving files",
          NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Shown while files are being received in the background."
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }

      if (manager.getNotificationChannel(CHANNEL_SHARING) == null) {
        val channel = NotificationChannel(
          CHANNEL_SHARING,
          "Sharing files",
          NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Shown while your shares are available to download."
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }

      if (manager.getNotificationChannel(LEGACY_CHANNEL_ID) != null) {
        manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /**
   * Re-bind `startForeground` to a different row's id.
   *
   * Instance-side because `startForeground` is; called only on a row change.
   */
  private fun promote(id: Int, notification: Notification) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(id, notification)
      }
    } catch (e: Exception) {
      record("promote THREW ${e.javaClass.simpleName}: ${e.message ?: ""}")
    }
  }

  /**
   * `currentReactContext` is nullable, so this returns false when none exists
   * and the caller queues the tap instead of dropping it.
   */
  private fun emitCancelToJs(): Boolean {
    return try {
      val host = (application as? com.facebook.react.ReactApplication)?.reactHost
      val reactContext = host?.currentReactContext
      if (reactContext == null) {
        record("cancel: no ReactContext — queued for drain")
        false
      } else {
        reactContext.emitDeviceEvent(EVENT_CANCEL_RECEIVING)
        record("cancel: emitted $EVENT_CANCEL_RECEIVING to JS")
        true
      }
    } catch (e: Exception) {
      record("cancel: emit THREW ${e.javaClass.simpleName}: ${e.message ?: ""}")
      false
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // The Receiving row's Cancel arrives here.
    //
    // Handled BEFORE `startForeground`, and returns early. Re-promoting on a
    // cancel would be wrong in both directions: the service is already
    // foreground (the notification the user just tapped is proof), and
    // re-posting would redraw a progress bar for a transfer being stopped.
    //
    // The service does NOT stop itself here. Releasing it is the JS side's
    // job, through the single `isTransferActive` predicate that already owns
    // the lifecycle. The engine's `transfer-cancelled` flips the predicate, and
    // the existing release path stops the service and takes both rows with it.
    if (intent?.action == ACTION_CANCEL_RECEIVING) {
      Log.i(TAG, "cancel-receiving action received startId=$startId")
      record("cancel-receiving: action received startId=$startId")
      if (!emitCancelToJs()) pendingCancel.set(true)
      return START_NOT_STICKY
    }

    ensureChannels(this)

    // Built from whatever JS last pushed, so a restart mid-transfer keeps the
    // current figure rather than resetting to a generic line.
    val id = serviceNotificationId()
    val notification: Notification = buildServiceNotification(this)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(id, notification)
      }
      foregroundId = id
      running = this
      Log.i(TAG, "startForeground ok startId=$startId id=$id row=$serviceRow")
      // The notification passed above IS the evidence: a visible ongoing
      // notification means this call succeeded. Recorded so an exported log
      // says so too, since the shade is not in the log.
      record("startForeground ok startId=$startId id=$id row=$serviceRow sdk=${Build.VERSION.SDK_INT}")
    } catch (e: Exception) {
      // On Android 12+ a background start throws
      // ForegroundServiceStartNotAllowedException. Record it and stop rather
      // than taking the app down.
      Log.e(TAG, "startForeground threw: ${e.javaClass.simpleName}: ${e.message}")
      record("startForeground THREW ${e.javaClass.simpleName}: ${e.message ?: ""}")
      running = null
      stopSelf()
      return START_NOT_STICKY
    }

    // Not sticky: if the system kills this, silently restarting it would
    // muddy the measurement.
    return START_NOT_STICKY
  }

  /**
   * A dataSync service gets about six hours in any 24, and not stopping on this
   * call crashes the app. Both overloads clear the rows, which only it removes.
   */
  override fun onTimeout(startId: Int) {
    Log.i(TAG, "onTimeout startId=$startId — stopping")
    record("onTimeout startId=$startId — stopped cleanly")
    clearRows(this)
    stopSelf()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.i(TAG, "onTimeout startId=$startId fgsType=$fgsType — stopping")
    record("onTimeout startId=$startId fgsType=$fgsType — stopped cleanly")
    clearRows(this)
    stopSelf()
  }

  override fun onDestroy() {
    Log.i(TAG, "onDestroy")
    record("onDestroy")
    // The backstop for "no row outlives the service": every ending path routes
    // through here, so a future stop cannot forget it.
    running = null
    clearRows(this)
    // Reset so the next start cannot inherit a stale row; the receive defaults
    // are the honest "connecting" state.
    recvPresent = true
    recvTitle = "PearDrop"
    recvText = "Connecting…"
    recvSubline = ""
    recvPercent = PROGRESS_INDETERMINATE
    sharePresent = false
    serviceRow = ROW_RECEIVING
    foregroundId = RECEIVING_NOTIFICATION_ID
    super.onDestroy()
  }
}
