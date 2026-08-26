import RNFS from "react-native-fs";

import {
  reconcileReceivedFiles,
  type EngineDriveLike,
} from "../lib/reconcileReceived";
import { appendDownloadResults, loadDownloaded } from "./receivedFilesStorage";
import { log as debugLog } from "../lib/debugLog";

/**
 * Apply the reconcile diff to storage.
 *
 * Split from the pure diff in `lib/reconcileReceived.ts` so the decision
 * logic stays unit-testable and this file holds only the effects. Nothing
 * here is clever — it loads, diffs, and writes back.
 *
 * Deliberately NOT touching `statsStorage`: lifetime totals are a monotonic
 * counter with no per-drive provenance, so a reconcile that ran twice would
 * double-count. Under-reporting the lifetime figure by the bytes of a lost
 * download is strictly better than inflating it on every resume.
 *
 * Also deliberately silent — no toast, no notification. Files reappearing
 * in the list is the correct outcome; announcing "we recovered 3 files"
 * would advertise a failure the user never saw and cannot act on.
 */
export async function runReceivedReconcile(
  drives: EngineDriveLike[] | null | undefined,
  reason: string
): Promise<number> {
  try {
    // `loadDownloaded` filters out entries whose file is gone from disk, so
    // what comes back is what genuinely exists AND is recorded. That same
    // existence filter is why a user-deleted file cannot be resurrected
    // here: `deleteDownloaded` unlinks the file as well as dropping the
    // entry, so a deleted path is absent from disk and stays invisible even
    // if it is briefly re-proposed.
    const recorded = await loadDownloaded();
    const { groups, totalFiles } = reconcileReceivedFiles({ drives, recorded });
    if (totalFiles === 0) return 0;

    // Verify each candidate is actually on disk before writing
    // it. Without this, a file the user deleted stays in the engine's
    // `localFiles` forever, so every reconcile re-proposed it, wrote a dead
    // entry, and the next `loadDownloaded` discarded it — correct in the UI
    // but a write on every foreground, growing with each deletion.
    //
    // The check lives here, not in the pure diff, so that module stays free
    // of filesystem imports and remains unit-testable.
    //
    // Cost is bounded and small: only candidates are stat'd, not the whole
    // record, and once converged there are no candidates at all — the
    // steady state is zero extra calls.
    let wrote = 0;
    for (const group of groups) {
      const present: typeof group.files = [];
      for (const file of group.files) {
        try {
          if (await RNFS.exists(file.path)) present.push(file);
        } catch {
          // An unreadable path is treated as absent: proposing it would
          // write an entry `loadDownloaded` would discard anyway.
        }
      }
      if (present.length === 0) continue;
      await appendDownloadResults(present, group.shareLink, group.downloadedAt);
      wrote += present.length;
    }

    if (wrote === 0) return 0;

    debugLog(
      "warn",
      "rn.reconcile",
      `recovered ${wrote} file(s) across ${groups.length} drive(s) on ${reason} ` +
        `(${totalFiles} proposed, ${totalFiles - wrote} skipped as gone from disk) — ` +
        groups.map((g) => `${g.driveId}:${g.files.length}`).join(" "),
    );
    return wrote;
  } catch (err: unknown) {
    // Never let recovery break boot or resume. A failed reconcile just
    // means the files stay hidden until the next attempt.
    debugLog(
      "error",
      "rn.reconcile",
      `reconcile failed on ${reason} — ${String((err as Error)?.message || err)}`,
    );
    return 0;
  }
}
