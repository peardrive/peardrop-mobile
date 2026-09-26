import RNFS from "react-native-fs";
import { readJsonFile, writeJsonAtomic } from "../lib/atomicFile";
import { planReceivedDelete } from "../lib/deleteReceivedPlan";
import { demoteMissingFile } from "../lib/receivedFileHealth";
import { baseName } from "../lib/files";
import { extractKey, normalizeShareLink } from "../lib/links";
import {
  applyReceivedDeletePlan,
  loadDownloaded,
  type DownloadedItem,
} from "./receivedFilesStorage";

/**
 * Per-share identity model: the unit is the share, not the file, keyed by
 * the public key from the link. Each record carries the manifest's file
 * list with per-file flags and local paths. A side-store rather than the
 * engine manifest because the engine mints a fresh driveId per open, so one
 * logical share pasted twice produces two engine entries; this keys on the
 * share key so the UI shows one row.
 */

export type ReceivedShareFile = {
  /** File name from the share's manifest (often basename). */
  name: string;
  /** Path within the share (for nested files in folder shares). */
  path?: string;
  size: number;
  isDownloaded: boolean;
  /** Local on-disk path when isDownloaded === true. */
  localPath?: string;
  downloadedAt?: number;
};

export type ReceivedShare = {
  shareKey: string;
  shareLink: string;
  shareName: string;
  firstSeenAt: number;
  lastUpdatedAt: number;
  files: ReceivedShareFile[];
  /** Organizational flags. Older records have no value here, and readers
   *  treat an absent one as `false`. */
  isPinned?: boolean;
  isFavorite?: boolean;
  /**
   * The engine `driveId` this share was most recently opened as. Persisted
   * because the derived share-key index is rebuilt in memory each launch and
   * does not survive a restart. Absent on older records, and absence means
   * not known: fall back to the derived index rather than concluding the
   * share cannot be opened. The engine mints a fresh id per open, so this is
   * the latest session's id; the share key remains the identity.
   */
  driveId?: string;
  /**
   * The folder this share's files were downloaded into. The engine's own
   * copy is in-memory and dies with the session, so without this a resumed
   * grab cannot target the folder the first pass used and re-fetches land
   * as duplicates instead of skips. Absent on older records and on a share
   * that has never completed a grab; absence means not known.
   */
  downloadFolder?: string;
};

const STORAGE_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-received-shares.json`;
const MIGRATION_FLAG_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-shares-migrated.flag`;

type Listener = (shares: ReceivedShare[]) => void;
const listeners = new Set<Listener>();
let cache: ReceivedShare[] | null = null;

function sanitizeFile(raw: unknown): ReceivedShareFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : null;
  if (!name) return null;
  return {
    name,
    path: typeof r.path === "string" ? r.path : undefined,
    size: typeof r.size === "number" && Number.isFinite(r.size) ? Math.max(0, r.size) : 0,
    isDownloaded: r.isDownloaded === true,
    localPath: typeof r.localPath === "string" ? r.localPath : undefined,
    downloadedAt:
      typeof r.downloadedAt === "number" && Number.isFinite(r.downloadedAt)
        ? r.downloadedAt
        : undefined,
  };
}

function sanitize(raw: unknown): ReceivedShare[] {
  if (!Array.isArray(raw)) return [];
  const out: ReceivedShare[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const shareKey = typeof r.shareKey === "string" ? r.shareKey.toLowerCase() : null;
    const shareLink = typeof r.shareLink === "string" ? r.shareLink : null;
    if (!shareKey || !shareLink) continue;
    const firstSeenAt =
      typeof r.firstSeenAt === "number" && Number.isFinite(r.firstSeenAt)
        ? r.firstSeenAt
        : Date.now();
    const lastUpdatedAt =
      typeof r.lastUpdatedAt === "number" && Number.isFinite(r.lastUpdatedAt)
        ? r.lastUpdatedAt
        : firstSeenAt;
    const files = Array.isArray(r.files)
      ? (r.files.map(sanitizeFile).filter(Boolean) as ReceivedShareFile[])
      : [];
    out.push({
      shareKey,
      shareLink,
      shareName: typeof r.shareName === "string" ? r.shareName : "Share",
      firstSeenAt,
      lastUpdatedAt,
      files,
      isPinned: r.isPinned === true,
      isFavorite: r.isFavorite === true,
      // Unlike the two flags above, these are not coerced to a default: an
      // older record has no value, and an empty one would be a lie about
      // which drive and which folder. Absent stays absent.
      driveId: typeof r.driveId === "string" && r.driveId ? r.driveId : undefined,
      downloadFolder:
        typeof r.downloadFolder === "string" && r.downloadFolder ? r.downloadFolder : undefined,
    });
  }
  return out;
}

/**
 * `readJsonFile` separates a missing file from a parse failure from an
 * unreadable one, so a fresh install cannot be mistaken for a torn write,
 * and renames a damaged file aside before the next write can put an empty
 * list over it.
 */
async function readFromDisk(): Promise<ReceivedShare[]> {
  const result = await readJsonFile(STORAGE_FILE);
  if (result.status === "ok") return sanitize(result.value);
  // `missing`, `corrupt` and `unreadable` all yield an empty list, but the last
  // two have already been logged and preserved by `readJsonFile`.
  return [];
}

/**
 * Temp file plus rename, never a bare write onto the final path: a kill
 * part-way through would truncate the real store. The failure is swallowed
 * — the in-memory cache stays accurate for this session, and the on-disk
 * file is the previous good one either way.
 */
async function writeToDisk(shares: ReceivedShare[]): Promise<void> {
  try {
    await writeJsonAtomic(STORAGE_FILE, shares);
  } catch {
    // best-effort — in-memory cache stays accurate this session
  }
}

function emit(next: ReceivedShare[]) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {
      // shield other listeners from a throwing one
    }
  }
}

/**
 * One-time migration from the per-file store to the per-share shape: group
 * the existing items by share link, synthesize one record per group, and
 * write the result. A marker file stops it running twice. Items with no
 * share link are skipped, since this shape cannot represent a download with
 * no share identity, and they stay reachable through the per-file store.
 */
async function migrateFromLegacyIfNeeded(): Promise<void> {
  try {
    if (await RNFS.exists(MIGRATION_FLAG_FILE)) return;
  } catch {
    // If the flag check fails, attempt migration anyway — it's idempotent.
  }

  let legacy: DownloadedItem[] = [];
  try {
    legacy = await loadDownloaded();
  } catch {
    legacy = [];
  }

  if (legacy.length === 0) {
    try {
      await RNFS.writeFile(MIGRATION_FLAG_FILE, String(Date.now()), "utf8");
    } catch {
      /* flag write failure is non-fatal */
    }
    return;
  }

  // Group by normalized share link. Entries without a link are dropped from
  // the per-share model (they remain in legacy storage for back-compat).
  const grouped = new Map<string, DownloadedItem[]>();
  for (const item of legacy) {
    if (!item.shareLink) continue;
    const norm = normalizeShareLink(item.shareLink);
    if (!norm) continue;
    const arr = grouped.get(norm) ?? [];
    arr.push(item);
    grouped.set(norm, arr);
  }

  const existing = await readFromDisk();
  const merged = new Map<string, ReceivedShare>(
    existing.map((s) => [s.shareKey, s]),
  );

  for (const [link, items] of grouped) {
    const key = extractKey(link);
    if (!key) continue;
    const downloadedFiles: ReceivedShareFile[] = items.map((it) => ({
      name: baseName(it.name),
      size: it.size ?? 0,
      isDownloaded: true,
      localPath: it.path,
      downloadedAt: it.downloadedAt,
    }));
    const earliest = Math.min(
      ...items.map((it) =>
        typeof it.downloadedAt === "number" ? it.downloadedAt : Date.now(),
      ),
    );
    const latest = Math.max(
      ...items.map((it) =>
        typeof it.downloadedAt === "number" ? it.downloadedAt : Date.now(),
      ),
    );
    const existingShare = merged.get(key);
    if (existingShare) {
      // Merge legacy files into the existing record — keep the existing
      // metadata and union the files by basename.
      const byName = new Map<string, ReceivedShareFile>(
        existingShare.files.map((f) => [baseName(f.name), f]),
      );
      for (const df of downloadedFiles) {
        byName.set(baseName(df.name), df);
      }
      merged.set(key, {
        ...existingShare,
        files: Array.from(byName.values()),
        lastUpdatedAt: Math.max(existingShare.lastUpdatedAt, latest),
      });
    } else {
      merged.set(key, {
        shareKey: key,
        shareLink: link,
        shareName: "Recovered share",
        firstSeenAt: earliest,
        lastUpdatedAt: latest,
        files: downloadedFiles,
      });
    }
  }

  const next = Array.from(merged.values());
  await writeToDisk(next);
  emit(next);
  try {
    await RNFS.writeFile(MIGRATION_FLAG_FILE, String(Date.now()), "utf8");
  } catch {
    /* flag write failure is non-fatal */
  }
}

export async function loadShares(): Promise<ReceivedShare[]> {
  if (cache) return cache;
  await migrateFromLegacyIfNeeded();
  cache = await readFromDisk();
  return cache;
}

export async function loadShare(shareKey: string): Promise<ReceivedShare | null> {
  const k = String(shareKey || "").toLowerCase();
  if (!k) return null;
  const list = await loadShares();
  return list.find((s) => s.shareKey === k) ?? null;
}

export async function upsertShare(share: ReceivedShare): Promise<ReceivedShare[]> {
  const list = await loadShares();
  const idx = list.findIndex((s) => s.shareKey === share.shareKey);
  let next: ReceivedShare[];
  if (idx >= 0) {
    next = [...list];
    /**
     * A spread preserves an omitted key but not one present and undefined,
     * which is what a literal built from an engine reply carries. Silently
     * spreading that over the stored value would erase the two fields the
     * re-grab path needs, so they are merged explicitly: a defined incoming
     * value wins, undefined keeps what is on disk. Not generalised to every
     * field — a re-resolve carries newer truth about the name and files.
     */
    const prev = list[idx];
    next[idx] = {
      ...prev,
      ...share,
      driveId: share.driveId ?? prev?.driveId,
      downloadFolder: share.downloadFolder ?? prev?.downloadFolder,
    };
  } else {
    next = [share, ...list];
  }
  await writeToDisk(next);
  emit(next);
  return next;
}

/**
 * Persist the engine session facts a re-grab needs, without disturbing the
 * file list. Separate from `upsertShare`, which runs on a resolve when the
 * manifest is the news; this runs after a grab, when the only new facts are
 * which drive served it and where the bytes landed. Folding them together
 * would force a caller holding one fact to rebuild a whole record, which is
 * how the spread above erases fields. A no-op when the share is not on
 * record; callers establish it with `upsertShare` first.
 */
export async function rememberDriveSession(
  shareKey: string,
  facts: { driveId?: string | null; downloadFolder?: string | null },
): Promise<ReceivedShare[]> {
  const k = String(shareKey || "").toLowerCase();
  if (!k) return loadShares();
  const list = await loadShares();
  const idx = list.findIndex((s) => s.shareKey === k);
  if (idx < 0) return list;
  const prev = list[idx];
  if (!prev) return list;

  // An empty string is neither a driveId nor a folder, and storing one
  // would persist a falsehood that reads as known at every call site.
  const driveId = typeof facts.driveId === "string" && facts.driveId ? facts.driveId : undefined;
  const downloadFolder =
    typeof facts.downloadFolder === "string" && facts.downloadFolder
      ? facts.downloadFolder
      : undefined;

  // Nothing new to say. Return without a write so a grab that reports no
  // destDir does not bump `lastUpdatedAt` and re-sort the user's list.
  if (
    (driveId === undefined || driveId === prev.driveId) &&
    (downloadFolder === undefined || downloadFolder === prev.downloadFolder)
  ) {
    return list;
  }

  const next = [...list];
  next[idx] = {
    ...prev,
    driveId: driveId ?? prev.driveId,
    downloadFolder: downloadFolder ?? prev.downloadFolder,
    lastUpdatedAt: Date.now(),
  };
  await writeToDisk(next);
  emit(next);
  return next;
}

/**
 * Mark a subset of a share's files as downloaded, supplying the local
 * paths. Updates `lastUpdatedAt`. If no matching share exists, this is a
 * no-op — callers should `upsertShare` first to establish the record.
 */
export async function markFilesDownloaded(
  shareKey: string,
  files: { name: string; localPath: string; size?: number }[],
): Promise<ReceivedShare[]> {
  const k = String(shareKey || "").toLowerCase();
  const list = await loadShares();
  const idx = list.findIndex((s) => s.shareKey === k);
  if (idx < 0) return list;
  const share = list[idx];
  if (!share) return list;
  const byName = new Map(share.files.map((f) => [baseName(f.name), f]));
  const now = Date.now();
  for (const df of files) {
    const key = baseName(df.name);
    const existing = byName.get(key);
    if (existing) {
      byName.set(key, {
        ...existing,
        isDownloaded: true,
        localPath: df.localPath,
        downloadedAt: now,
        size: existing.size || df.size || 0,
      });
    } else {
      // The download finished a file the manifest did not list, which is
      // possible if the engine's manifest read missed entries. Insert it.
      byName.set(key, {
        name: key,
        size: df.size ?? 0,
        isDownloaded: true,
        localPath: df.localPath,
        downloadedAt: now,
      });
    }
  }
  const next: ReceivedShare[] = [...list];
  next[idx] = {
    ...share,
    files: Array.from(byName.values()),
    lastUpdatedAt: now,
  };
  await writeToDisk(next);
  emit(next);
  return next;
}

/**
 * Retract `isDownloaded` for a file that has turned out not to be on disk —
 * the only such transition in the tree, and what keeps a file deleted
 * outside the app from reading as present forever. Nothing here probes the
 * filesystem: the caller must have proved the file is gone, because a
 * `localPath` that is actually present is a lie this cannot detect.
 * Returns `true` when something changed.
 */
export async function markFileMissing(
  shareKey: string,
  localPath: string,
): Promise<boolean> {
  const k = String(shareKey || "").toLowerCase();
  if (!k || !localPath) return false;
  const list = await loadShares();
  const idx = list.findIndex((s) => s.shareKey === k);
  if (idx < 0) return false;
  const share = list[idx];
  if (!share) return false;
  const healed = demoteMissingFile(share.files, localPath);
  if (!healed) return false;
  const next: ReceivedShare[] = [...list];
  next[idx] = { ...share, files: healed };
  await writeToDisk(next);
  emit(next);
  return true;
}

export type DeleteShareOutcome = {
  shares: ReceivedShare[];
  /** App-owned copies actually removed from disk. */
  unlinked: string[];
  /** App-owned copies the OS would not let go of. */
  failed: string[];
  /** Paths belonging to the share that are outside the app's storage. Kept. */
  keptOutsideApp: string[];
};

/**
 * Remove the share record and the app's own copies of its files. Files first,
 * then the record: dying between them leaves a record pointing at files that are
 * gone, which the existence filter handles, while the reverse order leaves bytes
 * on the phone with nothing naming them. Copies outside the app are not touched.
 */
export async function deleteShare(shareKey: string): Promise<DeleteShareOutcome> {
  const k = String(shareKey || "").toLowerCase();
  const list = await loadShares();
  const target = list.find((s) => s.shareKey === k) ?? null;
  const next = list.filter((s) => s.shareKey !== k);

  let unlinked: string[] = [];
  let failed: string[] = [];
  let keptOutsideApp: string[] = [];

  if (target) {
    let legacy: DownloadedItem[] = [];
    try {
      legacy = await loadDownloaded();
    } catch {
      // An unreadable index must not stop the files going.
    }
    const plan = planReceivedDelete({
      shareFiles: target.files,
      legacy,
      shareLink: target.shareLink,
      documentDirectoryPath: RNFS.DocumentDirectoryPath,
      normalizeLink: normalizeShareLink,
    });
    keptOutsideApp = plan.keptOutsideApp;
    try {
      const result = await applyReceivedDeletePlan(plan);
      unlinked = result.unlinked;
      failed = result.failed;
    } catch {
      failed = plan.unlink;
    }
  }

  if (next.length === list.length) {
    return { shares: list, unlinked, failed, keptOutsideApp };
  }
  await writeToDisk(next);
  emit(next);
  return { shares: next, unlinked, failed, keptOutsideApp };
}

/** Flip a share's pin flag. `lastUpdatedAt` deliberately does not move:
 *  pinning is metadata, and bumping it would reorder the recency sort. */
export async function setSharePinned(
  shareKey: string,
  pinned: boolean,
): Promise<ReceivedShare[]> {
  const k = String(shareKey || "").toLowerCase();
  const list = await loadShares();
  const idx = list.findIndex((s) => s.shareKey === k);
  if (idx < 0) return list;
  const share = list[idx];
  if (!share) return list;
  if ((share.isPinned ?? false) === pinned) return list;
  const next: ReceivedShare[] = [...list];
  next[idx] = { ...share, isPinned: pinned };
  await writeToDisk(next);
  emit(next);
  return next;
}

export async function setShareFavorite(
  shareKey: string,
  favorite: boolean,
): Promise<ReceivedShare[]> {
  const k = String(shareKey || "").toLowerCase();
  const list = await loadShares();
  const idx = list.findIndex((s) => s.shareKey === k);
  if (idx < 0) return list;
  const share = list[idx];
  if (!share) return list;
  if ((share.isFavorite ?? false) === favorite) return list;
  const next: ReceivedShare[] = [...list];
  next[idx] = { ...share, isFavorite: favorite };
  await writeToDisk(next);
  emit(next);
  return next;
}

export function subscribeShares(listener: Listener): () => void {
  listeners.add(listener);
  if (cache) {
    try {
      listener(cache);
    } catch {
      // see emit()
    }
  } else {
    void loadShares().then((s) => {
      if (listeners.has(listener)) {
        try {
          listener(s);
        } catch {
          // see emit()
        }
      }
    });
  }
  return () => {
    listeners.delete(listener);
  };
}
