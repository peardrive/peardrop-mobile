import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/** The "a sender is available" alert toggle. On unless the user turned it off, which is why an absent value reads as on. */

const STORAGE_KEY = "peardrop.sender-available-alerts";

type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();
let cache: boolean | null = null;
let hydrating: Promise<boolean> | null = null;

async function readFromStorage(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    // Only an explicit "false" turns it off: a read that failed or a fresh install must not silence the payoff of the feature.
    return raw !== "false";
  } catch {
    return true;
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

export async function getSenderAvailableAlerts(): Promise<boolean> {
  return ensureHydrated();
}

/** Synchronous read for the posting path, which runs while backgrounded and cannot await a hydrate. */
export function senderAvailableAlertsSync(): boolean {
  return cache !== false;
}

export async function setSenderAvailableAlerts(value: boolean): Promise<void> {
  const next = !!value;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next ? "true" : "false");
  } catch {
    // Persistence failure is non-fatal — emit so the toggle holds for this session.
  }
  emit(next);
}

export function subscribeSenderAvailableAlerts(listener: Listener): () => void {
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

export function useSenderAvailableAlerts(): {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(cache ?? true);
  useEffect(() => subscribeSenderAvailableAlerts(setEnabledState), []);
  return {
    enabled,
    setEnabled: (v: boolean) => {
      void setSenderAvailableAlerts(v);
    },
  };
}
