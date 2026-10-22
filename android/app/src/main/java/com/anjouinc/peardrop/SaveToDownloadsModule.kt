package com.anjouinc.peardrop

import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream

/** Copies a received file into the public Downloads collection. Native because no installed library can write into MediaStore. */
class SaveToDownloadsModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    /** Where saved files land, as MediaStore's RELATIVE_PATH; MediaStore does its own collision naming. */
    // `val`, not `const val`: Environment.DIRECTORY_DOWNLOADS is a Java static field, so a
    // const initializer referencing it does not compile.
    val DOWNLOAD_SUBDIR = "${Environment.DIRECTORY_DOWNLOADS}/PearDrop"
  }

  override fun getName(): String = "PeardropSaveToDownloads"

  /**
   * Resolves `{ok:true,name,uri,path}` or `{ok:false,code,message}` and never rejects, because a
   * menu tap that forgets a `.catch` would otherwise become an unhandled rejection. `name` is read
   * back from MediaStore, which disambiguates collisions by its own rules.
   */
  @ReactMethod
  fun saveToDownloads(
    srcPath: String,
    displayName: String,
    mimeType: String,
    promise: Promise
  ) {
    // Off the native-modules thread: an unbounded copy there would stall every other bridge call,
    // including the two that instrument the freeze path.
    Thread {
      try {
        promise.resolve(copyIntoDownloads(srcPath, displayName, mimeType))
      } catch (e: Exception) {
        promise.resolve(
          failure("save-threw", "${e.javaClass.simpleName}: ${e.message ?: ""}")
        )
      }
    }.start()
  }

  private fun failure(code: String, message: String) =
    Arguments.createMap().apply {
      putBoolean("ok", false)
      putString("code", code)
      putString("message", message)
    }

  private fun copyIntoDownloads(
    srcPath: String,
    displayName: String,
    mimeType: String
  ) = run {
    val source = File(srcPath.removePrefix("file://"))
    if (!source.exists()) return@run failure("source-missing", "File no longer exists: $srcPath")
    if (!source.isFile) return@run failure("source-not-file", "Not a file: $srcPath")

    // MediaStore rejects a DISPLAY_NAME holding a path separator, and a peer-supplied name reaches here.
    val safeName = displayName
      .replace('\\', '/')
      .substringAfterLast('/')
      .trim()
      .ifEmpty { source.name }

    val resolver = reactApplicationContext.contentResolver
    val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI

    val pending = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, safeName)
      if (mimeType.isNotBlank()) put(MediaStore.Downloads.MIME_TYPE, mimeType)
      // MediaStore creates this directory as part of the insert — do NOT mkdirs it. At minSdk 29
      // the app has no permission to create a public directory, and needs none.
      put(MediaStore.Downloads.RELATIVE_PATH, DOWNLOAD_SUBDIR)
      // Invisible to other apps until the copy completes. See the header.
      put(MediaStore.Downloads.IS_PENDING, 1)
    }

    val uri = resolver.insert(collection, pending)
      ?: return@run failure("insert-failed", "MediaStore refused to create the entry.")

    try {
      resolver.openOutputStream(uri).use { out ->
        if (out == null) throw java.io.IOException("No output stream for $uri")
        // Streaming, constant memory, no size ceiling. This is the whole
        // reason the module exists.
        FileInputStream(source).use { input -> input.copyTo(out) }
      }

      // Publish.
      resolver.update(
        uri,
        ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
        null,
        null
      )
    } catch (e: Exception) {
      // Best-effort: a row left pending is invisible to the user, so a failed delete costs nothing.
      try { resolver.delete(uri, null, null) } catch (_: Exception) {}
      return@run failure("copy-failed", "${e.javaClass.simpleName}: ${e.message ?: ""}")
    }

    // Read back what MediaStore actually named it. See the doc comment.
    var finalName = safeName
    try {
      resolver.query(
        uri,
        arrayOf(MediaStore.Downloads.DISPLAY_NAME),
        null,
        null,
        null
      )?.use { cursor ->
        if (cursor.moveToFirst()) {
          val idx = cursor.getColumnIndex(MediaStore.Downloads.DISPLAY_NAME)
          if (idx >= 0) cursor.getString(idx)?.let { finalName = it }
        }
      }
    } catch (_: Exception) {
      // The file is saved by here; a slightly wrong label beats reporting a failure.
    }

    Arguments.createMap().apply {
      putBoolean("ok", true)
      putString("name", finalName)
      putString("uri", uri.toString())
      // For display only — the folder the user must navigate to, not a path the app can open.
      putString("path", "$DOWNLOAD_SUBDIR/$finalName")
      // the folder alone, so the JS side names the destination
      // without reconstructing it from a string it did not build.
      putString("folder", DOWNLOAD_SUBDIR)
    }
  }
}
