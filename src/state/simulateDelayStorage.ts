import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { IS_DEBUG_BUILD } from "../lib/devGate";

/**
 * Which delay the simulated-completion test uses.
 *
 * A hard-coded 15 s passes the battery-restriction scenario for the
 * wrong reason: every background window it produces is 14-57 s, while
 * the OS freeze was measured arriving around 80 s. A
 * completion scheduled at 15 s always fires before the phone gets round to
 * freezing the process, so that scenario could not fail. Closing the hole
 * needs two to three minutes, and rebuilding to change a constant is the
 * kind of friction that gets tests skipped — so it becomes a setting.
 *
 * Same shape as debugLogStorage.ts / suspendProbeStorage.ts on purpose:
 * in-memory cache + Set<Listener> + a hook. One idiom for "persistent
 * value the whole app watches", not three.
 *
 * Persisted because the test protocol force-stops the app between runs;
 * a session-only value would silently revert to 15 s and quietly
 * reintroduce the bug this module exists to fix.
 */

const STORAGE_KEY = "peardrop.simulate-delay-ms";

/** The offered delays. Order is display order. */
export const SIMULATE_DELAY_OPTIONS = [15_000, 60_000, 180_000] as const;

export type SimulateDelayMs = (typeof SIMULATE_DELAY_OPTIONS)[number];

export const DEFAULT_SIMULATE_DELAY_MS: SimulateDelayMs = 15_000;

type Listener = (ms: SimulateDelayMs) => void;
const listeners = new Set<Listener>();
let cache: SimulateDelayMs | null = null;
let hydrating: Promise<SimulateDelayMs> | null = null;

/** Anything not in the option set reads as the default — a stale or
 *  hand-edited value must not put the picker into a state it can't show. */
function coerce(raw: string | null): SimulateDelayMs {
  const n = Number(raw);
  return (SIMULATE_DELAY_OPTIONS as readonly number[]).includes(n)
    ? (n as SimulateDelayMs)
    : DEFAULT_SIMULATE_DELAY_MS;
}

async function readFromStorage(): Promise<SimulateDelayMs> {
  try {
    return coerce(await AsyncStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SIMULATE_DELAY_MS;
  }
}

function ensureHydrated(): Promise<SimulateDelayMs> {
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

function emit(next: SimulateDelayMs) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {}
  }
}

export async function getSimulateDelay(): Promise<SimulateDelayMs> {
  return ensureHydrated();
}

/** Synchronous read for callers that must not await. An un-hydrated cache
 *  reads as the default, which is the safe answer. */
export function getSimulateDelaySync(): SimulateDelayMs {
  return cache ?? DEFAULT_SIMULATE_DELAY_MS;
}

export async function setSimulateDelay(value: number): Promise<void> {
  const next = coerce(String(value));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Persistence failure is non-fatal — emit anyway so the choice still
    // takes effect for this session.
  }
  emit(next);
}

export function subscribeSimulateDelay(listener: Listener): () => void {
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
 * React hook: `{ delayMs, setDelayMs }`.
 *
 * The debug-build check must live INSIDE the effect, not around the hook call:
 * rules of hooks force this hook to run in every build, so guarding outside
 * would still register a listener and hydrate AsyncStorage in release.
 */
export function useSimulateDelay(): {
  delayMs: SimulateDelayMs;
  setDelayMs: (v: SimulateDelayMs) => void;
} {
  const [delayMs, setState] = useState<SimulateDelayMs>(
    cache ?? DEFAULT_SIMULATE_DELAY_MS
  );
  useEffect(() => {
    if (!IS_DEBUG_BUILD) return;
    return subscribeSimulateDelay(setState);
  }, []);
  return {
    delayMs,
    setDelayMs: (v: SimulateDelayMs) => {
      void setSimulateDelay(v);
    },
  };
}
