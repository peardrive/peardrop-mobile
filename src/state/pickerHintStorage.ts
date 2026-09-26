import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * One-time hint about backing out of the OS picker without selecting. Some
 * Android pickers expose no obvious back affordance, so a user can be stuck
 * without knowing the edge swipe or the system back button works. Shown as
 * a toast the first time a cancelled picker is detected, then never again.
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
