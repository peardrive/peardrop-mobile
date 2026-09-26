import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persistent dev-mode toggle, off by default. While on it exposes technical
 * detail — driveIds, raw peer counts, hex labels. An in-memory cache, a
 * listener set and a hook, so any consumer re-renders when the toggle flips.
 */

const STORAGE_KEY = "peardrop.dev-mode";

type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();
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

function emit(next: boolean) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {}
  }
}

export async function getDevMode(): Promise<boolean> {
  return ensureHydrated();
}

export async function setDevMode(value: boolean): Promise<void> {
  const next = !!value;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next ? "true" : "false");
  } catch {
    // Persistence failure is non-fatal — emit so UI flips this session anyway.
  }
  emit(next);
}

export async function toggleDevMode(): Promise<boolean> {
  const current = await ensureHydrated();
  const next = !current;
  await setDevMode(next);
  return next;
}

export function subscribeDevMode(listener: Listener): () => void {
  listeners.add(listener);
  if (cache !== null) {
    try {
      listener(cache);
    } catch {}
  } else {
    void ensureHydrated().then((v) => {
      if (listeners.has(listener)) listener(v);
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hard-locked to disabled for shipping builds: there is no toggle in the UI,
 * and a stored flag set by an earlier install is ignored. The hook and the
 * storage helpers remain so every dev-mode branch keeps compiling and
 * collapses to the user-mode side at runtime. Do not ship it unlocked.
 */
const RELEASE_LOCKED = true;

export function useDevMode(): { enabled: boolean; toggle: () => void } {
  const [enabled, setEnabled] = useState<boolean>(
    RELEASE_LOCKED ? false : (cache ?? false),
  );
  useEffect(() => {
    if (RELEASE_LOCKED) return;
    return subscribeDevMode(setEnabled);
  }, []);
  return {
    enabled: RELEASE_LOCKED ? false : enabled,
    toggle: () => {
      if (RELEASE_LOCKED) return;
      void toggleDevMode();
    },
  };
}
