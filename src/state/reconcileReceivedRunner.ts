import RNFS from "react-native-fs";

import {
  reconcileReceivedFiles,
  type EngineDriveLike,
} from "../lib/reconcileReceived";
import { appendDownloadResults, loadDownloaded } from "./receivedFilesStorage";
// The recovery must reach the store the rendered list is built from.
import { markFilesDownloaded } from "./receivedSharesStorage";
import { extractKey } from "../lib/links";
import { log as debugLog } from "../lib/debugLog";

/**
 * Apply the reconcile diff to storage. Split from the pure diff so the
 * decision logic stays unit-testable and this file holds only the effects.
 * It does not touch lifetime stats: those are a monotonic counter with no
 * per-drive provenance, so a reconcile that ran twice would double-count.
 * Silent by design — files reappearing in the list is the outcome, and
 * announcing a recovery advertises a failure the user never saw.
 */
export async function runReceivedReconcile(
  drives: EngineDriveLike[] | null | undefined,
  reason: string
): Promise<number> {
  try {
    // `loadDownloaded` drops entries whose file is gone, so what comes back
    // both exists and is recorded. That filter is also why a user-deleted
    // file cannot be resurrected here, even if it is briefly re-proposed.
    const recorded = await loadDownloaded();
    const { groups, totalFiles } = reconcileReceivedFiles({ drives, recorded });
    if (totalFiles === 0) return 0;

    // Verify each candidate is on disk before writing it: a deleted file
    // stays in the engine's list forever, so without this every reconcile
    // re-proposes it and writes a dead entry on every foreground. The check
    // lives here, not in the pure diff, so that module stays free of
    // filesystem imports. Only candidates are stat'd, and once converged
    // there are none.
    let wrote = 0;
    /** Files also written back into the store the rendered list reads. */
    let healed = 0;
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

      /**
       * The per-file write above reaches a store the list does not render,
       * so the repair has to reach the share store too. `markFilesDownloaded`
       * is a no-op when no share record exists, which is correct here: the
       * record is upserted during the resolve, before the download starts.
       * Inventing one from engine data would make this a second, competing
       * writer of the store the UI reads. Failure is swallowed per group so
       * one stubborn record cannot abort recovery for the other drives.
       */
      const shareKey = group.shareLink ? extractKey(group.shareLink) : null;
      if (shareKey) {
        try {
          await markFilesDownloaded(
            shareKey,
            present.map((f) => ({ name: f.name, localPath: f.path, size: f.size })),
          );
          healed += present.length;
        } catch {
          /* best-effort — the index write above already landed */
        }
      }
    }

    if (wrote === 0) return 0;

    debugLog(
      "warn",
      "rn.reconcile",
      `recovered ${wrote} file(s) across ${groups.length} drive(s) on ${reason} ` +
        `(${totalFiles} proposed, ${totalFiles - wrote} skipped as gone from disk, ` +
        `${healed} shown in the list) — ` +
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
