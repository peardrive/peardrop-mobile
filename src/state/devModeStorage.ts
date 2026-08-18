import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persistent dev-mode toggle. Off by default — exposes technical clutter
 * (driveIds, raw peer counts, hex labels, internal state) when on.
 *
 * Mirrors the listener pattern from `statsStorage.ts`: an in-memory cache,
 * a Set<Listener>, and a hook (`useDevMode`) that subscribes for live
 * updates so any consumer re-renders the moment the toggle flips.
 *
 * AsyncStorage instead of RNFS because it's a single boolean and survives
 * across reinstalls more reliably than a Documents/ JSON file.
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
 * React hook for dev-mode state. Returns `{ enabled, toggle }`.
 *
 * Hard-locked to `enabled: false` for release, overriding any stored flag.
 * The hook and storage helpers remain so the `devMode ? a : b` ternaries
 * across the app keep compiling and collapse to the user-mode branch.
 *
 * To re-enable for development, flip `RELEASE_LOCKED` to `false` below.
 * Don't ship a build with it false.
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
