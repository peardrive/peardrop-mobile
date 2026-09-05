import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * What we know about the OS freezing this app while it was backgrounded.
 *
 * Persisted because the evidence is worth keeping across restarts: the whole
 * point is to show a message referring to something that actually happened,
 * and a freeze often ends with the process being killed.
 *
 * Same shape as debugLogStorage.ts / simulateDelayStorage.ts on purpose:
 * in-memory cache + Set<Listener> + a hook.
 */

const STORAGE_KEY = "peardrop.background-health";

export type BackgroundHealth = {
  /** How many freezes have been observed, ever. */
  freezeCount: number;
  /** When the most recent one was detected. 0 = never. */
  lastFreezeAt: number;
  /** How long that backgrounding lasted, ms. */
  lastElapsedMs: number;
  /** 0..1, how much of it the engine was frozen for. */
  lastFrozenFraction: number;
  /**
   * Whether the prompt has ever been shown. Once true, never again.
   *
   * This was a `promptCount` capped at three. The cap existed because
   * the app cannot read whether the user actually changed the setting, so it
   * cannot tell "ignored me" from "fixed it and got frozen by something
   * else" — and asking again gave the second case a way through.
   *
   * That reasoning was sound but is now moot: the Settings row is permanent,
   * so a user who wants the setting can always find it. Asking twice buys
   * nothing and costs goodwill, so we ask once and then stop. A flag says
   * that plainly; a counter that can only ever reach one does not.
   */
  hasPrompted: boolean;
};

/**
 * Shape of previously-persisted state, for migration only.
 *
 * Older builds wrote `promptCount` (0..3) and `lastPromptedAtCount`. Both
 * are read once in `coerce` to decide `hasPrompted` and are never written
 * again, so stored blobs shed them on the next write.
 */
type PersistedHealth = Partial<BackgroundHealth> & {
  promptCount?: number;
  lastPromptedAtCount?: number;
};

export const EMPTY_HEALTH: BackgroundHealth = {
  freezeCount: 0,
  lastFreezeAt: 0,
  lastElapsedMs: 0,
  lastFrozenFraction: 0,
  hasPrompted: false,
};

type Listener = (value: BackgroundHealth) => void;
const listeners = new Set<Listener>();
let cache: BackgroundHealth | null = null;
let hydrating: Promise<BackgroundHealth> | null = null;

function coerce(raw: string | null): BackgroundHealth {
  if (!raw) return { ...EMPTY_HEALTH };
  try {
    const parsed = JSON.parse(raw) as PersistedHealth;
    return {
      freezeCount: Number(parsed.freezeCount) || 0,
      lastFreezeAt: Number(parsed.lastFreezeAt) || 0,
      lastElapsedMs: Number(parsed.lastElapsedMs) || 0,
      lastFrozenFraction: Number(parsed.lastFrozenFraction) || 0,
      // Migration. Older state has no `hasPrompted`, only a `promptCount`.
      // Anyone who was ever asked — including during our own testing — has
      // promptCount >= 1 and must not be asked again, so any non-zero count
      // reads as "already prompted". A fresh install has neither field and
      // correctly lands on false.
      hasPrompted:
        parsed.hasPrompted === true || (Number(parsed.promptCount) || 0) > 0,
    };
  } catch {
    return { ...EMPTY_HEALTH };
  }
}

async function readFromStorage(): Promise<BackgroundHealth> {
  try {
    return coerce(await AsyncStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...EMPTY_HEALTH };
  }
}

function ensureHydrated(): Promise<BackgroundHealth> {
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

async function write(next: BackgroundHealth): Promise<void> {
  cache = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the value still takes effect for this session.
  }
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {}
  }
}

export async function getBackgroundHealth(): Promise<BackgroundHealth> {
  return ensureHydrated();
}

export function getBackgroundHealthSync(): BackgroundHealth {
  return cache ?? EMPTY_HEALTH;
}

/** Record a detected freeze. */
export async function recordFreeze(
  elapsedMs: number,
  frozenFraction: number
): Promise<BackgroundHealth> {
  const current = await ensureHydrated();
  const next: BackgroundHealth = {
    ...current,
    freezeCount: current.freezeCount + 1,
    lastFreezeAt: Date.now(),
    lastElapsedMs: elapsedMs,
    lastFrozenFraction: frozenFraction,
  };
  await write(next);
  return next;
}

/** Note that the prompt was shown. Idempotent — it is never shown again. */
export async function markPrompted(): Promise<void> {
  const current = await ensureHydrated();
  // Already asked: skip the write rather than re-persisting an identical
  // blob and waking every subscriber for nothing.
  if (current.hasPrompted) return;
  await write({ ...current, hasPrompted: true });
}

/**
 * Whether the prompt may appear. True at most once in the app's lifetime:
 * a freeze has been recorded, and we have not asked before.
 *
 * Freezes are still detected, counted and persisted regardless — this gates
 * only the asking. The Settings row is permanent, so the option stays
 * reachable after the single ask.
 */
export function shouldPrompt(health: BackgroundHealth): boolean {
  if (health.freezeCount === 0) return false;
  return !health.hasPrompted;
}

export function subscribeBackgroundHealth(listener: Listener): () => void {
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

export function useBackgroundHealth(): BackgroundHealth {
  const [value, setValue] = useState<BackgroundHealth>(
    cache ?? EMPTY_HEALTH
  );
  useEffect(() => subscribeBackgroundHealth(setValue), []);
  return value;
}
