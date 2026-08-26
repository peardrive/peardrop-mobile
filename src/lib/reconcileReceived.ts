import { baseName } from "./files";

/**
 * Work out which received files the engine has on disk but the
 * RN record never learned about.
 *
 * The bug: `engineDownload` merges `downloadedFiles` into `meta.localFiles`,
 * marks the drive INACTIVE and `await saveManifest()` (hyperdrive-engine.mjs
 * ~1964-1978) *before* emitting `upload-complete` (~2009). RN writes its own
 * record later still, inside the chain awaiting `startDownload()`
 * (ShareLinkFlowContext ~605-628). Kill the app anywhere in that span — which
 * backgrounding makes ordinary — and the engine holds durable proof of files
 * that the Received list has no record of. The files are on disk and
 * invisible.
 *
 * Deliberately pure: data in, data out. No React, no React Native, no
 * storage, no filesystem. That is what makes it reachable by jest.config.js
 * (roots `src`, testEnvironment `node`) and therefore genuinely testable
 * rather than testable-in-principle.
 *
 * Idempotent by construction: every candidate is rejected if its path is
 * already recorded, so a second run over an up-to-date record returns
 * nothing.
 */

/** One entry of the engine's `meta.localFiles`, as DRIVES_LIST returns it. */
export type EngineLocalFile = {
  /** Already a basename — the engine stores `path.basename(filePath)`. */
  name?: string | null;
  /** Absolute on-disk path. The join key. */
  path?: string | null;
  size?: number | null;
};

/** The subset of a DRIVES_LIST drive record this needs. */
export type EngineDriveLike = {
  id?: string | null;
  origin?: string | null;
  shareLink?: string | null;
  localFiles?: EngineLocalFile[] | null;
  lastActivityAt?: number | null;
  createdAt?: number | null;
};

/** The subset of a stored DownloadedItem this needs. */
export type RecordedFileLike = { path?: string | null };

/**
 * One drive's worth of recovery, shaped to feed `appendDownloadResults`
 * directly — same field names, one call per group.
 */
export type ReconcileGroup = {
  driveId: string;
  shareLink?: string;
  /** Engine's own timestamp for the download, not reconcile time. */
  downloadedAt: number;
  files: { name: string; path: string; size: number }[];
};

export type ReconcileResult = {
  groups: ReconcileGroup[];
  /** Total files across all groups — the number worth logging. */
  totalFiles: number;
};

export type ReconcileInput = {
  drives: EngineDriveLike[] | null | undefined;
  recorded: RecordedFileLike[] | null | undefined;
  /**
   * Paths to treat as deliberately absent and never re-add.
   *
   * An input rather than a hardcoded rule because the deletion story is
   * subtle: `deleteDownloaded` drops the entry AND unlinks the file, and
   * `loadDownloaded` filters every read through `RNFS.exists`, so a deleted
   * file cannot reappear in the UI even if this module re-proposes it. The
   * one gap is `deleteDownloaded`'s swallowed unlink failure — entry gone,
   * file still present — which this parameter exists to close once a caller
   * can supply it. Nothing hardcodes a policy here.
   */
  ignorePaths?: Iterable<string> | null;
  /** Fallback when a drive carries no usable timestamp. Injected for tests. */
  now?: number;
};

/** Trim and normalise a path for use as the join key. */
function keyOf(path: unknown): string {
  return typeof path === "string" ? path.trim() : "";
}

/**
 * Diff engine truth against the RN record.
 *
 * Join key is the **absolute path**, not the name. Two shares can each
 * contain `photo.jpg`; they land at different paths, so keying on path keeps
 * them distinct, whereas keying on basename would treat the second as
 * already-recorded and lose it permanently. Where two entries genuinely
 * share a path they are the same file on disk by definition, so collapsing
 * them is correct.
 */
export function reconcileReceivedFiles(input: ReconcileInput): ReconcileResult {
  const drives = Array.isArray(input?.drives) ? input.drives : [];
  const recorded = Array.isArray(input?.recorded) ? input.recorded : [];
  const now = typeof input?.now === "number" ? input.now : Date.now();

  const known = new Set<string>();
  for (const r of recorded) {
    const k = keyOf(r?.path);
    if (k) known.add(k);
  }
  for (const p of input?.ignorePaths ?? []) {
    const k = keyOf(p);
    if (k) known.add(k);
  }

  const groups: ReconcileGroup[] = [];
  let totalFiles = 0;

  for (const drive of drives) {
    if (!drive) continue;
    // Hosted drives are out of scope: their localFiles are the user's own
    // source files, which were never "received" and must not be listed as
    // downloads.
    if (drive.origin !== "received") continue;

    const local = Array.isArray(drive.localFiles) ? drive.localFiles : [];
    if (local.length === 0) continue;

    const driveId = typeof drive.id === "string" ? drive.id : "";
    if (!driveId) continue;

    const files: ReconcileGroup["files"] = [];
    for (const lf of local) {
      const path = keyOf(lf?.path);
      if (!path) continue;
      // Already recorded, already proposed by an earlier drive, or
      // explicitly ignored. Adding to `known` as we go makes the batch
      // self-deduplicating.
      if (known.has(path)) continue;

      // `name` should already be a basename, but derive it from the path
      // when absent and re-basename it regardless — a full path leaking
      // into DownloadedItem.name would show the user a path where a
      // filename belongs.
      const rawName = typeof lf?.name === "string" && lf.name.trim() ? lf.name : path;
      const name = baseName(rawName);
      if (!name) continue;

      known.add(path);
      files.push({
        name,
        path,
        size: typeof lf?.size === "number" && lf.size >= 0 ? lf.size : 0,
      });
    }

    if (files.length === 0) continue;

    groups.push({
      driveId,
      shareLink:
        typeof drive.shareLink === "string" && drive.shareLink ? drive.shareLink : undefined,
      // The engine stamps lastActivityAt in the same block that merges
      // localFiles, so it is the closest thing to the real download time.
      // Reconcile time would date recovered files "now" and float them to
      // the top of a recency-sorted list, which is a lie about when they
      // arrived.
      downloadedAt:
        typeof drive.lastActivityAt === "number"
          ? drive.lastActivityAt
          : typeof drive.createdAt === "number"
            ? drive.createdAt
            : now,
      files,
    });
    totalFiles += files.length;
  }

  return { groups, totalFiles };
}
