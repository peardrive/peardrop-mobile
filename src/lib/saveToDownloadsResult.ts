/**
 * what the user is told about a "Save to Downloads" attempt.
 *
 * Pure, and importing nothing, for the reason `transferActivity.ts`,
 * `notificationProgress.ts` and `openFileResult.ts` are: jest runs this suite
 * under `testEnvironment: "node"` and cannot load react-native
 * (`jest.config.js:4, 8-9`). The side-effecting half — the `NativeModules`
 * binding — lives next door in `saveToDownloads.ts`, which is not unit
 * tested and holds no wording.
 *
 * This is the file that decides every claim the app makes about where a
 * saved file went and what it is called.
 */

/**
 * What `SaveToDownloadsModule.saveToDownloads` resolves with. It never
 * rejects.
 *
 * A flat optional-field shape rather than a discriminated union on purpose.
 * Two reasons, and the second is the real one:
 *
 *  1. It matches the `{ ok, error? }` idiom the engine and every RPC result
 *    in this project already use.
 *  2. Discriminated-union narrowing needs `strictNullChecks`, and the jest
 *    transform sets `strict: false` (`jest.config.js:11`). A union here
 *    compiles under `npx tsc --noEmit` and fails under `npm test` — a shape
 *    that passes one gate and not the other is a trap, and the trap fires on
 *    whoever edits this next rather than on whoever wrote it.
 */
export type SaveToDownloadsResult = {
  ok: boolean;
  /** Success: the name MediaStore ACTUALLY assigned. See below. */
  name?: string;
  /** Success: the `content://` URI of the stored entry. */
  uri?: string;
  /** Success: `Download/PearDrop/<name>`, display only — not an openable path. */
  path?: string;
  /**
   * the destination folder as the native side built it
   * (`Download/PearDrop`). Reported rather than reconstructed here, for the
   * same reason `name` is: the module that decided the location is the one
   * that should say where it is. A copy of the path assembled in JS drifts
   * the moment the Kotlin constant changes.
   */
  folder?: string;
  /** Failure: machine-readable cause. */
  code?: string;
  /** Failure: native detail. Goes to the log, never to the user. */
  message?: string;
};

/**
 * The message to show after a save attempt.
 *
 * The success line uses the name MediaStore assigned, which the native side
 * reads back from the store rather than echoing from the request. MediaStore
 * auto-disambiguates a collision by appending " (1)"; the engine's
 * `uniquePath` produces the same shape by its own arithmetic, so the two
 * agree by coincidence rather than by construction. Reporting the requested
 * name would eventually send the user looking for a file that is not there
 * under that name — and the failure would be silent, because the save
 * itself succeeded.
 */
export function describeSaveResult(
  result: SaveToDownloadsResult
): { text: string; kind: "success" | "error" } {
  if (result.ok) {
    // `name` is always set on the success path, but this module does not get
    // to assume that — it is reading a value that crossed the bridge. The
    // fallback is deliberately vague rather than wrong.
    const name = typeof result.name === "string" ? result.name.trim() : "";
    // the message names the folder the user must actually navigate
    // to. Saying "Downloads" when the file is in "Downloads/PearDrop" sends
    // them to a folder the file is not in — for a busy Downloads folder that
    // is worse than saying nothing.
    //
    // Taken from the result, with the literal only as a fallback for a build
    // where the native side predates the field. `DOWNLOAD_SUBDIR` in
    // SaveToDownloadsModule.kt is the single source of truth.
    const folder =
      typeof result.folder === "string" && result.folder.trim()
        ? result.folder.trim()
        : "Download/PearDrop";
    return {
      text: name ? `Saved to ${folder} — ${name}` : `Saved to ${folder}.`,
      kind: "success",
    };
  }

  // `source-missing` is the one failure with a cause the user can act on:
  // the received file was deleted, or the share was purged, since the row was
  // drawn. Everything else is a device-side failure they cannot do anything
  // about, so it gets one honest line and the detail goes to the log.
  //
  // The native exception text never reaches the toast. A user cannot act on
  // "IOException: ENOSPC", and 9D's field report was that error text reading
  // like a crash is worse than no error at all.
  if (result.code === "source-missing") {
    return { text: "This file is no longer available locally.", kind: "error" };
  }
  return { text: "Couldn't save that one to Downloads.", kind: "error" };
}
