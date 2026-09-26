// Prompt-version migration for the background-health blob. Every existing
// install spent its single `hasPrompted` on the battery prompt, which is not
// the setting that decides the outcome. A boolean flag would lock exactly the
// people who hit the problem out of the fix; these tests pin the migration
// that unlocks them once, and only once.

import {
  EMPTY_HEALTH,
  PROMPT_VERSION,
  SERVICE_FREEZE_THRESHOLD,
  coerceHealth,
  hasFallbackTriggered,
  shouldPrompt,
  withFreeze,
  withPrompted,
  withServiceWindow,
  type BackgroundHealth,
} from "../backgroundHealthModel";

/** Three service-attributed freezes — the minimum that earns the fallback. */
function tripFallback(h: BackgroundHealth): BackgroundHealth {
  let next = h;
  for (let i = 1; i <= 3; i++) next = withServiceWindow(next, "frozen", i * 1_000);
  return next;
}

/** A blob as an older build would have written it. */
function legacy(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    freezeCount: 3,
    lastFreezeAt: 1_788_000_000_000,
    lastElapsedMs: 610_000,
    lastFrozenFraction: 0.97,
    ...over,
  });
}

describe("coerceHealth — migration", () => {
  test("6Y/6Z state with hasPrompted:true becomes version 1", () => {
    const h = coerceHealth(legacy({ hasPrompted: true }));
    expect(h.promptedVersion).toBe(1);
    expect(h.hasPrompted).toBe(true);
  });

  test("6Y/6Z state with hasPrompted:false becomes version 0", () => {
    const h = coerceHealth(legacy({ hasPrompted: false }));
    expect(h.promptedVersion).toBe(0);
    expect(h.hasPrompted).toBe(false);
  });

  test("pre-6Y promptCount>0 also becomes version 1", () => {
    expect(coerceHealth(legacy({ promptCount: 1 })).promptedVersion).toBe(1);
    expect(coerceHealth(legacy({ promptCount: 3 })).promptedVersion).toBe(1);
  });

  test("pre-6Y promptCount:0 becomes version 0", () => {
    expect(coerceHealth(legacy({ promptCount: 0 })).promptedVersion).toBe(0);
  });

  test("an explicit promptedVersion is taken as-is", () => {
    expect(coerceHealth(legacy({ promptedVersion: 2 })).promptedVersion).toBe(2);
    expect(coerceHealth(legacy({ promptedVersion: 7 })).promptedVersion).toBe(7);
  });

  test("freeze history survives migration untouched", () => {
    const h = coerceHealth(legacy({ hasPrompted: true }));
    expect(h.freezeCount).toBe(3);
    expect(h.lastFreezeAt).toBe(1_788_000_000_000);
    expect(h.lastElapsedMs).toBe(610_000);
    expect(h.lastFrozenFraction).toBe(0.97);
  });

  test("absent, empty and unparseable state all yield a fresh record", () => {
    expect(coerceHealth(null)).toEqual(EMPTY_HEALTH);
    expect(coerceHealth("")).toEqual(EMPTY_HEALTH);
    expect(coerceHealth("{not json")).toEqual(EMPTY_HEALTH);
  });

  test("a garbage promptedVersion falls back to the legacy reading", () => {
    // Errs toward asking once, which is the safe direction for a one-shot.
    expect(
      coerceHealth(legacy({ promptedVersion: "banana", hasPrompted: true }))
        .promptedVersion
    ).toBe(1);
    expect(
      coerceHealth(legacy({ promptedVersion: -4 })).promptedVersion
    ).toBe(0);
  });
});

describe("shouldPrompt — one prompt per version", () => {
  test("a user who saw an older prompt gets the version-3 one exactly once", () => {
    // a legacy record is eligible, but only once the fallback has
    // actually triggered on their device. Migration alone is not a ticket.
    const migrated = coerceHealth(legacy({ hasPrompted: true }));
    expect(shouldPrompt(migrated)).toBe(false);

    const earned = tripFallback(migrated);
    expect(earned.promptedVersion).toBe(1);
    expect(shouldPrompt(earned)).toBe(true);

    const afterShowing = withPrompted(earned);
    expect(afterShowing.promptedVersion).toBe(PROMPT_VERSION);
    expect(shouldPrompt(afterShowing)).toBe(false);
  });

  test("a freeze alone no longer earns a prompt", () => {
    // A lone freeze is not grounds to send anyone into system settings: the
    // foreground service covers that case.
    const oneFreeze = withFreeze(coerceHealth(null), 1, 610_000, 0.97);
    expect(oneFreeze.freezeCount).toBe(1);
    expect(shouldPrompt(oneFreeze)).toBe(false);

    // …and three service-attributed freezes on top of it do.
    const earned = tripFallback(oneFreeze);
    expect(shouldPrompt(earned)).toBe(true);
    expect(shouldPrompt(withPrompted(earned))).toBe(false);
  });

  test("a second freeze after prompting yields none", () => {
    const prompted = withPrompted(withFreeze(coerceHealth(null), 1, 610_000, 0.97));
    const again = withFreeze(prompted, 2, 700_000, 0.99);
    expect(again.freezeCount).toBe(2);
    expect(shouldPrompt(again)).toBe(false);
  });

  test("no freeze on record means no prompt, at any version", () => {
    expect(shouldPrompt(EMPTY_HEALTH)).toBe(false);
    expect(
      shouldPrompt(coerceHealth(legacy({ freezeCount: 0, hasPrompted: true })))
    ).toBe(false);
  });

  test("a user already at the current version is never re-asked", () => {
    const current = coerceHealth(legacy({ promptedVersion: PROMPT_VERSION }));
    expect(shouldPrompt(current)).toBe(false);
  });

  test("withPrompted jumps to the current version rather than incrementing", () => {
    // Someone who never saw version 1 must not owe two prompts to catch up.
    const neverAsked = withFreeze(coerceHealth(null), 1, 610_000, 0.97);
    expect(withPrompted(neverAsked).promptedVersion).toBe(PROMPT_VERSION);
  });
});

describe("withFreeze — transfer-independent", () => {
  test("counts a freeze regardless of prompt state", () => {
    const prompted = withPrompted(coerceHealth(null));
    expect(withFreeze(prompted, 1, 610_000, 0.97).freezeCount).toBe(1);
    expect(withFreeze(prompted, 1, 610_000, 0.97).promptedVersion).toBe(
      PROMPT_VERSION
    );
  });

  test("accumulates and overwrites the last-freeze fields", () => {
    let h: BackgroundHealth = coerceHealth(null);
    h = withFreeze(h, 100, 610_000, 0.97);
    h = withFreeze(h, 200, 313_000, 0.6);
    expect(h.freezeCount).toBe(2);
    expect(h.lastFreezeAt).toBe(200);
    expect(h.lastElapsedMs).toBe(313_000);
    expect(h.lastFrozenFraction).toBe(0.6);
  });

  test("the persisted mirror stays consistent with the version", () => {
    // An older APK reinstalled for a measurement session reads `hasPrompted`
    // and must not re-prompt someone who has already been asked.
    expect(withPrompted(coerceHealth(null)).hasPrompted).toBe(true);
    expect(coerceHealth(null).hasPrompted).toBe(false);
  });
});


// Weighted service-attributed streak. A bad window with no service running is
// Android correctly freezing an idle app, and must never count toward offering
// the user a per-OEM setting to change; only windows that survived the service
// reach here. `degraded` carries half the weight of `frozen`, because a
// boolean reads a degraded window as `ran-normally` and would clear the streak
// forever on a device that plainly needs the fallback.

describe("weighted service-attributed streak", () => {
  test("three consecutive frozen windows trip the fallback", () => {
    let h: BackgroundHealth = coerceHealth(null);
    expect(hasFallbackTriggered(h)).toBe(false);

    h = withServiceWindow(h, "frozen", 1_000);
    expect(h.serviceFreezeStreak).toBe(1);
    expect(hasFallbackTriggered(h)).toBe(false);

    h = withServiceWindow(h, "frozen", 2_000);
    expect(h.serviceFreezeStreak).toBe(2);
    expect(hasFallbackTriggered(h)).toBe(false);

    h = withServiceWindow(h, "frozen", 3_000);
    expect(h.serviceFreezeStreak).toBe(SERVICE_FREEZE_THRESHOLD);
    expect(hasFallbackTriggered(h)).toBe(true);
    expect(h.fallbackTriggeredAt).toBe(3_000);
  });

  test("two frozen then a healthy run does not trip it", () => {
    let h: BackgroundHealth = coerceHealth(null);
    h = withServiceWindow(h, "frozen", 1_000);
    h = withServiceWindow(h, "frozen", 2_000);
    expect(h.serviceFreezeStreak).toBe(2);

    h = withServiceWindow(h, "healthy", 2_500);
    expect(h.serviceFreezeStreak).toBe(0);
    expect(hasFallbackTriggered(h)).toBe(false);

    // …and the count starts again from scratch.
    h = withServiceWindow(h, "frozen", 3_000);
    expect(h.serviceFreezeStreak).toBe(1);
    expect(hasFallbackTriggered(h)).toBe(false);
  });

  test("six degraded windows trip it and five do not", () => {
    let five: BackgroundHealth = coerceHealth(null);
    for (let i = 1; i <= 5; i++) {
      five = withServiceWindow(five, "degraded", i * 1_000);
    }
    expect(five.serviceFreezeStreak).toBe(2.5);
    expect(hasFallbackTriggered(five)).toBe(false);

    const six = withServiceWindow(five, "degraded", 6_000);
    expect(six.serviceFreezeStreak).toBe(3);
    expect(hasFallbackTriggered(six)).toBe(true);
    expect(six.fallbackTriggeredAt).toBe(6_000);
  });

  test("frozen and degraded mix on the same scale", () => {
    let h: BackgroundHealth = coerceHealth(null);
    h = withServiceWindow(h, "frozen", 1_000); // 1.0
    h = withServiceWindow(h, "degraded", 2_000); // 1.5
    h = withServiceWindow(h, "degraded", 3_000); // 2.0
    expect(h.serviceFreezeStreak).toBe(2);
    expect(hasFallbackTriggered(h)).toBe(false);

    h = withServiceWindow(h, "frozen", 4_000); // 3.0
    expect(h.serviceFreezeStreak).toBe(3);
    expect(hasFallbackTriggered(h)).toBe(true);
  });

  test("a degraded window does not reset the streak", () => {
    // The regression the grading exists to prevent: a boolean reads a
    // degraded window as `ran-normally` and would clear this.
    let h: BackgroundHealth = coerceHealth(null);
    h = withServiceWindow(h, "frozen", 1_000);
    h = withServiceWindow(h, "frozen", 2_000);
    h = withServiceWindow(h, "degraded", 3_000);
    expect(h.serviceFreezeStreak).toBe(2.5);
    h = withServiceWindow(h, "degraded", 4_000);
    expect(h.serviceFreezeStreak).toBe(3);
    expect(hasFallbackTriggered(h)).toBe(true);
  });

  test("only healthy resets, and only when there is something to reset", () => {
    const zero: BackgroundHealth = coerceHealth(null);
    // Same object back: the caller skips the write and the subscriber wake.
    expect(withServiceWindow(zero, "healthy", 1_000)).toBe(zero);
  });

  test("no-service windows are ignored entirely", () => {
    // The caller never invokes withServiceWindow for a no-service window.
    // This pins the consequence: an unbroken run of them leaves the record
    // untouched, so a user who backgrounds an idle app forever is never
    // offered a fix for a problem they do not have.
    const h: BackgroundHealth = coerceHealth(null);
    expect(h.serviceFreezeStreak).toBe(0);
    expect(hasFallbackTriggered(h)).toBe(false);
  });

  test("the fallback stamp is sticky once earned", () => {
    let h: BackgroundHealth = coerceHealth(null);
    h = withServiceWindow(h, "frozen", 1_000);
    h = withServiceWindow(h, "frozen", 2_000);
    h = withServiceWindow(h, "frozen", 3_000);
    expect(hasFallbackTriggered(h)).toBe(true);

    h = withServiceWindow(h, "healthy", 4_000);
    expect(h.serviceFreezeStreak).toBe(0);
    // The row does not disappear because one window behaved.
    expect(hasFallbackTriggered(h)).toBe(true);
    expect(h.fallbackTriggeredAt).toBe(3_000);

    // A later run does not re-stamp the original trigger time.
    h = withServiceWindow(h, "frozen", 9_000);
    h = withServiceWindow(h, "frozen", 10_000);
    h = withServiceWindow(h, "frozen", 11_000);
    expect(h.fallbackTriggeredAt).toBe(3_000);
  });

  test("a legacy record migrates without tripping", () => {
    // A legacy blob has neither field. It must arrive with a zero streak and
    // an un-triggered fallback, while its freeze history carries across.
    const h = coerceHealth(legacy({ freezeCount: 9, hasPrompted: true }));
    expect(h.freezeCount).toBe(9);
    expect(h.serviceFreezeStreak).toBe(0);
    expect(h.fallbackTriggeredAt).toBe(0);
    expect(hasFallbackTriggered(h)).toBe(false);
    // freezeCount is not repurposed: nine historical freezes do not count as
    // service-attributed ones.
    expect(h.freezeCount).not.toBe(h.serviceFreezeStreak);
  });

  test("EMPTY_HEALTH carries the new fields", () => {
    expect(EMPTY_HEALTH.serviceFreezeStreak).toBe(0);
    expect(EMPTY_HEALTH.fallbackTriggeredAt).toBe(0);
  });
});
