import { formatBytes, formatBytesOrUnknown } from "./format";

/**
 * How much of a received share is actually on this device.
 *
 * ## The defect
 *
 * The row's byte total summed **every file in the manifest**, with no
 * `isDownloaded` filter. The number was truthful and it answered the wrong
 * question: *"what was sent"*, not *"what do I have"*. A share where 3 of 12
 * files landed rendered **identically** to one where all 12 did — and because
 * the sum is recomputed from the stored manifest on every launch, **that is the
 * steady state of every received share after a restart**, not an edge case.
 * The row shows a state that is not true.
 *
 * ## Where it could NOT be shown
 *
 * Not the File-info panel. `richFiles` in `MainScreen.tsx` carries `name`,
 * `size`, `previewUri` and `videoUri` and **no download state at all**, so any
 * fix proposing that panel proposes a surface without the data.
 * `ReceivedFileInfoModal.tsx`, which might plausibly have had it, is never
 * mounted. So the row itself is the place, which is also where the user reads
 * the wrong number today.
 *
 * ## Why a pure module
 *
 * `MainScreen.tsx` is unreachable from the suite — `testMatch` collects only
 * `*.test.ts` and no `.test.tsx` exists. Same as
 * `src/lib/hostedRowStatus.ts`.
 *
 * No progress bar, speed or ETA here: `useTransferRate` is dead, and the
 * folder modal owns the per-file ladder.
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
 * Count what the device actually holds.
 *
 * "Held" requires **both** `isDownloaded` and a `localPath` — the same pair the
 * row's `localFiles` derivation uses. A flag without a path is not a file you
 * can open, and the flag itself is only as good as its last existence check.
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
