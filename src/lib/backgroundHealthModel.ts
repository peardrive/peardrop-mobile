/**
 * Shape, parsing and prompt-eligibility rules for the background-health blob.
 * Pure by design — no AsyncStorage, no React, no react-native — so the tests
 * can exercise the migration; `backgroundHealthStorage.ts` supplies
 * persistence, listeners and the hook. Nothing here is aware of transfers: a
 * freeze is measured from the engine's liveness counter alone.
 */

import { GRADE_WEIGHT, type FreezeGrade } from "./freezeGrade";

export type BackgroundHealth = {
  /** A schema version and nothing else — not `PROMPT_VERSION`, which tracks
   *  whether the question being asked has materially changed. `0` means
   *  written before this field existed, which is the only thing
   *  `withSchemaMigration` needs to key on. */
  schemaVersion: number;
  /** How many freezes have been observed, ever. */
  freezeCount: number;
  /** When the most recent one was detected. 0 = never. */
  lastFreezeAt: number;
  /** How long that backgrounding lasted, ms. */
  lastElapsedMs: number;
  /** 0..1, how much of it the engine was frozen for. */
  lastFrozenFraction: number;
  /** The highest prompt version this user has been shown. 0 = never prompted.
   *  Versioned rather than boolean because the prompt's destination changes,
   *  and a boolean would lock the people who hit the problem out of the fix. */
  promptedVersion: number;
  /** Mirrors `promptedVersion > 0`, and is read only by `coerceHealth`. It
   *  exists so that installing an older build does not re-prompt someone who
   *  has already been asked. */
  hasPrompted: boolean;
  /** Weighted run of bad background windows seen while the foreground service
   *  was running. A `frozen` window adds 1.0 and a `degraded` one 0.5, since a
   *  half-working mechanism is a weaker signal than one that failed outright.
   *  A freeze with no service running is not evidence and is not counted. */
  serviceFreezeStreak: number;
  /** When the streak first reached `SERVICE_FREEZE_THRESHOLD`. 0 = never.
   *  Sticky: once the fallback is earned the Settings row stays available
   *  even after a later clean run resets the streak. */
  fallbackTriggeredAt: number;
};

/** Bump when the prompt's destination or its central claim changes enough that
 *  a user who declined the previous one deserves to see the new one. Not a
 *  schema version. Version 3 is reachable only after the foreground service
 *  has demonstrably failed on this device, which is why it earns a bump. */
export const PROMPT_VERSION = 3;

/** Shape of state persisted by earlier builds, for migration only. */
export type PersistedHealth = Partial<BackgroundHealth> & {
  /** Legacy: a counter capped at three. */
  promptCount?: number;
  /** Legacy companion field, read by nothing. */
  lastPromptedAtCount?: number;
};

/** The current schema version. Bump only to force another one-shot clear of
 *  the fallback stamp: every bump costs every user their streak and their
 *  earned Settings row. Adding a field needs no bump, because `coerceHealth`
 *  already migrates absent fields to their zero value. */
export const HEALTH_SCHEMA_VERSION = 1;

export const EMPTY_HEALTH: BackgroundHealth = {
  // A fresh record is born current: there is no pre-version stamp to clear, so
  // the migration must not fire for one.
  schemaVersion: HEALTH_SCHEMA_VERSION,
  freezeCount: 0,
  lastFreezeAt: 0,
  lastElapsedMs: 0,
  lastFrozenFraction: 0,
  promptedVersion: 0,
  hasPrompted: false,
  serviceFreezeStreak: 0,
  fallbackTriggeredAt: 0,
};

/** Weighted units of service-attributed trouble before the fallback is
 *  offered. One freeze is noise; a run of them is a device where the mechanism
 *  does not work. The streak is broken only by a `healthy` verdict with the
 *  service running, never by time passing or by a `degraded` window. */
export const SERVICE_FREEZE_THRESHOLD = 3;

/** Resolve which prompt version a stored blob represents. A legacy
 *  `promptCount` or `hasPrompted` both mean version 1. Anything unparseable
 *  falls to 0, erring toward asking once, which is safe for a one-shot
 *  offer. */
function resolvePromptedVersion(parsed: PersistedHealth): number {
  const explicit = Number(parsed.promptedVersion);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const legacyPrompted =
    parsed.hasPrompted === true || (Number(parsed.promptCount) || 0) > 0;
  return legacyPrompted ? 1 : 0;
}

/** Parse a stored blob. Never throws: losing the freeze history is preferable
 *  to failing to boot over it. Freeze history is migrated, not reset —
 *  `freezeCount` and the three `last*` fields carry across untouched. */
export function coerceHealth(raw: string | null): BackgroundHealth {
  if (!raw) return { ...EMPTY_HEALTH };
  try {
    const parsed = JSON.parse(raw) as PersistedHealth;
    const promptedVersion = resolvePromptedVersion(parsed);
    return {
      // Differs from EMPTY_HEALTH deliberately: a record that exists and
      // carries no version predates the version; a missing record does not.
      schemaVersion: Number(parsed.schemaVersion) || 0,
      freezeCount: Number(parsed.freezeCount) || 0,
      lastFreezeAt: Number(parsed.lastFreezeAt) || 0,
      lastElapsedMs: Number(parsed.lastElapsedMs) || 0,
      lastFrozenFraction: Number(parsed.lastFrozenFraction) || 0,
      promptedVersion,
      hasPrompted: promptedVersion > 0,
      // Absent in legacy blobs, which migrate to a zero streak and an
      // un-triggered fallback; the fields above carry across untouched.
      serviceFreezeStreak: Number(parsed.serviceFreezeStreak) || 0,
      fallbackTriggeredAt: Number(parsed.fallbackTriggeredAt) || 0,
    };
  } catch {
    return { ...EMPTY_HEALTH };
  }
}

/** One-shot clear of a fallback stamp that no path in the app can otherwise
 *  reach, since the stamp is sticky by design. The version is stamped forward
 *  whether or not anything was cleared, so this is an amnesty rather than a
 *  recurring wipe. `next === current` means nothing to do. */
export function withSchemaMigration(current: BackgroundHealth): {
  next: BackgroundHealth;
  cleared: boolean;
} {
  if (current.schemaVersion >= HEALTH_SCHEMA_VERSION) {
    return { next: current, cleared: false };
  }

  // Evidence of the service-failure ladder specifically. A record with
  // neither is untouched apart from the stamp: there is nothing to forgive.
  const hadStamp = current.fallbackTriggeredAt > 0;
  const hadStreak = current.serviceFreezeStreak > 0;

  if (!hadStamp && !hadStreak) {
    return {
      next: { ...current, schemaVersion: HEALTH_SCHEMA_VERSION },
      cleared: false,
    };
  }

  // `promptedVersion` is cleared only alongside a real stamp: zeroing it on a
  // streak-only record would re-ask a different, already-answered question.
  return {
    next: {
      ...current,
      schemaVersion: HEALTH_SCHEMA_VERSION,
      serviceFreezeStreak: 0,
      fallbackTriggeredAt: 0,
      ...(hadStamp ? { promptedVersion: 0, hasPrompted: false } : {}),
    },
    cleared: true,
  };
}

/** Fold one graded background window into the record. Call only for windows
 *  where the service was running and the verdict was gradeable; a `no-service`
 *  or ungradeable window must neither add to the streak nor clear it.
 *  `fallbackTriggeredAt` is stamped once and never cleared. */
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

/** Whether the per-OEM fallback has been earned on this device. Reads the
 *  sticky stamp rather than the live streak, so a later clean run does not
 *  withdraw a fix the user has already been shown. */
export function hasFallbackTriggered(health: BackgroundHealth): boolean {
  return health.fallbackTriggeredAt > 0;
}

/** Whether the prompt may appear: true at most once per prompt version.
 *  Freezes are still detected, counted and persisted regardless — this gates
 *  only the asking, and the Settings rows stay reachable afterwards. */
export function shouldPrompt(health: BackgroundHealth): boolean {
  // Gated on the fallback having triggered, not on any freeze: a lone freeze
  // is not grounds to send anyone into system settings.
  if (!hasFallbackTriggered(health)) return false;
  return health.promptedVersion < PROMPT_VERSION;
}

/** Record a detected freeze. Deliberately does not consult prompt state: a
 *  freeze counts whether or not the user has been asked, and whether or not
 *  anything was transferring. */
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

/** Mark the current prompt version as shown. Jumps straight to
 *  `PROMPT_VERSION` rather than incrementing, so a user who never saw version
 *  1 is not owed two prompts to catch up. */
export function withPrompted(current: BackgroundHealth): BackgroundHealth {
  return { ...current, promptedVersion: PROMPT_VERSION, hasPrompted: true };
}
