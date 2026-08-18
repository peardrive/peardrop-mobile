import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * One-time discovery flag for the swipe-to-delete gesture. Once the user
 * has seen the peek animation (or explicitly cleared the flag from
 * Settings → Demo & testing), this flips to true and the animation never
 * fires again unless reset.
 *
 * Shared across both swipeable lists (Share bundles, Receive downloaded
 * files): seeing the peek on either list counts as discovery for both.
 *
 * AsyncStorage rather than RNFS because it's a single boolean and survives
 * reinstalls more reliably. Same pattern as devModeStorage.
 */

const STORAGE_KEY = "peardrop.has-seen-swipe-hint";

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

export async function getSwipeHintSeen(): Promise<boolean> {
  return ensureHydrated();
}

export async function setSwipeHintSeen(seen: boolean): Promise<void> {
  cache = !!seen;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, seen ? "true" : "false");
  } catch {
    // Persistence is best-effort; the in-memory cache is updated either way
    // so the current session reflects the new state.
  }
}

/** Reset so the peek animation fires again on the next list mount. */
export async function resetSwipeHint(): Promise<void> {
  await setSwipeHintSeen(false);
}
