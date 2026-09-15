import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  EMPTY_HEALTH,
  PROMPT_VERSION,
  SERVICE_FREEZE_THRESHOLD,
  coerceHealth,
  withFreeze,
  withPrompted,
  withServiceWindow,
  type BackgroundHealth,
} from "../lib/backgroundHealthModel";
import type { FreezeGrade } from "../lib/freezeGrade";
import { log as debugLog } from "../lib/debugLog";
import { IS_DEBUG_BUILD } from "../lib/devGate";

/**
 * What we know about the OS freezing this app while it was backgrounded.
 *
 * Persisted because the evidence is worth keeping across restarts: the whole
 * point is to show a message referring to something that actually happened,
 * and a freeze often ends with the process being killed.
 *
 * Same shape as debugLogStorage.ts / simulateDelayStorage.ts on purpose:
 * in-memory cache + Set<Listener> + a hook. Parsing, migration and the
 * prompt-eligibility rule live in ../lib/backgroundHealthModel.ts so they can
 * be unit-tested without AsyncStorage; this file is persistence only.
 */

const STORAGE_KEY = "peardrop.background-health";

export {
  EMPTY_HEALTH,
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

/**
 * Record a detected freeze.
 *
 * Called from `checkForFreeze` on every foreground transition that follows a
 * measured background window, with no reference to transfer state — a freeze
 * with nothing in flight counts exactly as one that interrupted a download.
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
 * record how a background window ended, ATTRIBUTED to whether the
 * foreground service was running for it.
 *
 * Only these two outcomes touch the streak. A window with no service running
 * calls neither — an idle app being frozen is Android working correctly, and
 * counting it would trip the fallback on devices where nothing is wrong.
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
// test instruments.
//
// Both WRITE PERSISTED STATE, unlike 8B's forced-active flag, which is a
// module-level `let` that dies with the process. That is unavoidable — the
// fallback's whole behaviour is "sticky once earned", and a session-only
// version could not test stickiness. The reset below is what undoes them.
//
// Gated on IS_DEBUG_BUILD HERE, at the writer, not only at the row. A
// release build cannot reach the fallback through these by any path: the
// rows do not render, and if something called these anyway they no-op.
// ---------------------------------------------------------------------

/** Distinct, greppable, and it says what it is in the tag itself. */
const FORCED_TAG = "rn.fallback.forced";

/**
 * Put the record into the state three service-attributed freezes would have
 * produced, so the prompt fires and the Settings row appears.
 *
 * Built by replaying `withServiceWindow` at the threshold rather than by
 * assigning the fields directly. 8C must not touch the streak logic, and
 * this way it does not: whatever that function does with weights and the
 * sticky stamp is what the forced state gets, so the instrument cannot
 * drift from the thing it is meant to simulate.
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
 * prompt can be seen again.
 *
 * This also closes the gap carried since 7B: prompt copy could previously be
 * seen exactly once per install, which made reviewing wording a
 * reinstall-per-look exercise.
 *
 * Freeze HISTORY is deliberately preserved. `freezeCount` and the three
 * `last*` fields are a record of things that really happened to this device,
 * often across weeks; wiping them to re-read a string would destroy real
 * measurement data. `shouldPrompt` no longer consults `freezeCount` anyway,
 * so keeping it cannot block a re-prompt.
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

/** Note that the prompt was shown. Idempotent within a prompt version. */
export async function markPrompted(): Promise<void> {
  const current = await ensureHydrated();
  // Already asked at this version: skip the write rather than re-persisting
  // an identical blob and waking every subscriber for nothing. Guarded on
  // the version alone, not on `shouldPrompt`, so this stays correct if a
  // caller ever marks without a freeze on record.
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
