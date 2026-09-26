/**
 * A received drive must never be announced at boot. The engine module cannot
 * load under jest, so this mirrors the hydration decision; the names below are
 * this file's invention and only the behaviour is the engine's. `ACTIVE` does
 * double duty on the receive path, covering a drive still being decided about,
 * one killed part-way and one re-activated to seed. Announcing all three seeds
 * head metadata with no file blobs, and a third peer then stalls per file.
 */

// --- Mirror of DriveState (backend/hyperdrive-engine.mjs) --- //

const CREATING = "creating";
const ACTIVE = "active";
const SEEKING = "seeking";
const INACTIVE = "inactive";
const STOPPED = "stopped";
const PURGED = "purged";

/** Mirror of `normalizeState` — the legacy alias, mapped at hydrate time. */
function normalizeState(s: string | undefined): string | undefined {
  if (s === STOPPED) return INACTIVE;
  return s;
}

type HydrateEntry = {
  driveId?: string;
  state?: string;
  origin?: string | null;
  key?: string | null;
  storagePath?: string | null;
  simulated?: boolean;
  localFiles?: unknown[];
};

/**
 * What hydration does with one manifest entry. `full-hydrate-no-swarm` opens
 * the corestore and registers the session, and skips only the announce. That
 * distinction is load-bearing: `engineStopDrive` early-returns
 * `drive-not-active` when `activeDrives` has no session, so light-hydrating
 * these entries stops Delete purging their storage.
 */
type HydratePlan =
  | "skip"
  | "light-hydrate"
  | "full-hydrate-no-swarm"
  | "full-hydrate-with-swarm";

function hydratePlan(entry: HydrateEntry | null | undefined): HydratePlan {
  if (!entry || typeof entry !== "object") return "skip";
  const s = normalizeState(entry.state);
  if (s !== ACTIVE && s !== INACTIVE) return "skip";
  if (entry.simulated) return "skip";
  if (!entry.key || !/^[a-fA-F0-9]{64}$/.test(String(entry.key))) return "skip";
  if (!entry.storagePath) return "skip";
  if (s === INACTIVE) return "light-hydrate";
  const isReceived = (entry.origin || "hosted") === "received";
  return isReceived ? "full-hydrate-no-swarm" : "full-hydrate-with-swarm";
}

const KEY =
  "b4f887e4a1c2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbcc";

function entry(over: Partial<HydrateEntry> = {}): HydrateEntry {
  return {
    driveId: "recv_1789837768922_zehwy4zs",
    state: ACTIVE,
    origin: "received",
    key: KEY,
    storagePath: "/data/peardrop/drives/recv_1789837768922_zehwy4zs",
    ...over,
  };
}

describe("hydration — the received-origin swarm rule (Sprint 9J A1)", () => {
  test("THE INVARIANT: an active received drive hydrates WITHOUT a swarm", () => {
    expect(hydratePlan(entry())).toBe("full-hydrate-no-swarm");
  });

  test("an active hosted drive still announces — the control", () => {
    // Without this, a rule that skipped the swarm for EVERYTHING would pass
    // the test above and break every share in the app.
    expect(hydratePlan(entry({ origin: "hosted", driveId: "drive_x" }))).toBe(
      "full-hydrate-with-swarm",
    );
  });

  test("a missing origin announces, matching the engine's hosted default", () => {
    expect(hydratePlan(entry({ origin: undefined }))).toBe(
      "full-hydrate-with-swarm",
    );
    expect(hydratePlan(entry({ origin: null }))).toBe(
      "full-hydrate-with-swarm",
    );
  });

  test("downloaded files do NOT re-enable the swarm, at any count", () => {
    // The narrower rule `isReceiving && localFiles.length === 0` misses the
    // case that matters most: a grab killed part-way has a non-empty
    // `localFiles` and is just as unable to serve the files it never fetched.
    // `localFiles` records files written to the download directory, which is
    // not the same thing as blocks present in the corestore.
    for (const localFiles of [[], [{}], [{}, {}], new Array(50).fill({})]) {
      expect(hydratePlan(entry({ localFiles }))).toBe("full-hydrate-no-swarm");
    }
  });
});

describe("hydration — the pre-existing rules A1 must not have disturbed", () => {
  test("inactive drives light-hydrate, both origins", () => {
    expect(hydratePlan(entry({ state: INACTIVE }))).toBe("light-hydrate");
    expect(hydratePlan(entry({ state: INACTIVE, origin: "hosted" }))).toBe(
      "light-hydrate",
    );
  });

  test("the legacy `stopped` alias normalizes to inactive", () => {
    expect(hydratePlan(entry({ state: STOPPED }))).toBe("light-hydrate");
  });

  test("in-flight and purged states are skipped", () => {
    expect(hydratePlan(entry({ state: CREATING }))).toBe("skip");
    expect(hydratePlan(entry({ state: SEEKING }))).toBe("skip");
    expect(hydratePlan(entry({ state: PURGED }))).toBe("skip");
  });

  test("simulated entries are skipped — never pruned, just inert", () => {
    // a simulated receive writes a real manifest entry so the
    // share-key index resolves it, but has no corestore behind it.
    expect(hydratePlan(entry({ simulated: true }))).toBe("skip");
    expect(hydratePlan(entry({ simulated: true, origin: "hosted" }))).toBe(
      "skip",
    );
  });

  test("a missing or malformed key is skipped", () => {
    expect(hydratePlan(entry({ key: undefined }))).toBe("skip");
    expect(hydratePlan(entry({ key: "" }))).toBe("skip");
    expect(hydratePlan(entry({ key: "not-hex" }))).toBe("skip");
    expect(hydratePlan(entry({ key: KEY.slice(0, 63) }))).toBe("skip");
    expect(hydratePlan(entry({ key: `${KEY}aa` }))).toBe("skip");
  });

  test("a missing storagePath is skipped", () => {
    expect(hydratePlan(entry({ storagePath: undefined }))).toBe("skip");
    expect(hydratePlan(entry({ storagePath: null }))).toBe("skip");
  });

  test("malformed entries are skipped rather than thrown on", () => {
    expect(hydratePlan(null)).toBe("skip");
    expect(hydratePlan(undefined)).toBe("skip");
    expect(hydratePlan({})).toBe("skip");
  });
});
