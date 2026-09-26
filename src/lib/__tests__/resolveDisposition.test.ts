import {
  disposeResolve,
  RESOLVE_NO_MANIFEST_MESSAGE,
} from "../resolveDisposition";

/**
 * `resolveOutcome.test.ts` pins what the verdict is; this file pins when the
 * write happens. An `onSuccess` that awaits `reconcileAndDedup` — and
 * therefore `upsertShare` — before the guard runs puts the row on disk before
 * anything decides it should not exist.
 *
 * Every assertion below is about call order or about a call not happening.
 * Neither is expressible as a property of the return value, which is why this
 * is a separate suite.
 */

/** Records the order the injected effects fire in. */
function harness() {
  const calls: string[] = [];
  return {
    calls,
    persist: jest.fn(async () => {
      calls.push("persist");
      return { row: 1 };
    }),
    accept: jest.fn((p: { row: number }) => {
      calls.push(`accept:${p.row}`);
    }),
    reject: jest.fn((v: string) => {
      calls.push(`reject:${v}`);
    }),
  };
}

describe("disposeResolve — the persist ordering", () => {
  it("NEVER persists a resolve whose manifest did not replicate", async () => {
    // `files` is populated — by the engine's drive.list() fallback — and the
    // manifest never arrived. Persisting this is what leaves a row the user
    // then sees forever.
    const h = harness();
    const verdict = await disposeResolve(
      { hasManifest: false, files: [{ name: "/a.bin" }] },
      h,
    );
    expect(verdict).toBe("no-manifest");
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.reject).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(["reject:no-manifest"]);
  });

  it("NEVER persists when hasManifest is absent — the optional-field trap", async () => {
    const h = harness();
    await disposeResolve({ files: [] }, h);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["reject:no-manifest"]);
  });

  it("NEVER persists a null or undefined reply", async () => {
    const h1 = harness();
    await disposeResolve(null, h1);
    expect(h1.persist).not.toHaveBeenCalled();

    const h2 = harness();
    await disposeResolve(undefined, h2);
    expect(h2.persist).not.toHaveBeenCalled();
  });

  it("DOES persist a manifest that legitimately declares zero files", async () => {
    // The destructive direction, and the reason the predicate may not be
    // `files.length`: a share that really holds nothing still resolved, and
    // must still be recorded and shown.
    const h = harness();
    const verdict = await disposeResolve({ hasManifest: true, files: [] }, h);
    expect(verdict).toBe("usable");
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.reject).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["persist", "accept:1"]);
  });

  it("persists BEFORE it accepts, and hands the persisted record on", async () => {
    const h = harness();
    await disposeResolve({ hasManifest: true, files: [{ name: "/a.bin" }] }, h);
    // Order, not just occurrence: `accept` reads the record `persist` wrote.
    expect(h.calls).toEqual(["persist", "accept:1"]);
    expect(h.accept).toHaveBeenCalledWith({ row: 1 });
  });

  it("does not accept when persist throws", async () => {
    // A half-written record must not open a preview that implies it landed.
    const calls: string[] = [];
    const accept = jest.fn(() => {
      calls.push("accept");
    });
    await expect(
      disposeResolve(
        { hasManifest: true },
        {
          persist: async () => {
            calls.push("persist");
            throw new Error("disk full");
          },
          accept,
          reject: jest.fn(),
        },
      ),
    ).rejects.toThrow("disk full");
    expect(accept).not.toHaveBeenCalled();
    expect(calls).toEqual(["persist"]);
  });

  it("awaits an async reject before returning", async () => {
    // The rejection route fires a purge and sets error copy; a caller that
    // returns before those are dispatched would race the next paste.
    const calls: string[] = [];
    await disposeResolve(
      { hasManifest: false },
      {
        persist: async () => {
          calls.push("persist");
          return null;
        },
        accept: () => {
          calls.push("accept");
        },
        reject: async () => {
          await Promise.resolve();
          calls.push("reject");
        },
      },
    );
    expect(calls).toEqual(["reject"]);
  });
});

describe("the rejection copy obeys the same deny-list as the hint copy", () => {
  it("has copy to check", () => {
    // Positive control: an empty or absent string would make every assertion
    // below vacuously true, which is the failure mode `evidence.md` calls out.
    expect(typeof RESOLVE_NO_MANIFEST_MESSAGE).toBe("string");
    expect(RESOLVE_NO_MANIFEST_MESSAGE.length).toBeGreaterThan(20);
  });

  it("never points the user at a network the app has never looked at", () => {
    // No connectivity detection exists anywhere in PearDrop, and the app
    // cannot tell "the host is offline" from "DHT discovery is still
    // running", so it must claim neither.
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/check your/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/wi-?fi/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/internet/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/mobile data/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/\bnetwork\b/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/\boffline\b/i);
  });

  it("never says or implies a link expires", () => {
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/expir/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/no longer valid/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/timed? out/i);
  });

  it("makes no claim about how many files the share holds", () => {
    // The predicate does not key on file count, so the copy may not assert
    // one: a share rejected here can hold any number of unread files.
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/\bno files\b/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/any files/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/\bempty\b/i);
    expect(RESOLVE_NO_MANIFEST_MESSAGE).not.toMatch(/\b0 files\b/i);
  });
});
