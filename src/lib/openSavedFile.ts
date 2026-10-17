/** Opening a saved file in one place, because the row and the picker both do it. */
// The caller supplies how to report a failure, so this stays free of the toast context and any surface can reach it.

import { Linking, Platform } from "react-native";
import * as FileSystemLegacy from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";

import { baseName, fileExt, mimeFromName } from "./files";
import { describeOpenFailure } from "./openFileResult";
import { logStructuredError } from "./debugLog";

/** Open a path with whatever app the system picks. The failure callback receives a line already fit to show a user; the raw native message goes to the log. */
export async function openSavedFile(
  path: string,
  onFailure: (message: string) => void,
): Promise<void> {
  try {
    const fileUri = path.startsWith("file://") ? path : `file://${path}`;
    if (Platform.OS === "android") {
      const contentUri = await FileSystemLegacy.getContentUriAsync(fileUri);
      // The resolved result is read, not discarded: a launch that starts an activity which refuses and finishes immediately still resolves successfully, and that silent path looked like nothing happened.
      const startedAt = Date.now();
      const result = await IntentLauncher.startActivityAsync(
        "android.intent.action.VIEW",
        {
          data: contentUri,
          flags: 1,
          type: mimeFromName(baseName(path)),
        },
      );
      const failure = describeOpenFailure({
        resultCode: Number(result?.resultCode),
        elapsedMs: Date.now() - startedAt,
        ext: fileExt(baseName(path)),
      });
      if (failure) onFailure(failure);
      return;
    }
    await Linking.openURL(fileUri);
  } catch (e: unknown) {
    logStructuredError("rn.open", "openURL failed", e);
    onFailure("Can't open that one. Try another app?");
  }
}
