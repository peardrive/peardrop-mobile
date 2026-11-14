import RNFS from "react-native-fs";
import {
  buildStorageReport,
  isCleanablePath,
  type StorageFile,
  type StorageReport,
} from "../lib/storageReport";
import { liveVideoThumbnails } from "../lib/videoThumbnail";
import { normalizeShareLink } from "../lib/links";
import { log as debugLog } from "../lib/debugLog";
import { loadShares } from "./receivedSharesStorage";
import { loadDownloaded } from "./receivedFilesStorage";
import { loadSharedFilePaths } from "./sharedFilePathsStorage";

/**
 * The part of Settings → Storage that touches the phone: walk the app's folders, ask the stores
 * what is still in use, and remove what Clean up offered. The rule for what may go lives in
 * `src/lib/storageReport.ts`; nothing here decides it.
 */

function roots() {
  return {
    documents: RNFS.DocumentDirectoryPath,
    caches: RNFS.CachesDirectoryPath,
    temp: RNFS.TemporaryDirectoryPath,
  };
}

/** Hard stop for a runaway walk. The transfer data is a few hundred files per share. */
const MAX_FILES = 50_000;

async function walk(root: string, into: StorageFile[]): Promise<void> {
  const queue: string[] = [root];
  while (queue.length > 0 && into.length < MAX_FILES) {
    const dir = queue.pop() as string;
    let items: Awaited<ReturnType<typeof RNFS.readDir>>;
    try {
      items = await RNFS.readDir(dir);
    } catch {
      // A folder that is missing or unreadable holds nothing we can count.
      continue;
    }
    for (const item of items) {
      if (item.isDirectory()) {
        queue.push(item.path);
      } else if (item.isFile()) {
        const mtime = item.mtime instanceof Date ? item.mtime.getTime() : undefined;
        into.push({
          path: item.path,
          size: Number(item.size) || 0,
          mtime: typeof mtime === "number" && Number.isFinite(mtime) ? mtime : undefined,
        });
      }
    }
  }
}

/** Statuses during which the engine may still be writing into the downloads folder. */
const WRITING = new Set(["downloading", "queued", "paused"]);

export async function measureStorage(): Promise<StorageReport> {
  const { documents, caches, temp } = roots();
  const files: StorageFile[] = [];
  const walked = new Set<string>();
  for (const root of [documents, caches, temp, RNFS.LibraryDirectoryPath]) {
    const clean = String(root || "").replace(/\/+$/, "");
    if (!clean || walked.has(clean)) continue;
    walked.add(clean);
    await walk(clean, files);
  }

  const [shares, index, shared] = await Promise.all([
    loadShares().catch(() => []),
    loadDownloaded().catch(() => []),
    loadSharedFilePaths().catch(() => []),
  ]);

  const receivedPaths: string[] = [];
  const knownLinks = new Set<string>();
  for (const share of shares) {
    const link = normalizeShareLink(share.shareLink);
    if (link) knownLinks.add(link);
    for (const f of share.files) if (f.localPath) receivedPaths.push(f.localPath);
  }
  // A saved file from before shares had records of their own has nothing but the old index to
  // name it. It stays a received file; only a copy whose share is on record can be a leftover.
  for (const item of index) {
    const link = item.shareLink ? normalizeShareLink(item.shareLink) : null;
    if (!link || !knownLinks.has(link)) receivedPaths.push(item.path);
  }

  return buildStorageReport({
    documents,
    caches,
    temp,
    files,
    receivedPaths,
    sharedCopyPaths: shared.flatMap((entry) => entry.files.map((f) => f.localPath)),
    liveThumbnails: liveVideoThumbnails(),
    downloading: shares.some((s) => WRITING.has(s.status)),
    now: Date.now(),
  });
}

export type CleanOutcome = { freedBytes: number; removed: number; failed: number };

/**
 * Remove what a fresh measurement offers. Measured again here rather than trusting the numbers
 * on screen, so a download that started while Settings was open is not mistaken for a leftover.
 */
export async function cleanStorage(): Promise<CleanOutcome> {
  const report = await measureStorage();
  const where = roots();
  let freedBytes = 0;
  let removed = 0;
  let failed = 0;
  for (const file of report.cleanable) {
    if (!isCleanablePath(file.path, where)) {
      failed += 1;
      continue;
    }
    try {
      await RNFS.unlink(file.path);
      freedBytes += file.size;
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  debugLog("info", "storage", `clean up removed=${removed} failed=${failed} freed=${freedBytes}`);
  return { freedBytes, removed, failed };
}
