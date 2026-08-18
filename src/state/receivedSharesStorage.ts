import RNFS from "react-native-fs";
import { baseName } from "../lib/files";
import { extractKey, normalizeShareLink } from "../lib/links";
import {
  loadDownloaded,
  type DownloadedItem,
} from "./receivedFilesStorage";

/**
 * Per-share identity model. The unit is the share, not the
 * individual file: one record per unique share key (the 64-hex public
 * key from the peardrop:// link). Each share carries the manifest's file
 * list, with per-file flags + local-path metadata for the ones that have
 * been downloaded so far.
 *
 * Why a side-store and not the engine manifest: the engine creates a fresh
 * driveId per `engineOpenDrive` call, so the same logical share produces
 * multiple engine entries if the user pastes the link more than once. This
 * storage canonicalizes around the share key so the UI can show one row.
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
  /** Organizational flags. Older records on disk return undefined here;
   *  readers treat absent values as `false`. */
  isPinned?: boolean;
  isFavorite?: boolean;
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
    });
  }
  return out;
}

async function readFromDisk(): Promise<ReceivedShare[]> {
  try {
    const exists = await RNFS.exists(STORAGE_FILE);
    if (!exists) return [];
    const raw = await RNFS.readFile(STORAGE_FILE, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeToDisk(shares: ReceivedShare[]): Promise<void> {
  try {
    await RNFS.writeFile(STORAGE_FILE, JSON.stringify(shares, null, 2), "utf8");
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
 * One-time migration from the per-file `receivedFilesStorage` to the new
 * per-share shape. Groups existing DownloadedItems by their `shareLink`,
 * synthesizes a ReceivedShare per group (with the downloaded files marked
 * `isDownloaded: true`), and writes the result. A marker file prevents
 * the migration from running twice.
 *
 * If the user has DownloadedItems without `shareLink` (very early builds),
 * they're skipped — the new storage can't represent a download with no
 * share identity, and the file itself is still accessible via the legacy
 * storage for the rest of this build's lifetime.
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
    next[idx] = { ...list[idx], ...share };
  } else {
    next = [share, ...list];
  }
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
      // The download finished a file the manifest didn't list (rare —
      // possible if the engine's manifest read missed entries). Insert.
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

export async function deleteShare(shareKey: string): Promise<ReceivedShare[]> {
  const k = String(shareKey || "").toLowerCase();
  const list = await loadShares();
  const next = list.filter((s) => s.shareKey !== k);
  if (next.length === list.length) return list;
  await writeToDisk(next);
  emit(next);
  return next;
}

/** Flip a share's pin flag. Deliberately does not touch `lastUpdatedAt` —
 *  pinning is metadata, not new content, and moving it would reorder the
 *  recency sort within the pinned group. */
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
