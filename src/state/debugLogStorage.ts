import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The persistent debugging toggle, off by default. While on, the diagnostic
 * stream goes to a file that can be exported, so a failure can be
 * reconstructed without the device in hand; while off there is no file
 * handle, no buffer and no flush timer. Not release-locked: shipping it is
 * the point.
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

/**
 * Resolve the persisted flag with a bounded wait, for the one caller that
 * must not read a stale `false`: the worklet drops every log line until the
 * flag arrives, and the synchronous read is `false` on a cold cache by
 * design. Bounded because listening must not be hostage to storage — on
 * timeout this resolves `false` and the subscriber corrects it later. A warm
 * cache short-circuits before any timer is armed.
 */
export async function awaitDebugLogging(timeoutMs = 1500): Promise<boolean> {
  if (cache !== null) return cache;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<boolean>([
      ensureHydrated(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
