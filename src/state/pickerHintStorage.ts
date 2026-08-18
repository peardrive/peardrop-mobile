import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * One-time educational hint for "how to back out of the OS picker without
 * selecting". Some Android pickers — Google Drive in particular — expose no
 * obvious back affordance, so users get stuck not knowing they can swipe from
 * the edge or use the system back button. Shown once, on the first detected
 * cancellation, then never again.
 *
 * AsyncStorage pattern matches [`swipeHintStorage`](swipeHintStorage.ts):
 * single boolean, cached in memory for the session, best-effort persist.
 */

const STORAGE_KEY = "peardrop.has-seen-picker-back-hint";

let cache: boolean | null = null;
let hydrating: Promise<boolean> | null = null;

async function readFromStorage(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw === "true";
  } catch {
    return false;
  }
}

function ensureHydrated(): Promise<boolean> {
  if (cache !== null) return Promise.resolve(cache);
  if (!hydrating) {
    hydrating = readFromStorage().then((value) => {
      cache = value;
      hydrating = null;
      return value;
    });
  }
  return hydrating;
}

export async function getPickerBackHintSeen(): Promise<boolean> {
  return ensureHydrated();
}

export async function setPickerBackHintSeen(seen: boolean): Promise<void> {
  cache = !!seen;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, seen ? "true" : "false");
  } catch {
    // Persistence is best-effort; cache reflects the new state regardless.
  }
}

/** Reset for replay / debug (Settings → Demo & testing). */
export async function resetPickerBackHint(): Promise<void> {
  await setPickerBackHintSeen(false);
}
