import {
  baseTransfer,
  deriveDirection,
  upsertTransfer,
  TRANSFERS_MAX,
} from "../transfers";
import type { TransferOrigin, TransferSummary } from "../types";

const DRIVE_A = "drive_a";
const DRIVE_B = "drive_b";

function resolver(map: Record<string, TransferOrigin>) {
  return (id: string): TransferOrigin => map[id] ?? "unknown";
}

describe("deriveDirection", () => {
  it("maps origin to direction", () => {
    expect(deriveDirection("hosted")).toBe("upload");
    expect(deriveDirection("received")).toBe("download");
    expect(deriveDirection("unknown")).toBe("unknown");
  });
});

describe("baseTransfer", () => {
  it("uses the provided origin and derived direction", () => {
    const t = baseTransfer(DRIVE_A, "hosted", 100);
    expect(t.driveId).toBe(DRIVE_A);
    expect(t.origin).toBe("hosted");
    expect(t.direction).toBe("upload");
    expect(t.percent).toBeNull();
    expect(t.totalBytes).toBeNull();
    expect(t.completed).toBe(false);
    expect(t.peerIds).toEqual([]);
    expect(t.lastEventAt).toBe(100);
  });
});

describe("upsertTransfer origin precedence", () => {
  it("stamps hosted origin on first insert", () => {
    const resolve = resolver({ [DRIVE_A]: "hosted" });
    const next = upsertTransfer([], DRIVE_A, { percent: 10 }, resolve);
    expect(next).toHaveLength(1);
    expect(next[0]?.origin).toBe("hosted");
    expect(next[0]?.direction).toBe("upload");
    expect(next[0]?.percent).toBe(10);
  });

  it("stamps received origin on first insert", () => {
    const resolve = resolver({ [DRIVE_A]: "received" });
    const next = upsertTransfer([], DRIVE_A, { percent: 5 }, resolve);
    expect(next[0]?.origin).toBe("received");
    expect(next[0]?.direction).toBe("download");
  });

  it("keeps unknown origin when nothing is known yet", () => {
    const resolve = resolver({});
    const next = upsertTransfer([], DRIVE_A, { percent: 1 }, resolve);
    expect(next[0]?.origin).toBe("unknown");
    expect(next[0]?.direction).toBe("unknown");
  });

  it("upgrades unknown origin once the resolver learns it", () => {
    const map: Record<string, TransferOrigin> = {};
    const resolve = (id: string): TransferOrigin => map[id] ?? "unknown";
    let state = upsertTransfer([], DRIVE_A, { percent: 1 }, resolve);
    expect(state[0]?.origin).toBe("unknown");
    map[DRIVE_A] = "hosted";
    state = upsertTransfer(state, DRIVE_A, { percent: 2 }, resolve);
    expect(state[0]?.origin).toBe("hosted");
    expect(state[0]?.direction).toBe("upload");
  });

  it("does not downgrade a known origin back to unknown", () => {
    const map: Record<string, TransferOrigin> = { [DRIVE_A]: "hosted" };
    const resolve = (id: string): TransferOrigin => map[id] ?? "unknown";
    let state = upsertTransfer([], DRIVE_A, { percent: 1 }, resolve);
    expect(state[0]?.origin).toBe("hosted");
    // The resolver "forgets" the drive (e.g. clearTransfer was called in between).
    delete map[DRIVE_A];
    state = upsertTransfer(state, DRIVE_A, { percent: 2 }, resolve);
    expect(state[0]?.origin).toBe("hosted");
  });

  it("re-asserts origin/direction after a function-form update", () => {
    const resolve = resolver({ [DRIVE_A]: "received" });
    let state = upsertTransfer([], DRIVE_A, { percent: 1 }, resolve);
    state = upsertTransfer(
      state,
      DRIVE_A,
      (prev) => ({ ...prev, origin: "unknown", direction: "unknown" }),
      resolve
    );
    // Caller tried to clobber origin; reducer refuses.
    expect(state[0]?.origin).toBe("received");
    expect(state[0]?.direction).toBe("download");
  });
});

describe("upsertTransfer peer dedup and disconnect cleanup", () => {
  const resolve = resolver({ [DRIVE_A]: "hosted" });

  it("adds a peer on connect and dedupes when it reconnects", () => {
    let state = upsertTransfer([], DRIVE_A, { percent: 1 }, resolve);
    state = upsertTransfer(
      state,
      DRIVE_A,
      (prev) => ({ ...prev, peerIds: [...prev.peerIds, "p1"], peersConnected: prev.peerIds.length + 1 }),
      resolve
    );
    state = upsertTransfer(
      state,
      DRIVE_A,
      (prev) =>
        prev.peerIds.includes("p1")
          ? prev
          : { ...prev, peerIds: [...prev.peerIds, "p1"], peersConnected: prev.peerIds.length + 1 },
      resolve
    );
    expect(state[0]?.peerIds).toEqual(["p1"]);
    expect(state[0]?.peersConnected).toBe(1);
  });

  it("removes the right peer on disconnect and decrements peersConnected", () => {
    let state: TransferSummary[] = [];
    state = upsertTransfer(
      state,
      DRIVE_A,
      (prev) => ({ ...prev, peerIds: ["p1", "p2", "p3"], peersConnected: 3 }),
      resolve
    );
    state = upsertTransfer(
      state,
      DRIVE_A,
      (prev) => {
        const peerIds = prev.peerIds.filter((id) => id !== "p2");
        return { ...prev, peerIds, peersConnected: peerIds.length };
      },
      resolve
    );
    expect(state[0]?.peerIds).toEqual(["p1", "p3"]);
    expect(state[0]?.peersConnected).toBe(2);
  });
});

describe("upsertTransfer completed flag semantics", () => {
  const resolve = resolver({ [DRIVE_A]: "hosted" });

  it("does not flip completed on progress updates", () => {
    let state = upsertTransfer([], DRIVE_A, { percent: 10 }, resolve);
    state = upsertTransfer(state, DRIVE_A, { percent: 100 }, resolve);
    expect(state[0]?.completed).toBe(false);
  });

  it("flips completed only on an explicit completion update", () => {
    let state = upsertTransfer([], DRIVE_A, { percent: 99 }, resolve);
    state = upsertTransfer(
      state,
      DRIVE_A,
      (prev) => ({ ...prev, percent: 100, completed: true }),
      resolve
    );
    expect(state[0]?.completed).toBe(true);
    expect(state[0]?.percent).toBe(100);
  });
});

describe("upsertTransfer array size cap", () => {
  const resolve = resolver({});
  it(`caps the array at ${TRANSFERS_MAX} entries, newest first`, () => {
    let state: TransferSummary[] = [];
    for (let i = 0; i < TRANSFERS_MAX + 5; i++) {
      state = upsertTransfer(state, `drive_${i}`, { percent: i }, resolve);
    }
    expect(state).toHaveLength(TRANSFERS_MAX);
    // Newest push (drive_84) should be at index 0.
    expect(state[0]?.driveId).toBe(`drive_${TRANSFERS_MAX + 4}`);
  });
});

describe("upsertTransfer guards", () => {
  const resolve = resolver({});
  it("returns the input unchanged for empty driveId", () => {
    const before: TransferSummary[] = [baseTransfer(DRIVE_B, "hosted")];
    const after = upsertTransfer(before, "", { percent: 99 }, resolve);
    expect(after).toBe(before);
  });
});
