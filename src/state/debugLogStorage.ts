import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persistent "debugging" toggle. Off by default.
 *
 * When ON, the app routes its diagnostic stream to a file so a tester can
 * export it and we can reconstruct a failure without the device in hand.
 * When OFF there is no file handle, no buffer and no flush timer — see
 * src/lib/debugLog.ts, which subscribes here and tears everything down on
 * the falling edge.
 *
 * Deliberately the same shape as devModeStorage.ts (in-memory cache +
 * Set<Listener> + a hook) so there's one idiom for "persistent boolean the
 * whole app watches". AsyncStorage rather than an RNFS JSON file for the
 * same reason: it's a single boolean.
 *
 * Unlike devModeStorage this is NOT release-locked — shipping it is the
 * point. A tester turns it on, reproduces, exports, turns it off.
 */

const STORAGE_KEY = "peardrop.debug-logging";

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

export async function getDebugLogging(): Promise<boolean> {
  return ensureHydrated();
}

/**
 * Synchronous read for the hot path. The logger checks this on every call
 * and must not await — an un-hydrated cache reads as `false`, which is the
 * safe default (drop the line rather than buffer it before the user opted
 * in). Hydration completes within the first tick of app boot.
 */
export function isDebugLoggingEnabledSync(): boolean {
  return cache === true;
}

export async function setDebugLogging(value: boolean): Promise<void> {
  const next = !!value;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next ? "true" : "false");
  } catch {
    // Persistence failure is non-fatal — emit so the toggle still takes
    // effect for this session.
  }
  emit(next);
}

export async function toggleDebugLogging(): Promise<boolean> {
  const current = await ensureHydrated();
  const next = !current;
  await setDebugLogging(next);
  return next;
}

export function subscribeDebugLogging(listener: Listener): () => void {
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

/** React hook: `{ enabled, setEnabled, toggle }`. */
export function useDebugLogging(): {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(cache ?? false);
  useEffect(() => subscribeDebugLogging(setEnabledState), []);
  return {
    enabled,
    setEnabled: (v: boolean) => {
      void setDebugLogging(v);
    },
    toggle: () => {
      void toggleDebugLogging();
    },
  };
}
