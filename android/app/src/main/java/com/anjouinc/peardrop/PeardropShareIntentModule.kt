package com.anjouinc.peardrop

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.IntentCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/** Receives `SEND` / `SEND_MULTIPLE` and copies the streams into cache while the grant is alive. */
// The copy cannot wait for JS: the grant dies on process death and when the task leaves recents.
class PeardropShareIntentModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "PeardropShareIntent"

    /** Must match `EVENT_SHARE_INTENT` in `src/lib/shareIntent.ts`; no module spans the boundary. */
    const val EVENT = "PeardropShareIntent"

    /** Written onto the Intent after it is read, so a recreation re-reading the same object skips it. */
    private const val EXTRA_CONSUMED = "com.anjouinc.peardrop.SHARE_CONSUMED"

    /** Saved by `MainActivity`, so a restored activity can tell itself apart from a launched one. */
    const val STATE_SHARE_SEEN = "peardrop.shareHandled"

    /** Copies carry this prefix so the launch sweep and the delete path can recognise their own. */
    const val CACHE_PREFIX = "peardrop-share"

    /** Renamed off on success, so an interrupted copy is never mistaken for a whole file. */
    private const val PART_SUFFIX = ".part"

    /** Below this the share is refused: the cache copy and the drive blob each hold the bytes. */
    private const val SPACE_FACTOR = 2

    /** A stream that delivers nothing for this long is dropped, matching the engine's per-file wait. */
    private const val READ_STALL_MS = 60_000L

    /** Written as an escape, never as a literal byte: a control byte makes the file binary to ripgrep,
     * which then skips it silently while traversing a directory. See the same note in pendingIntents.ts. */
    private const val SEP = "\u001f"

    private const val PROGRESS_INTERVAL_MS = 250L
    private const val COPY_BUFFER = 256 * 1024

    /** The newest state, held for a share that arrived before any ReactContext existed. */
    // Only a terminal state clears on read, so a mid-copy mount still finds the progress it missed.
    private val latest = AtomicReference<String?>(null)

    private fun record(line: String) {
      Log.i(TAG, line)
    }

    /** What `onCreate` saw, on every launch, so a gate reads a line rather than a silence. */
    fun recordCreate(restored: Boolean, intent: Intent?) {
      record("onCreate: restored=$restored action=${intent?.action ?: "none"} flags=0x${
        java.lang.Integer.toHexString(intent?.flags ?: 0)
      }")
    }

    /** A restored activity re-receives a task's root SEND intent after a process kill, carrying
     *  no history flag and with the in-process marker gone. This is the guard that sees it. */
    fun markRestored(intent: Intent?) {
      val action = intent?.action
      val share = action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE
      if (share) intent?.putExtra(EXTRA_CONSUMED, true)
      // Logged either way, and naming the action: silence here would leave the gate reading an
      // absence, and an absence is the one thing this project does not accept as evidence.
      record("skip (restored): action=${action ?: "none"} share=$share")
    }

    /** Offer an intent. Returns the share id if it was taken, null if a guard refused it. */
    fun offer(activity: Activity, intent: Intent?, reason: String): String? {
      if (intent == null) return null
      val action = intent.action
      if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

      // Recents re-delivers the original launch intent, and this flag is the only reliable
      // discriminator. With the in-process marker below it is the whole of exactly-once.
      if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
        record("skip ($reason): launched from history")
        return null
      }
      if (intent.getBooleanExtra(EXTRA_CONSUMED, false)) {
        record("skip ($reason): already consumed in this process")
        return null
      }

      val items = readItems(activity, intent)
      val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
      val shareId = shareIdOf(action, items, text)

      intent.putExtra(EXTRA_CONSUMED, true)
      record("accept ($reason): id=$shareId items=${items.size} text=${text.isNotEmpty()}")

      if (items.isEmpty()) {
        // Text-only. The JS side decides whether it is a share link or a plain notice.
        publish(activity, textState(shareId, text))
        return shareId
      }

      publish(activity, startState(shareId, items))
      val appContext = activity.applicationContext
      Thread { runCopy(appContext, shareId, items) }.start()
      return shareId
    }

    // ---- reading the intent ------------------------------------------------

    /** What the provider says about one shared stream. A null size means it would not say. */
    private data class Item(
      val uri: Uri,
      val displayName: String,
      val size: Long?,
      val mimeType: String
    )

    private fun readItems(context: Context, intent: Intent): List<Item> {
      val uris = ArrayList<Uri>()
      if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
          ?.let { for (u in it) if (u != null) uris.add(u) }
      } else {
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
          ?.let { uris.add(it) }
      }
      return uris.map { describe(context, it) }
    }

    /** `OpenableColumns` first; the URI's own last segment is the fallback and may carry no extension. */
    private fun describe(context: Context, uri: Uri): Item {
      var name = ""
      var size: Long? = null
      try {
        context.contentResolver.query(
          uri,
          arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
          null,
          null,
          null
        )?.use { cursor ->
          if (cursor.moveToFirst()) {
            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIdx >= 0 && !cursor.isNull(nameIdx)) name = cursor.getString(nameIdx) ?: ""
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
          }
        }
      } catch (e: Exception) {
        record("query threw for $uri: ${e.javaClass.simpleName}")
      }
      if (name.isBlank()) name = uri.lastPathSegment?.substringAfterLast('/').orEmpty()
      val mime = try {
        context.contentResolver.getType(uri).orEmpty()
      } catch (e: Exception) {
        ""
      }
      val reported = size
      return Item(uri, name.trim(), if (reported != null && reported >= 0) reported else null, mime)
    }

    /** A digest of what was shared, stable across process death. Hex and short because it
     *  travels as a `pendingIntents` value, whose separator argument forbids control bytes. */
    private fun shareIdOf(action: String?, items: List<Item>, text: String): String {
      val joined = buildString {
        append(action.orEmpty())
        for (u in items.map { it.uri.toString() }.sorted()) {
          append(SEP)
          append(u)
        }
        append(SEP)
        append(text)
      }
      val digest = MessageDigest.getInstance("SHA-256").digest(joined.toByteArray())
      return digest.take(8).joinToString("") { String.format("%02x", it) }
    }

    // ---- the copy ----------------------------------------------------------

    private fun runCopy(context: Context, shareId: String, items: List<Item>) {
      val knownTotal = items.sumOf { it.size ?: 0L }
      val free = try {
        context.cacheDir.usableSpace
      } catch (e: Exception) {
        Long.MAX_VALUE
      }
      // An unknown size cannot be checked, so the known part is checked and the rest proceeds.
      if (knownTotal > 0 && free < knownTotal * SPACE_FACTOR) {
        record("refuse id=$shareId need=${knownTotal * SPACE_FACTOR} free=$free")
        publish(context, errorState(shareId, "no-space", knownTotal * SPACE_FACTOR, free))
        return
      }

      val copied = JSONArray()
      val dropped = JSONArray()
      var done = 0L
      var lastEmit = 0L

      for ((index, item) in items.withIndex()) {
        val stamp = "${System.currentTimeMillis().toString(36)}_$index"
        val leaf = sanitizeLeaf(item.displayName, index, item.mimeType)
        val dest = File(context.cacheDir, "$CACHE_PREFIX-${stamp}_$leaf")
        val part = File(dest.path + PART_SUFFIX)
        var written = 0L
        try {
          context.contentResolver.openInputStream(item.uri).use { input ->
            if (input == null) throw java.io.IOException("no input stream")
            FileOutputStream(part).use { output ->
              val buffer = ByteArray(COPY_BUFFER)
              var lastReadAt = System.currentTimeMillis()
              while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                if (n == 0) {
                  // A provider fetching from the network can return nothing for a while; the
                  // engine's per-file wait is the precedent for how long that may go on.
                  if (System.currentTimeMillis() - lastReadAt > READ_STALL_MS) {
                    throw java.io.IOException("stalled: no data for ${READ_STALL_MS / 1000}s")
                  }
                  continue
                }
                output.write(buffer, 0, n)
                written += n
                done += n
                lastReadAt = System.currentTimeMillis()
                val now = System.currentTimeMillis()
                if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                  lastEmit = now
                  publish(
                    context,
                    progressState(shareId, done, knownTotal, index, items.size, item.displayName)
                  )
                }
              }
            }
          }
          // A short copy against a size the provider stated is a truncated file, and a truncated
          // file seeds happily — so it is dropped rather than shared.
          val expected = item.size
          if (expected != null && expected > 0 && written != expected) {
            throw java.io.IOException("size mismatch: got $written of $expected")
          }
          if (!part.renameTo(dest)) throw java.io.IOException("rename failed")
          copied.put(
            JSONObject()
              .put("displayName", item.displayName)
              .put("size", written)
              .put("mimeType", item.mimeType)
              .put("path", dest.absolutePath)
          )
        } catch (e: Exception) {
          record("drop id=$shareId item=$index: ${e.javaClass.simpleName}: ${e.message ?: ""}")
          try { part.delete() } catch (_: Exception) {}
          try { dest.delete() } catch (_: Exception) {}
          dropped.put(
            JSONObject()
              .put("displayName", item.displayName)
              .put("reason", e.javaClass.simpleName)
          )
        }
      }

      record("done id=$shareId copied=${copied.length()} dropped=${dropped.length()} bytes=$done")
      publish(
        context,
        JSONObject()
          .put("phase", "done")
          .put("shareId", shareId)
          .put("files", copied)
          .put("dropped", dropped)
          .toString()
      )
    }

    /** One path component. The extension is load-bearing, not cosmetic: the engine derives a
     *  share's in-drive extension from this basename, so a missing one is supplied from the MIME. */
    private fun sanitizeLeaf(raw: String, index: Int, mimeType: String): String {
      var base = raw.replace('\\', '/').substringAfterLast('/').trim()
        .replace(Regex("[^A-Za-z0-9._ ()\\-]"), "_")
      if (base.isEmpty() || base == "." || base == "..") base = "item$index"
      base = base.take(96)
      if (Regex("\\.[A-Za-z0-9]{1,8}$").containsMatchIn(base)) return base
      val ext = try {
        android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
      } catch (e: Exception) {
        null
      }
      return if (ext.isNullOrBlank()) base else "$base.$ext"
    }

    // ---- states ------------------------------------------------------------

    private fun startState(shareId: String, items: List<Item>): String {
      val array = JSONArray()
      for (i in items) {
        array.put(
          JSONObject()
            .put("displayName", i.displayName)
            .put("size", i.size ?: JSONObject.NULL)
            .put("mimeType", i.mimeType)
        )
      }
      return JSONObject()
        .put("phase", "start")
        .put("shareId", shareId)
        .put("items", array)
        .put("totalBytes", items.sumOf { it.size ?: 0L })
        .toString()
    }

    private fun progressState(
      shareId: String,
      copied: Long,
      total: Long,
      index: Int,
      count: Int,
      name: String
    ): String = JSONObject()
      .put("phase", "progress")
      .put("shareId", shareId)
      .put("copiedBytes", copied)
      .put("totalBytes", total)
      .put("index", index)
      .put("count", count)
      .put("displayName", name)
      .toString()

    private fun textState(shareId: String, text: String): String = JSONObject()
      .put("phase", "text")
      .put("shareId", shareId)
      .put("text", text)
      .toString()

    private fun errorState(shareId: String, code: String, need: Long, free: Long): String =
      JSONObject()
        .put("phase", "error")
        .put("shareId", shareId)
        .put("code", code)
        .put("needBytes", need)
        .put("freeBytes", free)
        .toString()

    private fun isTerminal(json: String): Boolean {
      val phase = try {
        JSONObject(json).optString("phase")
      } catch (e: Exception) {
        ""
      }
      return phase == "done" || phase == "error" || phase == "text"
    }

    /** Emit live when a ReactContext exists, and hold the newest state either way. */
    private fun publish(context: Context, json: String) {
      latest.set(json)
      try {
        val host = (context.applicationContext as? com.facebook.react.ReactApplication)?.reactHost
        host?.currentReactContext?.emitDeviceEvent(EVENT, json)
      } catch (e: Exception) {
        record("emit threw: ${e.javaClass.simpleName}")
      }
    }

    /** The newest state. A terminal one clears as it is read; progress stays for the next mount. */
    fun drain(): String? {
      val json = latest.get() ?: return null
      if (isTerminal(json)) latest.compareAndSet(json, null)
      return json
    }

    /** Leftover copies from a kill mid-copy, and from a boot that never reached the share flow. */
    fun sweep(context: Context, keep: Set<String>): Int {
      var removed = 0
      try {
        val files = context.cacheDir.listFiles() ?: return 0
        for (f in files) {
          if (!f.name.startsWith(CACHE_PREFIX)) continue
          if (!f.name.endsWith(PART_SUFFIX) && keep.contains(f.absolutePath)) continue
          if (f.delete()) removed++
        }
      } catch (e: Exception) {
        record("sweep threw: ${e.javaClass.simpleName}")
      }
      if (removed > 0) record("sweep removed=$removed")
      return removed
    }
  }

  override fun getName(): String = "PeardropShareIntent"

  /** Resolves the newest state as a JSON string, or null. Never rejects: a mount must not throw. */
  @ReactMethod
  fun drainShareIntent(promise: Promise) {
    try {
      promise.resolve(drain())
    } catch (e: Exception) {
      promise.resolve(null)
    }
  }

  /** Delete cache copies this module made, except the paths the caller says are still in use. */
  // The caller passes every path a live share holds, so a sweep cannot take one out from under it.
  @ReactMethod
  fun sweepShareCopies(keep: com.facebook.react.bridge.ReadableArray, promise: Promise) {
    try {
      val set = HashSet<String>()
      for (i in 0 until keep.size()) keep.getString(i)?.let { set.add(it) }
      promise.resolve(sweep(reactApplicationContext, set))
    } catch (e: Exception) {
      promise.resolve(0)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter on Android; the emit path needs no registration.
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    // Counterpart to addListener, for the same reason.
  }
}
