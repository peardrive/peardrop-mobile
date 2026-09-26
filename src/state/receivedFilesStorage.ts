import RNFS from "react-native-fs";
import { readJsonFile, writeJsonAtomic } from "../lib/atomicFile";
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

// A subscribe pattern, so consumers get live updates when files are
// appended or deleted. Refreshing on focus alone misses the demo path,
// where no backend events fire, and races the post-download write on real
// shares. Listeners receive the on-disk-filtered list.
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
  // Hand over the current state asynchronously, so a subscriber need not
  // also call loadDownloaded for its initial render.
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

/**
 * Read the index, dropping any entry whose file is no longer on disk. That
 * `RNFS.exists` filter is the de-facto tombstone for deleted files: the
 * engine's manifest goes on listing them, so the reconcile pass re-proposes
 * them. Remove the filter and every reconcile resurrects everything the
 * user has ever deleted.
 */
export async function loadDownloaded(): Promise<DownloadedItem[]> {
  // The index read distinguishes never-written from unreadable from not
  // JSON, and preserves the file in the latter two cases.
  const result = await readJsonFile(STORAGE_FILE);
  if (result.status !== "ok") return [];
  const parsed = result.value;
  if (!Array.isArray(parsed)) return [];
  try {
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

/**
 * Temp file plus rename, never a bare write onto the final path. The
 * missing try/catch is deliberate: this is the one store whose write
 * failure reaches its caller, and swallowing it for symmetry with the
 * others would erase that signal.
 */
export async function saveDownloaded(items: DownloadedItem[]): Promise<void> {
  await writeJsonAtomic(STORAGE_FILE, items);
  void broadcastChange();
}

/**
 * Remove a downloaded file from the index and unlink it from disk. Both, as
 * either one alone leaves the UI in a partial state. Best-effort on the
 * unlink: a missing file is fine, and any other error is swallowed so the
 * index update still happens.
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
      // A removal failure is non-fatal: the entry is gone from the index,
      // and any orphaned file is pruned the next time downloads are cleared.
    }
  }
  return next;
}

/**
 * The batch twin of `deleteDownloaded`, rather than a loop over it: that
 * function does a full load-modify-save per call, so a twelve-file share
 * would be twelve rewrites of the index with twelve chances of being
 * interrupted. Nothing here decides which paths are safe to remove — the
 * caller passes a plan whose gate admits only the app's own download
 * subtree, and that gate lives in a pure module so it can be tested.
 * Unlinks are individually caught: one file the OS will not release must
 * not abort the rest of the delete.
 */
export async function applyReceivedDeletePlan(plan: {
  unlink: string[];
  legacyIds: string[];
}): Promise<{ unlinked: string[]; failed: string[] }> {
  const unlinked: string[] = [];
  const failed: string[] = [];
  for (const p of plan.unlink) {
    try {
      if (await RNFS.exists(p)) await RNFS.unlink(p);
      unlinked.push(p);
    } catch {
      failed.push(p);
    }
  }

  // `loadDownloaded` already drops entries whose file is gone, and
  // persisting that filtered list is what makes the removal survive a
  // restart. The explicit id filter still matters for failed unlinks.
  const drop = new Set(plan.legacyIds);
  const current = await loadDownloaded();
  const next = current.filter((item) => !drop.has(item.id));
  await saveDownloaded(next);
  return { unlinked, failed };
}

export async function appendDownloadResults(
  files: { name: string; path: string; size: number }[],
  shareLink?: string,
  /**
   * Override the recorded timestamp. Defaults to now, which is right for a
   * live download; the reconcile pass supplies the engine's own stamp,
   * because recovered files really did arrive earlier and dating them now
   * would float them to the top of the recency sort.
   */
  downloadedAt?: number
): Promise<DownloadedItem[]> {
  let next = await loadDownloaded();
  const now = typeof downloadedAt === "number" ? downloadedAt : Date.now();
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
