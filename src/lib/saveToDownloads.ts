import { NativeModules, Platform } from "react-native";

import type { SaveToDownloadsResult } from "./saveToDownloadsResult";

/**
 * The bridge boundary for "Save to Downloads"; the wording lives in `saveToDownloadsResult.ts`,
 * which is RN-free so jest can reach it. Native, because expo's only SAF write is base64.
 */

type SaveModule = {
  saveToDownloads: (
    srcPath: string,
    displayName: string,
    mimeType: string
  ) => Promise<SaveToDownloadsResult>;
};

const native: SaveModule | undefined = (
  NativeModules as { PeardropSaveToDownloads?: SaveModule }
).PeardropSaveToDownloads;

/**
 * Android-only by construction — MediaStore is an Android API. The `!!native` half covers a module
 * that failed to register, so the menu item is absent rather than present and broken.
 */
export function isSaveToDownloadsAvailable(): boolean {
  return Platform.OS === "android" && !!native;
}

/** Returns the structured result rather than throwing; `describeSaveResult` turns it into a line. */
export async function saveToDownloads(
  srcPath: string,
  displayName: string,
  mimeType: string
): Promise<SaveToDownloadsResult> {
  if (!native) {
    return {
      ok: false,
      code: "unavailable",
      message: "PeardropSaveToDownloads native module is not registered",
    };
  }
  try {
    return await native.saveToDownloads(srcPath, displayName, mimeType);
  } catch (err: unknown) {
    // The native side resolves rather than rejects, so reaching here means the bridge itself
    // failed. Shaped like every other failure, so callers handle one result type.
    return {
      ok: false,
      code: "bridge-threw",
      message: String((err as Error)?.message || err),
    };
  }
}
