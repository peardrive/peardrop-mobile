import { NativeModules, Platform } from "react-native";

import type { SaveToDownloadsResult } from "./saveToDownloadsResult";

/**
 * "Save to Downloads", the export route for a received file: no chooser, no
 * second app, the file lands in `Download/PearDrop`. This file is the bridge
 * boundary and holds no wording — that is `saveToDownloadsResult.ts`, which
 * is RN-free so jest can test it under `testEnvironment: "node"`. The native
 * half is `SaveToDownloadsModule.kt`, because the only SAF write expo exposes
 * materialises the whole file as a base64 string, and this app moves media.
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
 * Whether this build can save to Downloads at all. Android-only by
 * construction — `MediaStore` is an Android API and iOS has no browsable
 * Downloads folder. The `!!native` half covers a module that failed to
 * register: the menu item is then absent rather than present and broken.
 */
export function isSaveToDownloadsAvailable(): boolean {
  return Platform.OS === "android" && !!native;
}

/**
 * Copy a received file into the public Downloads folder.
 *
 * Returns the structured result rather than throwing, so the caller decides
 * what to surface; `describeSaveResult` turns it into the line to show.
 */
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
    // The native side resolves rather than rejects, so reaching here means
    // the bridge itself failed. Shaped like every other failure so callers
    // have exactly one result type to handle.
    return {
      ok: false,
      code: "bridge-threw",
      message: String((err as Error)?.message || err),
    };
  }
}
