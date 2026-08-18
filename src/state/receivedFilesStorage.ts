import RNFS from "react-native-fs";
import { baseName, fileExt } from "../lib/files";

export type DownloadedItem = {
  id: string;
  name: string;
  size?: number;
  type: string;
  path: string;
  shareLink?: string;
  downloadedAt: number;
};

const STORAGE_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-received-files.json`;

export function fileType(name: string): string {
  return fileExt(name) || "file";
}

// Subscription so consumers get live updates when files are appended or
// deleted. Refreshing only on focus / transfer-completed misses the demo path
// entirely (no backend events fire) and races the post-download write on real
// shares. Listeners receive the on-disk-filtered list, the same shape
// `loadDownloaded()` returns.
type Listener = (items: DownloadedItem[]) => void;
const listeners = new Set<Listener>();

async function broadcastChange(): Promise<void> {
  if (listeners.size === 0) return;
  const items = await loadDownloaded();
  for (const l of Array.from(listeners)) {
    try {
      l(items);
    } catch {}
  }
}

export function subscribeDownloaded(listener: Listener): () => void {
  listeners.add(listener);
  // Hand over the current state asynchronously so the subscriber doesn't
  // have to also call loadDownloaded itself for the initial render.
  void loadDownloaded().then((items) => {
    if (listeners.has(listener)) {
      try {
        listener(items);
      } catch {}
    }
  });
  return () => {
    listeners.delete(listener);
  };
}

export async function loadDownloaded(): Promise<DownloadedItem[]> {
  try {
    const exists = await RNFS.exists(STORAGE_FILE);
    if (!exists) return [];
    const raw = await RNFS.readFile(STORAGE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const alive: DownloadedItem[] = [];
    for (const item of parsed) {
      if (!item?.path || !item?.name) continue;
      if (await RNFS.exists(String(item.path))) alive.push(item as DownloadedItem);
    }
    return alive;
  } catch {
    return [];
  }
}

export async function saveDownloaded(items: DownloadedItem[]): Promise<void> {
  await RNFS.writeFile(STORAGE_FILE, JSON.stringify(items, null, 2), "utf8");
  void broadcastChange();
}

/**
 * Remove a downloaded file from the index AND unlink it from disk. Both —
 * leaving an entry in the index without the file (or vice versa) leaves the
 * UI in a confusing partial state. Best-effort on the unlink: a missing file
 * is fine, any other error is swallowed so the index update still happens.
 */
export async function deleteDownloaded(id: string): Promise<DownloadedItem[]> {
  const current = await loadDownloaded();
  const target = current.find((item) => item.id === id);
  const next = current.filter((item) => item.id !== id);
  await saveDownloaded(next);
  if (target?.path) {
    try {
      if (await RNFS.exists(target.path)) await RNFS.unlink(target.path);
    } catch {
      // File-system removal failure is non-fatal — the entry is gone from
      // the index, so loadDownloaded won't show it again. The orphaned file
      // (if any) will get pruned the next time the user clears downloads.
    }
  }
  return next;
}

export async function appendDownloadResults(
  files: { name: string; path: string; size: number }[],
  shareLink?: string
): Promise<DownloadedItem[]> {
  let next = await loadDownloaded();
  const now = Date.now();
  for (const saved of files) {
    const name = baseName(saved.name);
    const item: DownloadedItem = {
      id: `${name}:${saved.path}`,
      name,
      size: saved.size,
      type: fileType(name),
      path: saved.path,
      shareLink,
      downloadedAt: now,
    };
    next = next.filter((p) => !(p.name === item.name && p.path === item.path));
    next = [item, ...next];
  }
  await saveDownloaded(next);
  return next;
}
