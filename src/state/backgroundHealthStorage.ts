import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  EMPTY_HEALTH,
  HEALTH_SCHEMA_VERSION,
  PROMPT_VERSION,
  SERVICE_FREEZE_THRESHOLD,
  coerceHealth,
  withFreeze,
  withPrompted,
  withSchemaMigration,
  withServiceWindow,
  type BackgroundHealth,
} from "../lib/backgroundHealthModel";
import type { FreezeGrade } from "../lib/freezeGrade";
import { log as debugLog } from "../lib/debugLog";
import { IS_DEBUG_BUILD } from "../lib/devGate";

/**
 * The record of the OS freezing this app while it was backgrounded.
 * Persisted because a freeze often ends with the process being killed, and
 * the message it drives must refer to something that really happened.
 * Parsing, migration and the prompt rule live in the model module so they
 * can be tested without AsyncStorage; this file is persistence only.
 */

const STORAGE_KEY = "peardrop.background-health";

/**
 * A priority tag, so this line survives log rotation. Deliberately not
 * `rn.fallback.forced`: that tag means a test instrument wrote the state,
 * and a release-user migration is not an instrument.
 */
const MIGRATION_TAG = "rn.fallback";

export {
  EMPTY_HEALTH,
  HEALTH_SCHEMA_VERSION,
  PROMPT_VERSION,
  shouldPrompt,
  type BackgroundHealth,
} from "../lib/backgroundHealthModel";

type Listener = (value: BackgroundHealth) => void;
const listeners = new Set<Listener>();
let cache: BackgroundHealth | null = null;
let hydrating: Promise<BackgroundHealth> | null = null;

async function readFromStorage(): Promise<BackgroundHealth> {
  try {
    return coerceHealth(await AsyncStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...EMPTY_HEALTH };
  }
}

/**
 * Runs on hydration and is ungated by build type: the reset below returns
 * early in a release build, so this is the only path that can clear a
 * fallback stamp earned under an older calibration. The decision itself is
 * `withSchemaMigration`, which is pure and tested; this is only the effect.
 * It logs through the file writer, not the console, because only the file
 * writer's output reaches an exported log.
 */
async function migrateOnHydrate(loaded: BackgroundHealth): Promise<BackgroundHealth> {
  const { next, cleared } = withSchemaMigration(loaded);
  if (next === loaded) return loaded;
  // Persist without notifying: hydration has not returned yet and
  // subscribers are delivered through this same promise, so a `write()`
  // here would deliver twice.
  await persist(next);
  if (cleared) {
    debugLog(
      "warn",
      MIGRATION_TAG,
      `schema ${loaded.schemaVersion} -> ${HEALTH_SCHEMA_VERSION}: cleared a ` +
        `fallback stamp written before this build. ` +
        `was streak=${loaded.serviceFreezeStreak}/${SERVICE_FREEZE_THRESHOLD} ` +
        `fallbackTriggeredAt=${loaded.fallbackTriggeredAt} ` +
        `promptedVersion=${loaded.promptedVersion} -> ` +
        `streak=${next.serviceFreezeStreak} ` +
        `fallbackTriggeredAt=${next.fallbackTriggeredAt} ` +
        `promptedVersion=${next.promptedVersion}. ` +
        `freezeCount preserved at ${next.freezeCount}. ` +
        `ONE-SHOT: the version is now persisted, so this cannot run again.`,
    );
  }
  return next;
}

function ensureHydrated(): Promise<BackgroundHealth> {
  if (cache !== null) return Promise.resolve(cache);
  if (!hydrating) {
    hydrating = readFromStorage()
      .then(migrateOnHydrate)
      .then((value) => {
        cache = value;
        hydrating = null;
        return value;
      });
  }
  return hydrating;
}

/** Persist only. Split out so the migration can write during hydration. */
async function persist(next: BackgroundHealth): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the value still takes effect for this session.
  }
}

async function write(next: BackgroundHealth): Promise<void> {
  cache = next;
  await persist(next);
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

/**
 * Record a detected freeze. Transfer state is not consulted: a freeze with
 * nothing in flight counts exactly as one that interrupted a download.
 */
export async function recordFreeze(
  elapsedMs: number,
  frozenFraction: number
): Promise<BackgroundHealth> {
  const current = await ensureHydrated();
  const next = withFreeze(current, Date.now(), elapsedMs, frozenFraction);
  await write(next);
  return next;
}

/**
 * Record how a background window ended, attributed to whether the foreground
 * service was running for it. A window with no service does not call here:
 * an idle app being frozen is Android working correctly, and counting it
 * would trip the fallback on devices where nothing is wrong.
 */
export async function recordServiceWindow(
  grade: FreezeGrade
): Promise<BackgroundHealth> {
  const current = await ensureHydrated();
  const next = withServiceWindow(current, grade, Date.now());
  // Returns the same object for a healthy window on an already-zero streak,
  // which is the common case — skip the write and the subscriber wake.
  if (next === current) return current;
  await write(next);
  return next;
}

// ---------------------------------------------------------------------
// Test instruments. Both write persisted state, which is unavoidable: the
// fallback is sticky once earned, and a session-only version could not
// exercise that. The reset below undoes them. Gated at the writer and not
// only at the row, so a release build cannot reach the fallback by any path.
// ---------------------------------------------------------------------

/** Distinct, greppable, and it says what it is in the tag itself. */
const FORCED_TAG = "rn.fallback.forced";

/**
 * Put the record into the state a full streak of service-attributed freezes
 * would have produced, so the prompt fires. Built by replaying
 * `withServiceWindow` rather than assigning fields, so the instrument cannot
 * drift from the thing it simulates.
 */
export async function forceFallbackTriggered(): Promise<BackgroundHealth> {
  if (!IS_DEBUG_BUILD) return ensureHydrated();
  const current = await ensureHydrated();
  const at = Date.now();
  let next = current;
  for (let i = 0; i < SERVICE_FREEZE_THRESHOLD; i++) {
    next = withServiceWindow(next, "frozen", at);
  }
  await write(next);
  debugLog(
    "warn",
    FORCED_TAG,
    `FORCED fallback trigger — streak=${next.serviceFreezeStreak}/${SERVICE_FREEZE_THRESHOLD} ` +
      `fallbackTriggeredAt=${next.fallbackTriggeredAt} promptedVersion=${next.promptedVersion}. ` +
      `THIS STATE WAS WRITTEN BY THE 8C TEST INSTRUMENT, NOT MEASURED — ` +
      `no freeze occurred and the service did not fail on this device.`
  );
  return next;
}

/**
 * Clear the streak, the sticky fallback stamp and the prompt version, so the
 * prompt can be seen again. Freeze history is deliberately preserved:
 * `freezeCount` and the `last*` fields record things that really happened to
 * this device, often across weeks. `shouldPrompt` does not consult them, so
 * keeping them cannot block a re-prompt.
 */
export async function resetBackgroundHealthForTesting(): Promise<BackgroundHealth> {
  if (!IS_DEBUG_BUILD) return ensureHydrated();
  const current = await ensureHydrated();
  const next: BackgroundHealth = {
    ...current,
    serviceFreezeStreak: 0,
    fallbackTriggeredAt: 0,
    promptedVersion: 0,
    hasPrompted: false,
  };
  await write(next);
  debugLog(
    "warn",
    FORCED_TAG,
    `FORCED reset — streak, fallback stamp and promptedVersion cleared. ` +
      `freezeCount preserved at ${next.freezeCount}. ` +
      `THIS STATE WAS WRITTEN BY THE 8C TEST INSTRUMENT, NOT MEASURED.`
  );
  return next;
}

/** Record that the prompt was shown. Idempotent within a prompt version. */
export async function markPrompted(): Promise<void> {
  const current = await ensureHydrated();
  // Already asked at this version: skip the write rather than waking every
  // subscriber for an identical blob. Guarded on the version alone, so a
  // caller that marks without a freeze on record stays correct.
  if (current.promptedVersion >= PROMPT_VERSION) return;
  await write(withPrompted(current));
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
  const [value, setValue] = useState<BackgroundHealth>(cache ?? EMPTY_HEALTH);
  useEffect(() => subscribeBackgroundHealth(setValue), []);
  return value;
}
