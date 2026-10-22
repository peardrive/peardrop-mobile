import { formatBytes, formatBytesOrUnknown } from "./format";

/**
 * How much of a received share is actually on this device. Summing the whole manifest answers
 * "what was sent", not "what do I have" — and after a restart that is every received share.
 */

/** The subset of a stored share file this needs. Structural, not an import. */
export type HoldingFile = {
  size?: number | null;
  isDownloaded?: boolean | null;
  localPath?: string | null;
};

export type Holdings = {
  /** Files with a local copy recorded. */
  heldCount: number;
  /** Files in the manifest. */
  totalCount: number;
  /** Bytes of the held files only. `0` when none or when sizes are unknown. */
  heldBytes: number;
  /** Bytes of the whole share as the sender described it. */
  totalBytes: number;
  /** Every manifest file is held. A share with no files is NOT complete. */
  allHeld: boolean;
};

/**
 * "Held" requires BOTH `isDownloaded` and a `localPath`: a flag without a path is not a file the
 * user can open, and the flag is only as good as its last existence check.
 */
export function describeHoldings(files: readonly HoldingFile[]): Holdings {
  let heldCount = 0;
  let heldBytes = 0;
  let totalBytes = 0;
  for (const f of files) {
    const size = typeof f?.size === "number" && Number.isFinite(f.size) ? Math.max(0, f.size) : 0;
    totalBytes += size;
    if (f?.isDownloaded && f.localPath) {
      heldCount += 1;
      heldBytes += size;
    }
  }
  const totalCount = files.length;
  return {
    heldCount,
    totalCount,
    heldBytes,
    totalBytes,
    allHeld: totalCount > 0 && heldCount === totalCount,
  };
}

/**
 * The count half of the row's status line — `"12 Files"` when the share is
 * complete, `"3 of 12 Files"` when it is not.
 *
 * Single-file shares get no count at all: *"1 of 1 Files"* is noise, and
 * *"0 of 1 Files"* says less than the row's own state label already does.
 * `noun` is passed in so this module holds no opinion about the type prefix.
 */
export function holdingsCountLabel(h: Holdings, noun: string): string {
  if (h.totalCount <= 1) return noun;
  if (h.allHeld) return `${h.totalCount} ${noun}`;
  return `${h.heldCount} of ${h.totalCount} ${noun}`;
}

/**
 * The bytes half — `"4.5 GB"` when complete, `"1.2 GB of 4.5 GB"` when not.
 *
 * Uses `formatBytesOrUnknown` for the total, so a manifest that carried no
 * sizes reads as `—` rather than asserting `0 B`. The held figure still uses
 * `formatBytes`, because when something is held its size is measured rather
 * than reported — `0 B` there would be a real zero.
 */
export function holdingsBytesLabel(h: Holdings): string {
  const total = formatBytesOrUnknown(h.totalBytes);
  if (h.allHeld || h.heldCount === 0) return total;
  return `${formatBytes(h.heldBytes)} of ${total}`;
}
