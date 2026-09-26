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

/**
 * put a received file somewhere the user can actually find it.
 *
 * ## Why this is native rather than JS
 *
 * Received files live in `<DocumentDirectory>/peardrop/downloads/`, which is
 * app-private. Sprint 9D shipped "Save a copy", which hands the file to
 * another app through the share sheet — genuinely useful, and not the same
 * thing as putting it in a folder on the phone.
 *
 * The folder version is not buildable from what is installed. Verified at 9G
 * against the installed sources:
 *
 *  - `expo-file-system@19.0.21` legacy `copyAsync` branches on the SOURCE
 *    scheme and resolves every destination through `toUri.toFile()`
 *    (FileSystemLegacyModule.kt:289-345). There is no `content://`
 *    destination branch, so SAF is supported as a source and never as a sink.
 *  - The newer unified `copy()` is `javaFile.copyRecursively`
 *    (FileSystemPath.kt:130-137) — `java.io.File` throughout.
 *  - `StorageAccessFramework.copyAsync` / `.moveAsync` are ALIASES for those
 *    same two functions, not separate implementations. The namespace looks
 *    like it can copy into SAF and cannot.
 *  - The only SAF write expo exposes is `createFileAsync` +
 *    `writeAsStringAsync(base64)`, which decodes the whole file in memory
 *    (`Base64.decode(contents)`, FileSystemLegacyModule.kt:209-221). The file
 *    exists as a JS string, a Java String and a decoded byte array at once —
 *    roughly 700 MB of heap for a 200 MB video. That is the OOM class Sprint
 *    3E removed from the engine, and re-adding it on the save path was not
 *    acceptable.
 *  - `react-native-fs@2.20.0` (installed, used in ten files) cannot do it
 *    either: its only MediaStore reference is a READ that resolves a content
 *    URI back to a legacy path (RNFSManager.java:95). No insert, no write.
 *  - `expo-media-library` is out on two independent grounds — it declares the
 *    `READ_MEDIA_*` permissions this project strips by hand-edit, and it
 *    files assets into MEDIA collections, so a received `.zip` or `.apk` has
 *    no media type to be filed under.
 *
 * ## MediaStore needs no permission at this minSdk
 *
 * `minSdk` is 29 and `targetSdk` resolves to 36 (read from merged release
 * manifest output, not from the gradle source — `targetSdk` is inherited from
 * the Expo SDK and moves without a change in this repo).
 *
 * From API 29 an app may insert its own entry into the Downloads collection
 * and write through the returned URI with **no storage permission at all**.
 * `WRITE_EXTERNAL_STORAGE` is ignored from 29 and gone from 30; this app caps
 * it at `maxSdkVersion=28` and adds nothing here. No manifest line, no
 * `<queries>` entry, no Play declaration, no runtime prompt.
 *
 * ## IS_PENDING is the platform's version of `.peardrop-part`
 *
 * The entry is inserted with `IS_PENDING = 1`, which hides it from every
 * other app until the copy finishes and the flag is cleared. A process killed
 * mid-copy therefore leaves nothing half-visible in Downloads — the same
 * property 9G's `.peardrop-part` suffix buys on the receive path, except here
 * the platform does the work.
 *
 * On any failure after the insert the pending row is deleted, so a failed
 * save leaves no trace rather than an invisible orphan.
 */
class SaveToDownloadsModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    /**
     * where saved files land, as MediaStore's `RELATIVE_PATH`.
     *
     * Collision behaviour is unchanged by the subfolder and is deliberately
     * still the platform's: MediaStore appends " (1)" to the display name
     * within this directory. The app adds no dedupe of its own — a second
     * scheme layered on the platform's would disagree with it at some
     * boundary, and the `name` this module reports is read back from the
     * store precisely so whatever MediaStore decided is what the user is
     * told.
     */
    // `val`, not `const val`: `Environment.DIRECTORY_DOWNLOADS` is a Java
    // static field rather than a Kotlin compile-time constant, so a `const`
    // initializer referencing it does not compile. Deriving from the platform
    // constant is still worth the non-const — hardcoding "Download" would
    // silently disagree with the OS if it ever differed.
    val DOWNLOAD_SUBDIR = "${Environment.DIRECTORY_DOWNLOADS}/PearDrop"
  }

  override fun getName(): String = "PeardropSaveToDownloads"

  /**
   * Copy an app-private file into the public Downloads collection.
   *
   * Resolves `{ ok: true, name, uri, path }` or `{ ok: false, code, message }`.
   * It never rejects — the same convention as `TransferServiceModule`, and the
   * same `{ok:false, error}` idiom the engine uses everywhere. A rejected
   * promise on a user-initiated save turns into an unhandled rejection the
   * moment a caller forgets a `.catch`, and this is called from a menu tap.
   *
   * `name` is what MediaStore ACTUALLY used, read back from the store rather
   * than echoed from the request. MediaStore auto-disambiguates a collision by
   * appending " (1)" to the display name; the engine's `uniquePath` produces
   * the same shape by its own arithmetic, so the two agree by coincidence and
   * not by construction. Reporting the requested name would eventually tell
   * the user to look for a file that is not there.
   */
  @ReactMethod
  fun saveToDownloads(
    srcPath: String,
    displayName: String,
    mimeType: String,
    promise: Promise
  ) {
    // Off the native-modules thread: this is an unbounded file copy, and that
    // thread is shared with every other bridge call in the app — including
    // `drainServiceLog` and `isScreenInteractive`, which run on the freeze
    // path. Blocking it for the length of a multi-gigabyte copy would stall
    // instrumentation that exists to observe exactly this kind of moment.
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

    // MediaStore rejects a DISPLAY_NAME containing a path separator, and a
    // peer-supplied name reaches here. The engine's `safePathWithin` already
    // guards the receive path, but this is a second entry point and must not
    // depend on that having run.
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
      // a PearDrop subfolder rather than the Downloads root, so a
      // user with a busy Downloads folder can find what this app put there.
      //
      // MediaStore creates the directory itself as part of the insert — do
      // NOT `mkdirs` it. At minSdk 29 (verified from the merged release
      // manifest, not the gradle source) the app has no permission to create
      // a public directory directly, and does not need one.
      //
      // There is no pre-29 branch to write for the same reason: 29 IS the
      // floor, so the legacy public-directory write and the
      // `WRITE_EXTERNAL_STORAGE` it would need are both unreachable. That
      // permission is capped at `maxSdkVersion=28` in the manifest precisely
      // so it can never be requested on a supported device.
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
      // Leave no invisible orphan behind. Best-effort: if the delete itself
      // fails there is nothing further we can do, and the row stays pending,
      // which is still not visible to the user.
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
      // The file IS saved at this point. Falling back to the requested name
      // is a slightly wrong label on a successful save, which is much better
      // than reporting a failure for one.
    }

    Arguments.createMap().apply {
      putBoolean("ok", true)
      putString("name", finalName)
      putString("uri", uri.toString())
      // For display. Not a path the app can open — it is where the user will
      // see the file in a file manager, and it must match the folder they
      // actually have to navigate to.
      putString("path", "$DOWNLOAD_SUBDIR/$finalName")
      // the folder alone, so the JS side names the destination
      // without reconstructing it from a string it did not build.
      putString("folder", DOWNLOAD_SUBDIR)
    }
  }
}
