import AsyncStorage from "@react-native-async-storage/async-storage";

/** The background-waiting budget as it survives a restart, plus the short cap a device run needs. */

import {
  advanceSpan,
  budgetExhausted,
  clampCapOverride,
  describeBudget,
  effectiveCapMs,
  EMPTY_WAITING_BUDGET,
  normaliseBudget,
  openSpan,
  remainingMs,
  type WaitingBudgetState,
} from "../lib/waitingBudget";
import { isDebugLoggingEnabledSync } from "./debugLogStorage";

const STORAGE_KEY = "peardrop.waiting-budget";
const OVERRIDE_KEY = "peardrop.waiting-budget-cap-ms";

/** The cap a device run can finish inside. Off unless stored, and it counts only while Debugging is on. */
export const WAITING_BUDGET_TEST_CAP_MS = 3 * 60 * 1000;

/**
 * The budget is read on the background transition, which may not await, so the cache is the
 * authority for that read and storage only has to survive a restart.
 */
let cache: WaitingBudgetState = EMPTY_WAITING_BUDGET;
let hydrated = false;
let capOverrideMs: number | null = null;
let writing: Promise<void> = Promise.resolve();

export async function hydrateWaitingBudget(): Promise<WaitingBudgetState> {
  if (hydrated) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? normaliseBudget(JSON.parse(raw)) : EMPTY_WAITING_BUDGET;
  } catch {
    cache = EMPTY_WAITING_BUDGET;
  }
  try {
    const raw = await AsyncStorage.getItem(OVERRIDE_KEY);
    // Clamped on the way in as well as on the way out, so a hand-edited store cannot raise the cap.
    capOverrideMs = raw === null ? null : clampCapOverride(Number(raw));
  } catch {
    capOverrideMs = null;
  }
  hydrated = true;
  return cache;
}

/** Synchronous, for the background decision. An un-hydrated cache reads as an unspent budget. */
export function waitingBudgetSync(): WaitingBudgetState {
  return cache;
}

/** The cap in force. Gated on the shipped Debugging toggle, so turning it off restores two hours with no second write. */
export function waitingCapMs(): number {
  return effectiveCapMs(capOverrideMs, isDebugLoggingEnabledSync());
}

/** Whether a lowered cap is both stored and in force. */
export function isWaitingCapOverridden(): boolean {
  return capOverrideMs !== null && isDebugLoggingEnabledSync();
}

/** Serialised, because two overlapping writes against one key lose an update. */
function persist(next: WaitingBudgetState): void {
  cache = next;
  writing = writing
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)))
    .then(
      () => {},
      () => {},
    );
}

export function waitingBudgetWritten(): Promise<void> {
  return writing;
}

/** Start billing a background window. */
export function openWaitingSpan(now: number): WaitingBudgetState {
  persist(openSpan(cache, now));
  return cache;
}

/** Bill up to now on a wake. `maxGapMs` is the wake cadence plus slack: a longer silence was a frozen process, not waiting. */
export function advanceWaitingSpan(now: number, maxGapMs: number): WaitingBudgetState {
  persist(advanceSpan(cache, now, maxGapMs));
  return cache;
}

export function waitingRemainingMs(now: number): number {
  return remainingMs(cache, now, waitingCapMs());
}

export function isWaitingBudgetExhausted(now: number): boolean {
  return budgetExhausted(cache, now, waitingCapMs());
}

export function describeWaitingBudget(now: number): string {
  return describeBudget(cache, now, waitingCapMs());
}

/** `null` clears the override, and anything above the shipped cap is refused rather than stored: this may only ever lower it. */
export async function setWaitingCapOverride(ms: number | null): Promise<void> {
  const next = ms === null ? null : clampCapOverride(ms);
  capOverrideMs = next;
  try {
    if (next === null) await AsyncStorage.removeItem(OVERRIDE_KEY);
    else await AsyncStorage.setItem(OVERRIDE_KEY, String(next));
  } catch {
    // The session still honours the override; only the restart does not.
  }
}

/** Test-only reset of the module cache. */
export function resetWaitingBudgetCache(): void {
  cache = EMPTY_WAITING_BUDGET;
  hydrated = false;
  capOverrideMs = null;
}
