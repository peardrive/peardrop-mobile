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
 * Applies the reconcile diff; the pure diff stays testable and this file holds only effects. It
 * does not touch lifetime stats — a monotonic counter with no provenance would double-count.
 */
export async function runReceivedReconcile(
  drives: EngineDriveLike[] | null | undefined,
  reason: string
): Promise<number> {
  try {
    // `loadDownloaded` drops entries whose file is gone, which is also why a user-deleted file
    // cannot be resurrected here even if it is briefly re-proposed.
    const recorded = await loadDownloaded();
    const { groups, totalFiles } = reconcileReceivedFiles({ drives, recorded });
    if (totalFiles === 0) return 0;

    // Verify each candidate is on disk first: a deleted file stays in the engine's list forever,
    // so without this every reconcile re-proposes it and writes a dead entry on each foreground.
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
       * `markFilesDownloaded` is a no-op with no share record, which is correct — the record is
       * upserted during the resolve. Failure is swallowed per group so one record cannot abort the rest.
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
