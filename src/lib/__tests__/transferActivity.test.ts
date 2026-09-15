import {
  IDLE_HOST_GRACE_MS,
  activeTransfers,
  classifyTransfer,
  describeActivity,
  isForcedTransferActive,
  isTransferActive,
  setForcedTransferActive,
  type TransferActivityInput,
} from "../transferActivity";

const NOW = 1_700_000_000_000;

function t(over: Partial<TransferActivityInput> = {}): TransferActivityInput {
  return {
    origin: "hosted",
    completed: false,
    stalled: false,
    peersConnected: 0,
    lastPeerLeftAt: null,
    ...over,
  };
}

describe("classifyTransfer", () => {
  it("counts a download in flight", () => {
    expect(classifyTransfer(t({ origin: "received" }), NOW)).toBe("download");
  });

  it("does not count a completed download", () => {
    expect(
      classifyTransfer(t({ origin: "received", completed: true }), NOW)
    ).toBeNull();
  });

  it("does not count a stalled download", () => {
    expect(
      classifyTransfer(t({ origin: "received", stalled: true }), NOW)
    ).toBeNull();
  });

  it("counts a hosted share with a peer connected", () => {
    expect(classifyTransfer(t({ peersConnected: 1 }), NOW)).toBe("upload");
  });

  /**
   * The RN watchdog sets `completed` on a hosted drive when its last peer
   * disconnects, so a drive serving its SECOND peer is `completed: true`
   * while bytes flow. Releasing the service there would freeze the process
   * mid-transfer.
   */
  it("counts a hosted share with a peer even when marked completed", () => {
    expect(
      classifyTransfer(t({ peersConnected: 2, completed: true }), NOW)
    ).toBe("upload");
  });

  it("does not count an idle hosted share that never had a peer", () => {
    expect(classifyTransfer(t(), NOW)).toBeNull();
  });

  it("counts an idle hosted share inside the grace window", () => {
    const justLeft = t({ lastPeerLeftAt: NOW - 60_000 });
    expect(classifyTransfer(justLeft, NOW)).toBe("idle-host-grace");
  });

  it("stops counting once the grace window elapses", () => {
    const longGone = t({ lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS - 1 });
    expect(classifyTransfer(longGone, NOW)).toBeNull();
  });

  it("treats the grace boundary as exclusive", () => {
    const exactly = t({ lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS });
    expect(classifyTransfer(exactly, NOW)).toBeNull();
  });

  /** Clock skew must not open an unbounded window. */
  it("ignores a lastPeerLeftAt in the future", () => {
    expect(classifyTransfer(t({ lastPeerLeftAt: NOW + 5_000 }), NOW)).toBeNull();
  });

  it("counts an unresolved-origin transfer only when it has peers", () => {
    expect(classifyTransfer(t({ origin: "unknown", peersConnected: 1 }), NOW)).toBe(
      "upload"
    );
    expect(classifyTransfer(t({ origin: "unknown" }), NOW)).toBeNull();
  });
});

describe("isTransferActive", () => {
  it("is false for an empty list", () => {
    expect(isTransferActive([], NOW)).toBe(false);
  });

  it("is false when every transfer is idle or finished", () => {
    const list = [
      t({ origin: "received", completed: true }),
      t(),
      t({ origin: "received", stalled: true }),
    ];
    expect(isTransferActive(list, NOW)).toBe(false);
  });

  it("is true when any single transfer is active", () => {
    const list = [
      t({ origin: "received", completed: true }),
      t({ peersConnected: 1 }),
      t(),
    ];
    expect(isTransferActive(list, NOW)).toBe(true);
  });
});

describe("activeTransfers / describeActivity", () => {
  it("reports each active transfer with its reason", () => {
    const list = [
      t({ origin: "received" }),
      t({ peersConnected: 3 }),
      t({ lastPeerLeftAt: NOW - 1000 }),
      t({ origin: "received", completed: true }),
    ];
    expect(activeTransfers(list, NOW)).toEqual([
      { index: 0, reason: "download" },
      { index: 1, reason: "upload" },
      { index: 2, reason: "idle-host-grace" },
    ]);
  });

  it("summarises an inactive set", () => {
    expect(describeActivity([t(), t()], NOW)).toBe(
      "active=false transfers=2"
    );
  });

  it("summarises an active set by reason", () => {
    const list = [
      t({ origin: "received" }),
      t({ origin: "received" }),
      t({ peersConnected: 1 }),
    ];
    expect(describeActivity(list, NOW)).toBe(
      "active=true transfers=3 download=2 upload=1"
    );
  });
});

// ---------------------------------------------------------------------
// the forced-active override.
//
// A test instrument, and the tests below are mostly about it staying one —
// unreachable in release, invisible to real inputs when off, and always
// announced in the log when on.
// ---------------------------------------------------------------------

describe("forced-active override", () => {
  // Module-level state: reset after every case, or one test arms the next.
  afterEach(() => setForcedTransferActive(false, true));

  test("is off by default", () => {
    expect(isForcedTransferActive()).toBe(false);
    expect(isTransferActive([], NOW)).toBe(false);
  });

  test("makes the predicate true with an empty transfer list", () => {
    setForcedTransferActive(true, true);
    expect(isForcedTransferActive()).toBe(true);
    expect(isTransferActive([], NOW)).toBe(true);
  });

  test("is ignored when the debug gate is off", () => {
    setForcedTransferActive(true, false);
    expect(isForcedTransferActive()).toBe(false);
    expect(isTransferActive([], NOW)).toBe(false);
  });

  test("a release build cannot inherit a forced state set earlier", () => {
    // Belt and braces: even if something armed it, passing a false gate
    // clears it rather than leaving it alone.
    setForcedTransferActive(true, true);
    expect(isForcedTransferActive()).toBe(true);
    setForcedTransferActive(true, false);
    expect(isForcedTransferActive()).toBe(false);
  });

  test("does not alter the answer for any real input while off", () => {
    const cases: TransferActivityInput[][] = [
      [],
      [t()],
      [t({ origin: "received" })],
      [t({ peersConnected: 2 })],
      [t({ lastPeerLeftAt: NOW - 1_000 })],
      [t({ origin: "received", completed: true }), t()],
    ];
    const before = cases.map((c) => isTransferActive(c, NOW));
    setForcedTransferActive(false, true);
    const after = cases.map((c) => isTransferActive(c, NOW));
    expect(after).toEqual(before);
    // And the real classifications are untouched.
    expect(classifyTransfer(t({ peersConnected: 1 }), NOW)).toBe("upload");
    expect(classifyTransfer(t(), NOW)).toBeNull();
  });

  test("the decision log announces a forced run", () => {
    setForcedTransferActive(true, true);
    expect(describeActivity([], NOW)).toBe("forced=true active=true transfers=0");
  });

  test("a forced run over a live list reports both facts", () => {
    // The honest description: forced, AND what was really there. A reader
    // must be able to tell a forced run from an upload-sustained one.
    setForcedTransferActive(true, true);
    expect(describeActivity([t({ peersConnected: 1 })], NOW)).toBe(
      "forced=true active=true transfers=1 upload=1"
    );
  });

  test("an unforced run says nothing about forcing", () => {
    expect(describeActivity([t({ peersConnected: 1 })], NOW)).toBe(
      "active=true transfers=1 upload=1"
    );
    expect(describeActivity([], NOW)).toBe("active=false transfers=0");
  });

  test("upload and idle-host-grace remain distinguishable in the log", () => {
    // The distinction the protocol tells operators to check. A grace-window
    // run and an upload-sustained one must never read the same.
    expect(describeActivity([t({ peersConnected: 1 })], NOW)).toContain("upload=1");
    expect(describeActivity([t({ lastPeerLeftAt: NOW - 1_000 })], NOW)).toContain(
      "idle-host-grace=1"
    );
  });
});
