import { runGuardedResolve, type ResolveGenRef } from "../resolveGuard";
import type { OpenLinkResult } from "../types";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCallbacks() {
  return {
    onBegin: jest.fn(),
    onSuccess: jest.fn<void, [OpenLinkResult]>(),
    onFailure: jest.fn<void, [string]>(),
    onTimeout: jest.fn(),
    onFinally: jest.fn(),
  };
}

describe("runGuardedResolve generation guard", () => {
  it("ignores the first call's result when a second resolve has started", async () => {
    const gen: ResolveGenRef = { current: 0 };
    const first = deferred<OpenLinkResult>();
    const second = deferred<OpenLinkResult>();
    const abortOpen = jest.fn(async () => {});

    const cbs1 = makeCallbacks();
    const cbs2 = makeCallbacks();

    const run1 = runGuardedResolve("peardrop://aaa", gen, {
      openLink: async () => first.promise,
      abortOpen,
      ...cbs1,
      timeoutMs: 60000,
    });
    // Yield so run1 has bumped gen and registered its onBegin.
    await Promise.resolve();
    expect(cbs1.onBegin).toHaveBeenCalledTimes(1);
    expect(gen.current).toBe(1);

    const run2 = runGuardedResolve("peardrop://bbb", gen, {
      openLink: async () => second.promise,
      abortOpen,
      ...cbs2,
      timeoutMs: 60000,
    });
    await Promise.resolve();
    expect(cbs2.onBegin).toHaveBeenCalledTimes(1);
    expect(gen.current).toBe(2);

    // Resolve the older call first. Its callbacks must NOT fire — it lost.
    first.resolve({ ok: true, driveId: "drive_a", files: [], hasManifest: true });
    await run1;
    expect(cbs1.onSuccess).not.toHaveBeenCalled();
    expect(cbs1.onFailure).not.toHaveBeenCalled();
    expect(cbs1.onFinally).not.toHaveBeenCalled();

    // Resolve the newer call. Its callbacks DO fire.
    second.resolve({ ok: true, driveId: "drive_b", files: [], hasManifest: true });
    await run2;
    expect(cbs2.onSuccess).toHaveBeenCalledTimes(1);
    expect(cbs2.onSuccess.mock.calls[0]?.[0]?.driveId).toBe("drive_b");
    expect(cbs2.onFinally).toHaveBeenCalledTimes(1);
  });

  it("routes onSuccess when openLink resolves with ok:true", async () => {
    const gen: ResolveGenRef = { current: 0 };
    const cbs = makeCallbacks();
    await runGuardedResolve("peardrop://ok", gen, {
      openLink: async () => ({ ok: true, driveId: "d1", files: [], hasManifest: true }),
      abortOpen: async () => {},
      ...cbs,
    });
    expect(cbs.onSuccess).toHaveBeenCalledTimes(1);
    expect(cbs.onFailure).not.toHaveBeenCalled();
    expect(cbs.onTimeout).not.toHaveBeenCalled();
    expect(cbs.onFinally).toHaveBeenCalledTimes(1);
  });

  it("routes onFailure when openLink returns ok:false", async () => {
    const gen: ResolveGenRef = { current: 0 };
    const cbs = makeCallbacks();
    await runGuardedResolve("peardrop://bad", gen, {
      openLink: async () => ({ ok: false, error: "no peers", hasManifest: false }),
      abortOpen: async () => {},
      ...cbs,
    });
    expect(cbs.onFailure).toHaveBeenCalledWith("no peers");
    expect(cbs.onSuccess).not.toHaveBeenCalled();
    expect(cbs.onFinally).toHaveBeenCalledTimes(1);
  });

  it("fires onTimeout when the race times out", async () => {
    jest.useFakeTimers();
    try {
      const gen: ResolveGenRef = { current: 0 };
      const cbs = makeCallbacks();
      const abortOpen = jest.fn(async () => {});
      const never = new Promise<OpenLinkResult>(() => {});
      const p = runGuardedResolve("peardrop://slow", gen, {
        openLink: async () => never,
        abortOpen,
        ...cbs,
        timeoutMs: 100,
      });
      // Flush microtasks so the race kicks off.
      await Promise.resolve();
      jest.advanceTimersByTime(100);
      await p;
      expect(cbs.onTimeout).toHaveBeenCalledTimes(1);
      expect(cbs.onFailure).not.toHaveBeenCalled();
      expect(cbs.onSuccess).not.toHaveBeenCalled();
      expect(cbs.onFinally).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // the generic-exception path used to pass raw exception
  // text straight to onFailure — unbounded, so the linkError surface truncated
  // it with "…". Raw text now goes only to the debug log; onFailure gets the
  // bounded fallback via `userFacingError`.
  it("never passes raw exception text to onFailure — bounded fallback only", async () => {
    const gen: ResolveGenRef = { current: 0 };
    const cbs = makeCallbacks();
    const logs: string[] = [];
    const raw =
      "Error: ENOENT no such file or directory, open '/data/user/0/com.anjouinc.peardrop/files/some/very/deep/path/that/goes/on/and/on/and/on/manifest.json'";
    await runGuardedResolve("peardrop://boom", gen, {
      openLink: async () => {
        throw new Error(raw);
      },
      abortOpen: async () => {},
      onLog: (_level, msg) => logs.push(msg),
      ...cbs,
    });
    expect(cbs.onFailure).toHaveBeenCalledTimes(1);
    const shown = cbs.onFailure.mock.calls[0]?.[0] ?? "";
    expect(shown).toBe("Could not open link.");
    expect(shown).not.toContain(raw);
    expect(shown.length).toBeLessThanOrEqual(100);
    // The raw text is not discarded — it still reaches the debug log.
    expect(logs.some((m) => m.includes(raw))).toBe(true);
  });

  it("calls abortOpen before incrementing state callbacks", async () => {
    const gen: ResolveGenRef = { current: 0 };
    const calls: string[] = [];
    const abortOpen = jest.fn(async () => {
      calls.push("abort");
    });
    const cbs = {
      onBegin: jest.fn(() => calls.push("begin")),
      onSuccess: jest.fn(() => calls.push("success")),
      onFailure: jest.fn(),
      onTimeout: jest.fn(),
      onFinally: jest.fn(() => calls.push("finally")),
    };
    await runGuardedResolve("peardrop://x", gen, {
      openLink: async () => ({ ok: true, driveId: "d", files: [], hasManifest: true }),
      abortOpen,
      ...cbs,
    });
    expect(calls).toEqual(["abort", "begin", "success", "finally"]);
  });
});
