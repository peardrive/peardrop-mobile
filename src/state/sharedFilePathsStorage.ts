import RNFS from "react-native-fs";

/**
 * Per-share record of the local cache paths the user's picked
 * files live at. The engine's manifest only stores in-drive storage paths
 * (relative to corestore), so without this side-store we can't preview or
 * "open in another app" for files the user originally shared.
 *
 * Cache eviction caveat: these paths live under DocumentPicker's
 * `copyToCacheDirectory` output or ImagePicker's cache dir — the OS may
 * purge them over time. The UI checks file existence before relying on a
 * path (see `MainScreen.tsx`); a missing local copy is a soft failure
 * (preview/open hidden) and does not affect the Hyperdrive-served share
 * itself, which lives in corestore.
 */

export type SharedFilePath = {
  name: string;
  localPath: string;
  size?: number;
};

export type SharedFilePathsEntry = {
  driveId: string;
  files: SharedFilePath[];
  /** ms since epoch — when this record was written. */
  savedAt: number;
};

const STORAGE_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-shared-paths.json`;

type Listener = (entries: SharedFilePathsEntry[]) => void;
const listeners = new Set<Listener>();
let cache: SharedFilePathsEntry[] | null = null;

function sanitize(raw: unknown): SharedFilePathsEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedFilePathsEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const driveId = typeof r.driveId === "string" ? r.driveId : null;
    if (!driveId) continue;
    const files: SharedFilePath[] = Array.isArray(r.files)
      ? r.files
          .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
          .map((f) => ({
            name: typeof f.name === "string" ? f.name : "file",
            localPath: typeof f.localPath === "string" ? f.localPath : "",
            size:
              typeof f.size === "number" && Number.isFinite(f.size)
                ? Math.max(0, f.size)
                : undefined,
          }))
          .filter((f) => !!f.localPath)
      : [];
    const savedAt =
      typeof r.savedAt === "number" && Number.isFinite(r.savedAt) ? r.savedAt : Date.now();
    out.push({ driveId, files, savedAt });
  }
  return out;
}

async function readFromDisk(): Promise<SharedFilePathsEntry[]> {
  try {
    const exists = await RNFS.exists(STORAGE_FILE);
    if (!exists) return [];
    const raw = await RNFS.readFile(STORAGE_FILE, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeToDisk(entries: SharedFilePathsEntry[]): Promise<void> {
  try {
    await RNFS.writeFile(STORAGE_FILE, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Best-effort — in-memory cache stays accurate this session.
  }
}

function emit(next: SharedFilePathsEntry[]) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {
      // listener throws are quarantined so one bad subscriber doesn't kill the rest
    }
  }
}

export async function loadSharedFilePaths(): Promise<SharedFilePathsEntry[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function saveSharedFilePathsEntry(
  entry: SharedFilePathsEntry,
): Promise<SharedFilePathsEntry[]> {
  const current = await loadSharedFilePaths();
  const next = [entry, ...current.filter((e) => e.driveId !== entry.driveId)];
  await writeToDisk(next);
  emit(next);
  return next;
}

export async function removeSharedFilePaths(driveId: string): Promise<SharedFilePathsEntry[]> {
  const current = await loadSharedFilePaths();
  const next = current.filter((e) => e.driveId !== driveId);
  if (next.length === current.length) return current;
  await writeToDisk(next);
  emit(next);
  return next;
}

export function subscribeSharedFilePaths(listener: Listener): () => void {
  listeners.add(listener);
  if (cache) {
    try {
      listener(cache);
    } catch {
      // see emit()
    }
  } else {
    void loadSharedFilePaths().then((b) => {
      if (listeners.has(listener)) {
        try {
          listener(b);
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
