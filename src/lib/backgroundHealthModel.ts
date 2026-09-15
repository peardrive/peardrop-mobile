/**
 * Shape, parsing and prompt-eligibility rules for the background-health blob.
 *
 * Pure by design — no AsyncStorage, no React, no react-native — so
 * jest.config.js can exercise the migration. `backgroundHealthStorage.ts`
 * supplies persistence, listeners and the hook, exactly as
 * `reconcileReceivedRunner.ts` supplies the effects for
 * `reconcileReceived.ts`.
 *
 * Nothing here is aware of transfers. A freeze is measured from the engine's
 * liveness counter alone, so a window with no transfer in flight records
 * identically to one that interrupted a download — see `evaluateFreeze` in
 * freezeDetect.ts, whose inputs are elapsed time and tick counts and nothing
 * else.
 */

import { GRADE_WEIGHT, type FreezeGrade } from "./freezeGrade";

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
   * The highest prompt version this user has been shown. 0 = never prompted.
   *
   * Versioned rather than boolean because the prompt's DESTINATION changed.
   * Every existing tester spent their single `hasPrompted` on the battery
   * screen, which the 2026-09-06/07 runs showed is not the setting that
   * decides the outcome. A boolean would lock exactly the people who hit the
   * problem out of the fix.
   */
  promptedVersion: number;
  /**
   * Mirrors `promptedVersion > 0`. Written but never read as truth by this
   * build; it exists so that reinstalling an older APK — which this project
   * does routinely for measurement sessions — does not re-prompt someone who
   * has already been asked. Read only by `coerceHealth` for migration.
   */
  hasPrompted: boolean;
  /**
   * WEIGHTED run of bad background windows that happened while
   * the foreground service was running.
   *
   * Not an integer count. A `frozen` window adds 1.0 and a `degraded` one
   * adds 0.5, so three outright freezes trip the threshold and it takes six
   * degraded windows to do the same — a materially higher bar, which is
   * right, because a half-working mechanism is a weaker signal than one that
   * failed outright. Both weights are exactly representable, so the sum
   * reaches the threshold exactly and needs no epsilon comparison.
   *
   * Distinct from `freezeCount`, which counts every freeze ever and keeps
   * its existing meaning untouched. A freeze with no service running is not
   * evidence of anything — the user backgrounded an idle app and Android
   * froze it, which is correct behaviour. Only a bad window that survived
   * the service indicates the mechanism failed on this device, and only a
   * run of them indicates it failed reliably rather than once.
   */
  serviceFreezeStreak: number;
  /**
   * When the streak first reached `SERVICE_FREEZE_THRESHOLD`. 0 = never.
   *
   * Sticky: once the fallback has been earned, the Settings row stays
   * available even after a later clean run resets the streak. The user has
   * been told their phone stops PearDrop; taking the fix away again because
   * one window behaved would be worse than leaving it.
   */
  fallbackTriggeredAt: number;
};

/**
 * Bump when the prompt's destination or its central claim changes enough
 * that a user who declined the previous one deserves to see the new one.
 * Not a schema version — a "we are asking you something materially
 * different" version.
 *
 *   1 — battery-restriction prompt (Sprint 6T/6Y)
 *   2 — Autostart prompt on Xiaomi (Sprint 7A)
 *   3 — service-failure fallback (Sprint 8A)
 *
 * Version 3 is materially different from both predecessors, which is why it
 * earns a bump rather than reusing 2. Those asked every user who froze once
 * to change a permission. This one is reachable only after the foreground
 * service has demonstrably failed three times on this specific device, and
 * it says so. A user who declined version 2 has not been asked this
 * question, and legacy records at version 1 or 2 are therefore eligible for
 * exactly one version-3 prompt.
 */
export const PROMPT_VERSION = 3;

/** Shape of previously-persisted state, for migration only. */
export type PersistedHealth = Partial<BackgroundHealth> & {
  /** Pre-6Y: a counter capped at three. */
  promptCount?: number;
  /** Pre-6Y companion field, read by nothing. */
  lastPromptedAtCount?: number;
};

export const EMPTY_HEALTH: BackgroundHealth = {
  freezeCount: 0,
  lastFreezeAt: 0,
  lastElapsedMs: 0,
  lastFrozenFraction: 0,
  promptedVersion: 0,
  hasPrompted: false,
  serviceFreezeStreak: 0,
  fallbackTriggeredAt: 0,
};

/**
 * Weighted units of service-attributed trouble before the fallback is
 * offered. Three outright freezes, or six degraded windows, or any mix
 * summing to three.
 *
 * One freeze is noise: a single one can be a device under memory pressure, a
 * user who force-stopped the app, or an OEM task-killer acting once. Two
 * could still be coincidence on a phone that was busy both times. Three in a
 * row, each with the service running and each with no healthy run between,
 * is a device where the mechanism does not work.
 *
 * WHY SILENCE DOES NOT RESET IT: the streak is broken only by a `healthy`
 * verdict WITH the service running — positive evidence that the mechanism
 * worked. It is deliberately not broken by time passing, by the app not
 * being used, or by background windows where no service ran. A user who hits
 * this three times over three weeks has the same broken device as one who
 * hits it three times in an afternoon, and an elapsed-time reset would
 * quietly protect the device from ever being diagnosed.
 *
 * Note that a `degraded` window no longer resets it either. That is the
 * point of grading: under the old boolean every Samsung run in the
 * series read `ran-normally` and would have cleared the streak
 * forever on a device that plainly needed the fallback.
 */
export const SERVICE_FREEZE_THRESHOLD = 3;

/**
 * Resolve which prompt version a stored blob represents.
 *
 * Three generations are in the wild:
 *   pre-6Y   `promptCount: 0..3`
 *   6Y-6Z    `hasPrompted: boolean`
 *   7A+      `promptedVersion: number`
 *
 * The older two both mean "was shown the battery prompt", which is version 1.
 * Anything unparseable falls to 0, which errs toward asking once — the safe
 * direction for a one-shot offer.
 */
function resolvePromptedVersion(parsed: PersistedHealth): number {
  const explicit = Number(parsed.promptedVersion);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const legacyPrompted =
    parsed.hasPrompted === true || (Number(parsed.promptCount) || 0) > 0;
  return legacyPrompted ? 1 : 0;
}

/**
 * Parse a stored blob. Never throws; unreadable state yields a fresh record
 * rather than a crash, because losing the freeze history is preferable to
 * failing to boot over it.
 *
 * Freeze history is migrated, not reset: `freezeCount` and the three `last*`
 * fields carry across untouched.
 */
export function coerceHealth(raw: string | null): BackgroundHealth {
  if (!raw) return { ...EMPTY_HEALTH };
  try {
    const parsed = JSON.parse(raw) as PersistedHealth;
    const promptedVersion = resolvePromptedVersion(parsed);
    return {
      freezeCount: Number(parsed.freezeCount) || 0,
      lastFreezeAt: Number(parsed.lastFreezeAt) || 0,
      lastElapsedMs: Number(parsed.lastElapsedMs) || 0,
      lastFrozenFraction: Number(parsed.lastFrozenFraction) || 0,
      promptedVersion,
      hasPrompted: promptedVersion > 0,
      // absent in every pre-8A record, so a legacy blob migrates
      // to a zero streak and an un-triggered fallback. Migrated, not reset:
      // freezeCount and the three last* fields above carry across untouched,
      // exactly as 7A did for promptedVersion.
      serviceFreezeStreak: Number(parsed.serviceFreezeStreak) || 0,
      fallbackTriggeredAt: Number(parsed.fallbackTriggeredAt) || 0,
    };
  } catch {
    return { ...EMPTY_HEALTH };
  }
}

/**
 * Fold one graded background window into the record. Pure; the caller
 * persists the result.
 *
 * Call ONLY for windows where the service was running and the verdict was
 * gradeable. A `no-service` window and an ungradeable one (too short, too
 * little signal) must not reach here at all — neither adds to the streak nor
 * clears it.
 *
 * `healthy` resets; everything else accumulates its weight. `fallbackTriggeredAt`
 * is stamped once and never cleared: the row is sticky once earned.
 */
export function withServiceWindow(
  current: BackgroundHealth,
  grade: FreezeGrade,
  now: number
): BackgroundHealth {
  if (grade === "healthy") {
    if (current.serviceFreezeStreak === 0) return current;
    return { ...current, serviceFreezeStreak: 0 };
  }

  const serviceFreezeStreak =
    current.serviceFreezeStreak + GRADE_WEIGHT[grade];
  return {
    ...current,
    serviceFreezeStreak,
    fallbackTriggeredAt:
      current.fallbackTriggeredAt === 0 &&
      serviceFreezeStreak >= SERVICE_FREEZE_THRESHOLD
        ? now
        : current.fallbackTriggeredAt,
  };
}

/**
 * Whether the per-OEM fallback has been earned on this device.
 *
 * Reads the sticky stamp rather than the live streak, so a clean run after
 * the third freeze does not withdraw a fix the user has already been shown.
 */
export function hasFallbackTriggered(health: BackgroundHealth): boolean {
  return health.fallbackTriggeredAt > 0;
}

/**
 * Whether the prompt may appear. True at most once per prompt version: a
 * freeze has been recorded, and this user has not been shown THIS version.
 *
 * Freezes are still detected, counted and persisted regardless — this gates
 * only the asking. The Settings rows are permanent, so the option stays
 * reachable after the single ask.
 */
export function shouldPrompt(health: BackgroundHealth): boolean {
  // gated on the FALLBACK having triggered, not on any freeze.
  //
  // Versions 1 and 2 asked after a single freeze, because nothing else was
  // trying to solve the problem. The foreground service now does, and solves
  // it without asking on every device measured — so a lone freeze is no
  // longer grounds to send anyone into system settings. Only a device where
  // the service has demonstrably failed earns the question.
  if (!hasFallbackTriggered(health)) return false;
  return health.promptedVersion < PROMPT_VERSION;
}

/**
 * Record a detected freeze. Pure; the caller persists the result.
 *
 * Deliberately does not consult prompt state — a freeze counts whether or not
 * the user has been asked, and whether or not anything was transferring.
 */
export function withFreeze(
  current: BackgroundHealth,
  at: number,
  elapsedMs: number,
  frozenFraction: number
): BackgroundHealth {
  return {
    ...current,
    freezeCount: current.freezeCount + 1,
    lastFreezeAt: at,
    lastElapsedMs: elapsedMs,
    lastFrozenFraction: frozenFraction,
  };
}

/**
 * Mark the current prompt version as shown. Jumps straight to
 * `PROMPT_VERSION` rather than incrementing, so a user who never saw version
 * 1 is not owed two prompts to catch up.
 */
export function withPrompted(current: BackgroundHealth): BackgroundHealth {
  return { ...current, promptedVersion: PROMPT_VERSION, hasPrompted: true };
}
