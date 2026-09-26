import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persistence for the folders the user has let PearDrop read. Android
 * accumulates SAF grants rather than replacing them, so holding several
 * trees at once is normal platform behaviour; each costs one folder-picker
 * dialog and no manifest permission. A single-folder key from an earlier
 * version is migrated in on first read, so nothing needs re-granting.
 */

const STORAGE_KEY = "peardrop.granted-folder-uris";
/** The earlier single-folder key. Read once, then folded into the list. */
const LEGACY_KEY = "peardrop.downloads-tree-uri";

let cache: string[] | undefined;
let hydrating: Promise<string[]> | null = null;

function sanitize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const uri = item.trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
  }
  return out;
}

async function readFromStorage(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return sanitize(JSON.parse(raw));
      } catch {
        // Corrupt value — treat as empty rather than throwing at a caller
        // that only wanted to render a list.
        return [];
      }
    }
    // No list yet: fold in the single-folder grant if one is present.
    const legacy = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacy && legacy.trim()) {
      const migrated = [legacy.trim()];
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        await AsyncStorage.removeItem(LEGACY_KEY);
      } catch {
        // Migration is best-effort; the value is still returned this run
        // and the next launch will retry.
      }
      return migrated;
    }
    return [];
  } catch {
    return [];
  }
}

function ensureHydrated(): Promise<string[]> {
  if (cache !== undefined) return Promise.resolve(cache);
  if (!hydrating) {
    hydrating = readFromStorage().then((value) => {
      cache = value;
      hydrating = null;
      return value;
    });
  }
  return hydrating;
}

async function persist(next: string[]): Promise<string[]> {
  cache = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort; the in-memory cache reflects the new state regardless.
  }
  return next;
}

/** Every folder URI the user has granted, in the order they added them. */
export async function getGrantedFolders(): Promise<string[]> {
  return ensureHydrated();
}

/** Adds a folder. Re-adding one already held is a no-op, not a duplicate. */
export async function addGrantedFolder(uri: string): Promise<string[]> {
  const current = await ensureHydrated();
  const clean = String(uri || "").trim();
  if (!clean || current.includes(clean)) return current;
  return persist([...current, clean]);
}

/**
 * Drops a folder from the list. This does not hand the SAF permission back
 * to Android, which keeps the grant until the user revokes it or uninstalls
 * the app; it stops the folder being read or shown, which is what remove
 * means from the user's side.
 */
export async function removeGrantedFolder(uri: string): Promise<string[]> {
  const current = await ensureHydrated();
  const next = current.filter((u) => u !== uri);
  if (next.length === current.length) return current;
  return persist(next);
}

export async function clearGrantedFolders(): Promise<string[]> {
  return persist([]);
}
