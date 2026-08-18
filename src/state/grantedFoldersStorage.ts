import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persistence for the folders the user has let PearDrop read.
 *
 * Android accumulates SAF grants rather than replacing them —
 * `takePersistableUriPermission` adds each picked tree to the app's
 * persisted-permission set — so holding Downloads *and* Trip *and*
 * anything else at once is the platform's normal behaviour, not a hack.
 * Each one still costs exactly one folder-picker dialog and no manifest
 * permission.
 *
 * Supersedes the single-URI `downloadsGrantStorage`; its key is migrated in
 * on first read so nobody re-grants a folder they already granted.
 *
 * Same AsyncStorage pattern as [`pickerHintStorage`](pickerHintStorage.ts):
 * value cached in memory for the session, best-effort persist.
 */

const STORAGE_KEY = "peardrop.granted-folder-uris";
/** The superseded single-folder key. Read once, then folded into the list. */
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
    // No list yet: fold in the legacy single-folder grant if present.
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
 * Drops a folder from our list.
 *
 * Note this doesn't hand the SAF permission back to Android — the system
 * keeps the persisted grant until the user revokes it in Settings or the
 * app is uninstalled. What it does is stop us reading or showing it,
 * which is what "remove" means from the user's side.
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
