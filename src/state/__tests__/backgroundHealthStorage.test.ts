/**
 * A falsely-earned stamp must be clearable by a shipping user, exactly once.
 * Only AsyncStorage, `debugLog` and `devGate` are replaced, and `devGate` is
 * mocked to `isDebugBuild: false` throughout, because a release build is the
 * condition at issue.
 *
 * Idempotence is a property of what was persisted, so the backing store is
 * inspected and not just the returned object.
 */

type Store = {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};

let backing: Store;
let logLines: { level: string; tag: string; message: string }[] = [];

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (k: string) => backing.getItem(k),
    setItem: (k: string, v: string) => backing.setItem(k, v),
  },
}));

jest.mock("../../lib/debugLog", () => ({
  __esModule: true,
  log: (level: string, tag: string, message: string) => {
    logLines.push({ level, tag, message });
  },
  logStructuredError: () => {},
}));

// A RELEASE build. This is the condition the defect lives in.
jest.mock("../../lib/devGate", () => ({
  __esModule: true,
  IS_DEBUG_BUILD: false,
}));

const STORAGE_KEY = "peardrop.background-health";

type Mod = typeof import("../backgroundHealthStorage");

/** A store whose contents the test can read back after the module writes. */
function makeStore(initial: string | null): Store & { value: string | null } {
  const s = {
    value: initial,
    getItem: async (k: string) => (k === STORAGE_KEY ? s.value : null),
    setItem: async (k: string, v: string) => {
      if (k === STORAGE_KEY) s.value = v;
    },
  };
  return s;
}

/** Fresh module state per launch — `cache` is module-level and lives once. */
function launch(store: Store): Mod {
  backing = store;
  let mod!: Mod;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../backgroundHealthStorage") as Mod;
  });
  return mod;
}

beforeEach(() => {
  logLines = [];
});

/** A legacy record: stamped, prompted, no schemaVersion. */
const LEGACY_STAMPED = JSON.stringify({
  freezeCount: 7,
  lastFreezeAt: 1_700_000_000_000,
  lastElapsedMs: 120_000,
  lastFrozenFraction: 0.96,
  promptedVersion: 3,
  hasPrompted: true,
  serviceFreezeStreak: 3,
  fallbackTriggeredAt: 1_700_000_100_000,
});

describe("CONTROL — the defect is real in a release build", () => {
  /**
   * Why the migration has to exist: the only in-app clear is
   * `resetBackgroundHealthForTesting`, and it returns early unless
   * `IS_DEBUG_BUILD`. If this ever starts clearing, the gate has moved.
   */
  it("resetBackgroundHealthForTesting cannot clear the stamp for a shipping user", async () => {
    const store = makeStore(LEGACY_STAMPED);
    const mod = launch(store);
    // Hydrate first so the migration has already run and settled.
    await mod.getBackgroundHealth();
    const before = await mod.getBackgroundHealth();
    const after = await mod.resetBackgroundHealthForTesting();
    expect(after).toEqual(before);
  });

  /** Positive control on the fixture: it really does carry a stamp. */
  it("the legacy fixture is stamped and carries no schema version", () => {
    const parsed = JSON.parse(LEGACY_STAMPED) as Record<string, unknown>;
    expect(parsed.fallbackTriggeredAt).toBeGreaterThan(0);
    expect(parsed.serviceFreezeStreak).toBeGreaterThan(0);
    expect("schemaVersion" in parsed).toBe(false);
  });
});

describe("absent schema version → cleared once, logged once", () => {
  it("clears the stamp, the streak and the prompt, and keeps freeze history", async () => {
    const store = makeStore(LEGACY_STAMPED);
    const mod = launch(store);
    const health = await mod.getBackgroundHealth();

    expect(health.fallbackTriggeredAt).toBe(0);
    expect(health.serviceFreezeStreak).toBe(0);
    expect(health.promptedVersion).toBe(0);
    expect(health.hasPrompted).toBe(false);
    expect(health.schemaVersion).toBe(mod.HEALTH_SCHEMA_VERSION);

    // Freeze history is a record of things that really happened, often across
    // weeks. Clearing an unearned stamp must not destroy measurement data.
    expect(health.freezeCount).toBe(7);
    expect(health.lastFreezeAt).toBe(1_700_000_000_000);
    expect(health.lastElapsedMs).toBe(120_000);
    expect(health.lastFrozenFraction).toBe(0.96);
  });

  it("the prompt becomes reachable again, which is the point of the coupling to D-12", async () => {
    const store = makeStore(LEGACY_STAMPED);
    const mod = launch(store);
    const health = await mod.getBackgroundHealth();
    // Not prompt-eligible yet: the stamp is gone, so it must be re-earned
    // under the corrected calibration rather than handed back.
    expect(mod.shouldPrompt(health)).toBe(false);
    // …and once earned again, the prompt is not blocked by a stale
    // promptedVersion.
    const earned = await mod.recordServiceWindow("frozen");
    await mod.recordServiceWindow("frozen");
    const third = await mod.recordServiceWindow("frozen");
    expect(earned.fallbackTriggeredAt).toBe(0);
    expect(third.fallbackTriggeredAt).toBeGreaterThan(0);
    expect(mod.shouldPrompt(third)).toBe(true);
  });

  it("writes exactly one log line, on a tag that reaches the exported log", async () => {
    const store = makeStore(LEGACY_STAMPED);
    const mod = launch(store);
    await mod.getBackgroundHealth();
    // Concurrent readers must not each produce a line.
    await Promise.all([mod.getBackgroundHealth(), mod.getBackgroundHealth()]);

    expect(logLines.length).toBe(1);
    expect(logLines[0]?.tag).toBe("rn.fallback");
    expect(logLines[0]?.level).toBe("warn");
    // Says what it did, in terms that are diagnosable from an exported log.
    expect(logLines[0]?.message).toContain("cleared a fallback stamp");
  });

  it("persists the new schema version — without this the clear repeats forever", async () => {
    const store = makeStore(LEGACY_STAMPED);
    const mod = launch(store);
    await mod.getBackgroundHealth();
    const written = JSON.parse(String(store.value)) as Record<string, unknown>;
    expect(written.schemaVersion).toBe(mod.HEALTH_SCHEMA_VERSION);
    expect(written.fallbackTriggeredAt).toBe(0);
    expect(written.freezeCount).toBe(7);
  });
});

describe("idempotence — it runs once, not every launch", () => {
  /**
   * THE SECOND LAUNCH. The stamp must be earnable again and STAY earned; a
   * migration that fired every launch would make the fallback row impossible to
   * keep, which is a worse bug than the one being fixed.
   */
  it("a stamp earned after the clear survives the next launch", async () => {
    const store = makeStore(LEGACY_STAMPED);

    const first = launch(store);
    await first.getBackgroundHealth();
    await first.recordServiceWindow("frozen");
    await first.recordServiceWindow("frozen");
    const earned = await first.recordServiceWindow("frozen");
    expect(earned.fallbackTriggeredAt).toBeGreaterThan(0);

    logLines = [];
    const second = launch(store);
    const health = await second.getBackgroundHealth();
    expect(health.fallbackTriggeredAt).toBe(earned.fallbackTriggeredAt);
    expect(health.serviceFreezeStreak).toBe(earned.serviceFreezeStreak);
    expect(logLines.length).toBe(0);
  });

  it("a record already at the current version is untouched and unlogged", async () => {
    const current = JSON.stringify({
      schemaVersion: 1,
      freezeCount: 2,
      lastFreezeAt: 5,
      lastElapsedMs: 6,
      lastFrozenFraction: 0.5,
      promptedVersion: 3,
      hasPrompted: true,
      serviceFreezeStreak: 3,
      fallbackTriggeredAt: 999,
    });
    const store = makeStore(current);
    const mod = launch(store);
    const health = await mod.getBackgroundHealth();

    expect(health.fallbackTriggeredAt).toBe(999);
    expect(health.serviceFreezeStreak).toBe(3);
    expect(health.promptedVersion).toBe(3);
    expect(logLines.length).toBe(0);
    // Nothing was written either — no version change, no clear, no write.
    expect(store.value).toBe(current);
  });
});

describe("records with nothing to forgive", () => {
  it("a fresh install is born current: no clear, no log, no write", async () => {
    const store = makeStore(null);
    const mod = launch(store);
    const health = await mod.getBackgroundHealth();
    expect(health.schemaVersion).toBe(mod.HEALTH_SCHEMA_VERSION);
    expect(health.fallbackTriggeredAt).toBe(0);
    expect(logLines.length).toBe(0);
    expect(store.value).toBeNull();
  });

  it("a legacy record with no stamp keeps its prompt answer and is not logged", async () => {
    // Someone who declined the battery prompt and never hit the service
    // ladder: zeroing promptedVersion would re-ask an answered question.
    const store = makeStore(
      JSON.stringify({
        freezeCount: 1,
        lastFreezeAt: 11,
        promptedVersion: 2,
        hasPrompted: true,
        serviceFreezeStreak: 0,
        fallbackTriggeredAt: 0,
      }),
    );
    const mod = launch(store);
    const health = await mod.getBackgroundHealth();

    expect(health.promptedVersion).toBe(2);
    expect(health.freezeCount).toBe(1);
    expect(logLines.length).toBe(0);
    // The version IS stamped forward, so this record never re-enters the
    // migration branch on a later launch.
    expect(health.schemaVersion).toBe(mod.HEALTH_SCHEMA_VERSION);
    expect(
      (JSON.parse(String(store.value)) as Record<string, unknown>).schemaVersion,
    ).toBe(mod.HEALTH_SCHEMA_VERSION);
  });

  it("a streak with no stamp clears the streak but keeps the prompt answer", async () => {
    const store = makeStore(
      JSON.stringify({
        freezeCount: 4,
        promptedVersion: 2,
        hasPrompted: true,
        serviceFreezeStreak: 2,
        fallbackTriggeredAt: 0,
      }),
    );
    const mod = launch(store);
    const health = await mod.getBackgroundHealth();

    expect(health.serviceFreezeStreak).toBe(0);
    expect(health.promptedVersion).toBe(2);
    expect(health.freezeCount).toBe(4);
    expect(logLines.length).toBe(1);
    expect(logLines[0]?.tag).toBe("rn.fallback");
  });
});
