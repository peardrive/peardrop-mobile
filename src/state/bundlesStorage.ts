import RNFS from "react-native-fs";

/**
 * Persistent record of every share bundle the user has created. Mirrors
 * the listener pattern from `receivedFilesStorage.ts`: a JSON file in
 * Documents, an in-memory cache, and a Set<Listener> hook surface so
 * HomeScreen can subscribe for live updates.
 *
 * After an app restart the engine no longer announces these drives on
 * the swarm, so persisted bundles are "dormant" — useful as history /
 * link records, but the share link won't resolve until the user re-shares.
 * HomeScreen renders dormant entries with reduced opacity and a clarifying
 * caption.
 */

export type PersistedBundleFile = {
  name: string;
  size: number;
};

export type PersistedBundle = {
  driveId: string;
  shareLink: string;
  files: PersistedBundleFile[];
  createdAt: number;
  lastActivityAt: number;
};

const STORAGE_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-bundles.json`;

type Listener = (bundles: PersistedBundle[]) => void;
const listeners = new Set<Listener>();
let cache: PersistedBundle[] | null = null;

function sanitize(raw: unknown): PersistedBundle[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedBundle[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const driveId = typeof r.driveId === "string" ? r.driveId : null;
    const shareLink = typeof r.shareLink === "string" ? r.shareLink : null;
    if (!driveId || !shareLink) continue;
    const files: PersistedBundleFile[] = Array.isArray(r.files)
      ? r.files
          .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
          .map((f) => ({
            name: typeof f.name === "string" ? f.name : "file",
            size: typeof f.size === "number" && Number.isFinite(f.size) ? Math.max(0, f.size) : 0,
          }))
      : [];
    const createdAt =
      typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
    const lastActivityAt =
      typeof r.lastActivityAt === "number" && Number.isFinite(r.lastActivityAt)
        ? r.lastActivityAt
        : createdAt;
    out.push({ driveId, shareLink, files, createdAt, lastActivityAt });
  }
  return out;
}

async function readFromDisk(): Promise<PersistedBundle[]> {
  try {
    const exists = await RNFS.exists(STORAGE_FILE);
    if (!exists) return [];
    const raw = await RNFS.readFile(STORAGE_FILE, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeToDisk(bundles: PersistedBundle[]): Promise<void> {
  try {
    await RNFS.writeFile(STORAGE_FILE, JSON.stringify(bundles, null, 2), "utf8");
  } catch {
    // Best-effort persistence — the in-memory state remains accurate this
    // session even if the disk write fails.
  }
}

function emit(next: PersistedBundle[]) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {}
  }
}

export async function loadBundles(): Promise<PersistedBundle[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function saveBundles(bundles: PersistedBundle[]): Promise<void> {
  await writeToDisk(bundles);
  emit(bundles);
}

export async function addBundle(bundle: PersistedBundle): Promise<PersistedBundle[]> {
  const current = await loadBundles();
  // Dedup on driveId. If a bundle for this driveId already exists, replace
  // (same drive re-saved with newer timestamps).
  const next = [bundle, ...current.filter((b) => b.driveId !== bundle.driveId)];
  await saveBundles(next);
  return next;
}

export async function removeBundle(driveId: string): Promise<PersistedBundle[]> {
  const current = await loadBundles();
  const next = current.filter((b) => b.driveId !== driveId);
  await saveBundles(next);
  return next;
}

export async function touchBundle(driveId: string): Promise<void> {
  const current = await loadBundles();
  const idx = current.findIndex((b) => b.driveId === driveId);
  if (idx < 0) return;
  const updated = [...current];
  const target = updated[idx];
  if (!target) return;
  updated[idx] = { ...target, lastActivityAt: Date.now() };
  await saveBundles(updated);
}

export function subscribeBundles(listener: Listener): () => void {
  listeners.add(listener);
  if (cache) {
    try {
      listener(cache);
    } catch {}
  } else {
    void loadBundles().then((b) => {
      if (listeners.has(listener)) listener(b);
    });
  }
  return () => {
    listeners.delete(listener);
  };
}
