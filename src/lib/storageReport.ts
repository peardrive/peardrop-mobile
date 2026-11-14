/**
 * What PearDrop is keeping on the phone, sorted into the groups Settings → Storage shows, and
 * which of it "Clean up" may remove. Pure data in, data out — no React, no storage, no
 * filesystem — so the rule for what is safe to delete can be tested without a phone.
 *
 * Clean up removes only what nothing in the app points at any more:
 * - leftover copies: files in the downloads folder that no received share names (a second copy
 *   saved as `name (1).ext`, or a download that was stopped part-way);
 * - thumbnails the list is not showing, exported logs, and old temporary files.
 * It never removes a received file a share names, a copy of a file being shared, the transfer
 * data, or the app's records. Anything touched in the last few minutes is left alone, because a
 * download writes its file under its final name long before a share names it.
 */

export type StorageFile = {
  path: string;
  size: number;
  /** Last change, ms since epoch. Unknown counts as "just now": never cleaned. */
  mtime?: number;
};

export type StorageGroup =
  | "received"
  | "sharing"
  | "transfer"
  | "leftover"
  | "temporary"
  | "records";

export const STORAGE_GROUPS: readonly StorageGroup[] = [
  "received",
  "sharing",
  "transfer",
  "leftover",
  "temporary",
  "records",
];

/** The names Settings shows. Kept beside the rule so a new group cannot ship without one. */
export const STORAGE_GROUP_LABEL: Record<StorageGroup, string> = {
  received: "Files you received",
  sharing: "Copies of files you're sharing",
  transfer: "Transfer data",
  leftover: "Leftover copies",
  temporary: "Thumbnails and temporary files",
  records: "Logs and records",
};

export type StorageInput = {
  /** The app's three folders. */
  documents: string;
  caches: string;
  temp: string;
  /** Every file under them. */
  files: readonly StorageFile[];
  /** Files a received share can open. */
  receivedPaths: Iterable<string>;
  /** Copies of the files the user is sharing. */
  sharedCopyPaths: Iterable<string>;
  /** Thumbnails on screen right now. */
  liveThumbnails: Iterable<string>;
  /** A download is running: nothing in the downloads folder is a leftover yet. */
  downloading: boolean;
  now: number;
};

export type StorageReport = {
  total: number;
  groups: Record<StorageGroup, number>;
  /** What Clean up would remove. */
  cleanable: StorageFile[];
  cleanableBytes: number;
};

/** A file changed more recently than this may still be in use. */
export const STORAGE_FRESH_MS = 15 * 60 * 1000;

/** One spelling per file: no `file://`, no `/private` in front of `/var`, no doubled or trailing slash. */
export function normalizeStoragePath(path: string): string {
  let p = String(path || "").replace(/^file:\/\//, "");
  if (p.includes("%")) {
    try {
      p = decodeURIComponent(p);
    } catch {
      // Not an encoded path after all: keep it as written.
    }
  }
  p = p.replace(/\/{2,}/g, "/").replace(/^\/private(?=\/var\/)/, "");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function isUnder(path: string, root: string): boolean {
  return !!root && path.startsWith(`${root}/`);
}

/** Folders in Caches that PearDrop fills itself. Everything else there belongs to iOS or Android. */
const OWN_CACHE_FOLDERS = ["VideoThumbnails", "DocumentPicker", "ImagePicker"];
const EXPORTED_LOG = /^peardrop-log_[^/]*\.txt$/;

export function buildStorageReport(input: StorageInput): StorageReport {
  const documents = normalizeStoragePath(input.documents);
  const caches = normalizeStoragePath(input.caches);
  const temp = normalizeStoragePath(input.temp);
  const downloads = `${documents}/peardrop/downloads`;
  const engine = `${documents}/peardrop`;

  const setOf = (paths: Iterable<string>) => {
    const out = new Set<string>();
    for (const p of paths) if (p) out.add(normalizeStoragePath(p));
    return out;
  };
  const received = setOf(input.receivedPaths);
  const shared = setOf(input.sharedCopyPaths);
  const thumbs = setOf(input.liveThumbnails);

  const groups: Record<StorageGroup, number> = {
    received: 0,
    sharing: 0,
    transfer: 0,
    leftover: 0,
    temporary: 0,
    records: 0,
  };
  const cleanable: StorageFile[] = [];
  let total = 0;
  const seen = new Set<string>();

  for (const file of input.files) {
    const path = normalizeStoragePath(file.path);
    const size = Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    total += size;

    const settled =
      typeof file.mtime === "number" && Number.isFinite(file.mtime) && input.now - file.mtime > STORAGE_FRESH_MS;
    // The path as the walk gave it, so the delete names the file exactly as it is on disk.
    const clean = () => cleanable.push({ path: file.path, size, mtime: file.mtime });

    if (received.has(path)) {
      groups.received += size;
    } else if (shared.has(path)) {
      groups.sharing += size;
    } else if (isUnder(path, downloads)) {
      // Not named by any share. While it is new, or a download is running, it is a file on its
      // way in; after that it is a copy nothing can open.
      if (settled && !input.downloading) {
        groups.leftover += size;
        clean();
      } else {
        groups.received += size;
      }
    } else if (isUnder(path, engine)) {
      groups.transfer += size;
    } else if (isUnder(path, documents)) {
      groups.records += size;
    } else if (isUnder(path, caches)) {
      groups.temporary += size;
      const rest = path.slice(caches.length + 1);
      const folder = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : "";
      const ownFolder = OWN_CACHE_FOLDERS.includes(folder);
      const exportedLog = folder === "" && EXPORTED_LOG.test(rest);
      if ((ownFolder || exportedLog) && settled && !thumbs.has(path)) clean();
    } else if (isUnder(path, temp)) {
      groups.temporary += size;
      if (settled) clean();
    } else {
      groups.records += size;
    }
  }

  const cleanableBytes = cleanable.reduce((sum, f) => sum + f.size, 0);
  return { total, groups, cleanable, cleanableBytes };
}

/**
 * The last check before a file is removed: it must still sit inside the downloads folder, the
 * caches folder or the temporary folder. A path from anywhere else is refused, whatever the
 * report said, so a mistake upstream cannot reach the records, the transfer data or the user's
 * own files.
 */
export function isCleanablePath(
  path: string,
  roots: { documents: string; caches: string; temp: string },
): boolean {
  const p = normalizeStoragePath(path);
  if (!p || p.split("/").includes("..")) return false;
  const downloads = `${normalizeStoragePath(roots.documents)}/peardrop/downloads`;
  return (
    isUnder(p, downloads) ||
    isUnder(p, normalizeStoragePath(roots.caches)) ||
    isUnder(p, normalizeStoragePath(roots.temp))
  );
}
