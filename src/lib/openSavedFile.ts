/** Handing a saved file to another app, in one place, because the row, the picker and the player all do it. */
// The caller supplies how to report a failure, so this stays free of the toast context and any surface can reach it.

import { Platform } from "react-native";
import * as FileSystemLegacy from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import * as Sharing from "expo-sharing";

import { baseName, fileExt, mimeFromName } from "./files";
import { describeOpenFailure } from "./openFileResult";
import { logStructuredError } from "./debugLog";
import { whenModalsSettled } from "./modalStackStore";

const FAILED = "Can't open that one. Try another app?";

/**
 * ASK where a saved file should go: the system's own sheet, listing the apps and actions that can
 * take it. This is what a button that says "share" or "open in another app" does, on both phones.
 *
 * On Android the sheet is the share sheet (send the file to an app). It lists what can receive
 * the file, which is not always every app that could play it; a sheet that offers "open with" and
 * "send to" together needs Android code of our own and has not been written.
 */
export async function shareSavedFile(
  path: string,
  onFailure: (message: string) => void,
): Promise<void> {
  try {
    // The sheet is dropped on iPhone if it is requested while a modal is still closing (the
    // action sheet this was chosen from), so wait for the screen to be free first.
    await whenModalsSettled();
    if (!(await Sharing.isAvailableAsync())) {
      onFailure(FAILED);
      return;
    }
    // Names with spaces, quotes or "#" are not valid in a link as they stand.
    const bare = path.replace(/^file:\/\//, "");
    const safeUri = `file://${bare.split("/").map(encodeURIComponent).join("/")}`;
    await Sharing.shareAsync(safeUri, {
      mimeType: mimeFromName(baseName(path)),
      // Android only: the line at the top of its sheet.
      dialogTitle: baseName(path),
    });
  } catch (e: unknown) {
    logStructuredError("rn.open", "share to another app failed", e);
    onFailure(FAILED);
  }
}

/**
 * OPEN a saved file the app cannot show itself, which is what tapping one means.
 *
 * Android opens it with the app the system picks for that type. iPhone has no such thing: handing
 * iOS a bare file link lets it choose an app on its own (it chose a video editor for an mp4), so
 * there it asks, with the same sheet as `shareSavedFile`.
 *
 * The failure callback receives a line already fit to show a user; the raw native message goes to
 * the log.
 */
export async function openSavedFile(
  path: string,
  onFailure: (message: string) => void,
): Promise<void> {
  if (Platform.OS !== "android") return shareSavedFile(path, onFailure);
  try {
    const fileUri = path.startsWith("file://") ? path : `file://${path}`;
    const contentUri = await FileSystemLegacy.getContentUriAsync(fileUri);
    // The resolved result is read, not discarded: a launch that starts an activity which refuses and finishes immediately still resolves successfully, and that silent path looked like nothing happened.
    const startedAt = Date.now();
    const result = await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: contentUri,
      flags: 1,
      type: mimeFromName(baseName(path)),
    });
    const failure = describeOpenFailure({
      resultCode: Number(result?.resultCode),
      elapsedMs: Date.now() - startedAt,
      ext: fileExt(baseName(path)),
    });
    if (failure) onFailure(failure);
  } catch (e: unknown) {
    logStructuredError("rn.open", "open in another app failed", e);
    onFailure(FAILED);
  }
}
