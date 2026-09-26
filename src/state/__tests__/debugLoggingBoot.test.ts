/**
 * The worklet must be told the log flag before `engineInit` runs.
 * `debugEnabledRef` starts `false` and is only set true from an async
 * AsyncStorage read, so a synchronous read at boot reports `false` while the
 * persisted value is `true`, and the boot lines are emitted against a false
 * flag. The first test is the control for that race; the rest exercise
 * `awaitDebugLogging`, which the boot path uses instead.
 */

type Store = {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};

let backing: Store;

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (k: string) => backing.getItem(k),
    setItem: (k: string, v: string) => backing.setItem(k, v),
  },
}));

const MODULE_PATH =
  process.env.PEARDROP_DEBUG_LOG_STORAGE ?? "../debugLogStorage";

type Mod = typeof import("../debugLogStorage") & {
  awaitDebugLogging?: (timeoutMs?: number) => Promise<boolean>;
};

/** Fresh module state per test — `cache` is module-level and one-way. */
function load(store: Store): Mod {
  backing = store;
  let mod!: Mod;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(MODULE_PATH) as Mod;
  });
  return mod;
}

function storeHolding(value: string | null): Store {
  return {
    getItem: async () => value,
    setItem: async () => {},
  };
}

/** A store that never answers — the reason the wait has to be bounded. */
function storeThatHangs(): Store {
  return {
    getItem: () => new Promise<string | null>(() => {}),
    setItem: async () => {},
  };
}

describe("CONTROL: the boot race is real", () => {
  it("the synchronous read is false while the persisted value is true", async () => {
    const mod = load(storeHolding("true"));

    // This is exactly what `backend.ts` had at boot: a read that happens before
    // any await. It cannot see the persisted value.
    expect(mod.isDebugLoggingEnabledSync()).toBe(false);

    // POSITIVE CONTROL, same run: the value really is "true" in storage — the
    // false above is the race, not an empty store.
    await expect(mod.getDebugLogging()).resolves.toBe(true);
    expect(mod.isDebugLoggingEnabledSync()).toBe(true);
  });

  it("subscribeDebugLogging replays asynchronously on a cold cache", async () => {
    const mod = load(storeHolding("true"));
    const seen: boolean[] = [];
    mod.subscribeDebugLogging((v) => seen.push(v));
    // Nothing yet — this is why the effect at backend.ts could not have set the
    // ref before RPC_LISTEN went out.
    expect(seen).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([true]);
  });
});

describe("awaitDebugLogging is what the boot path uses", () => {
  it("resolves the persisted value, so the worklet is told the truth", async () => {
    const mod = load(storeHolding("true"));
    await expect(mod.awaitDebugLogging!(1000)).resolves.toBe(true);
  });

  it("resolves false for an unset flag", async () => {
    const mod = load(storeHolding(null));
    await expect(mod.awaitDebugLogging!(1000)).resolves.toBe(false);
  });

  it("does NOT hang the boot path when storage never answers", async () => {
    const mod = load(storeThatHangs());
    const started = Date.now();
    await expect(mod.awaitDebugLogging!(25)).resolves.toBe(false);
    // The point is that it returned at all. RPC_LISTEN must not be hostage to
    // AsyncStorage.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is synchronous-fast once the cache is warm", async () => {
    const mod = load(storeHolding("true"));
    await mod.getDebugLogging();
    // No timeout needed: a warm cache must not arm a timer at all.
    await expect(mod.awaitDebugLogging!(0)).resolves.toBe(true);
  });
});
