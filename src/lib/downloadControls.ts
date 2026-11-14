/**
 * What the three-dots menu offers for a download, decided from the row's own record.
 *
 * One line changes the state: "Pause" while the download may still run by itself, "Resume" once
 * the person paused it. One line removes it: "Cancel" while it is unfinished, "Delete" once it is
 * not. There is no "Retry now" and no "Stop waiting": a row that is waiting retries by itself, and
 * a person who wants it to stop pauses it.
 */

import { pauseNeedsUser, type PauseReason, type RowStatus } from "./rowLifecycle";

export type DownloadRecordLike = {
  readonly status: RowStatus | string;
  readonly selection?: readonly string[] | null;
  readonly pauseReason?: PauseReason | string | null;
  readonly files: readonly { readonly isDownloaded?: boolean }[];
};

export type DownloadControls = {
  /** The one line that changes the state, or null when the row has neither. */
  readonly toggle: "pause" | "resume" | null;
  /** The last line of the menu. */
  readonly remove: "cancel" | "delete";
  /** At least one file is fully here, so Cancel can offer to keep it. */
  readonly keepFinished: boolean;
};

/** The statuses of a download that was asked for and has not finished. */
const UNFINISHED: readonly string[] = ["queued", "downloading", "paused", "stopped"];

/** Has the person asked for files that have not all arrived? */
export function isUnfinishedDownload(record: DownloadRecordLike | null | undefined): boolean {
  if (!record) return false;
  return UNFINISHED.includes(record.status) && (record.selection?.length ?? 0) > 0;
}

export function downloadControls(record: DownloadRecordLike | null | undefined): DownloadControls {
  const keepFinished = !!record?.files.some((f) => f.isDownloaded === true);
  if (!record || !isUnfinishedDownload(record)) {
    return { toggle: null, remove: "delete", keepFinished };
  }
  if (record.status === "stopped") return { toggle: "resume", remove: "cancel", keepFinished };
  // A download held up by this device (no space, cannot save) or by files the sender took away is
  // not something pausing helps with, so the line that needs the person stands alone.
  const reason = (record.pauseReason ?? null) as PauseReason | null;
  const needsPerson =
    record.status === "paused" && (pauseNeedsUser(reason) || reason === "filesGone");
  return { toggle: needsPerson ? null : "pause", remove: "cancel", keepFinished };
}

export type CancelConfirmCopy = {
  readonly title: string;
  readonly body: string;
  /** Deletes the row and everything that arrived. */
  readonly deleteLabel: string;
  /** Stops the download and keeps the files already here. Null when there are none. */
  readonly keepLabel: string | null;
  /** Closes the window and changes nothing. */
  readonly backLabel: string;
};

/** The words of the window Cancel opens. Cancel ends the download for good; it only asks what happens to what arrived. */
export function describeCancelConfirm(keepFinished: boolean): CancelConfirmCopy {
  if (keepFinished) {
    return {
      title: "Cancel this download?",
      body: "The download stops for good. Keep the files that already finished, or delete everything.",
      deleteLabel: "Delete everything",
      keepLabel: "Keep finished files",
      backLabel: "Keep downloading",
    };
  }
  return {
    title: "Cancel this download?",
    body: "The download stops for good and what has arrived so far is deleted. Can't undo.",
    deleteLabel: "Cancel download",
    keepLabel: null,
    backLabel: "Keep downloading",
  };
}
