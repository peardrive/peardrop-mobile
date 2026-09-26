import {
  IDLE_HOST_GRACE_MS,
  activeTransfers,
  classifyTransfer,
  decideServiceTransition,
  describeActivity,
  isForcedTransferActive,
  isTransferActive,
  nextLastPeerLeftAt,
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

  /**
   * `stalled` is the RN watchdog's 30-second verdict, taken against the
   * engine's 60-second per-file wait, so it would declare a download dead
   * with half the engine's patience left. The download branch asks the
   * watchdog nothing; what releases a download is engine evidence.
   */
  it("does not consult the RN stall watchdog on the download branch", () => {
    expect(classifyTransfer(t({ origin: "received", stalled: true }), NOW)).toBe(
      "download"
    );
    // The answer is identical with the flag off: it is not read at all.
    expect(
      classifyTransfer(t({ origin: "received", stalled: false }), NOW)
    ).toBe("download");
  });

  /**
   * `download-peer-disconnected` writes `peersConnected: 0` and
   * stamps `lastPeerLeftAt`, and the old branch read neither — the sender
   * going away changed nothing the predicate could see.
   */
  it("releases a download whose sender left and did not come back", () => {
    const flowed = { origin: "received", progressEverReceived: true } as const;
    expect(
      classifyTransfer(t({ ...flowed, lastPeerLeftAt: NOW - 1_000 }), NOW)
    ).toBe("download");
    expect(
      classifyTransfer(
        t({ ...flowed, lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS }),
        NOW
      )
    ).toBeNull();
  });

  /**
   * `progressEverReceived` starts `false` and has one writer, so it is
   * `false` for the whole pre-first-block phase of every download, including
   * a healthy one whose sender dropped a socket and is about to re-attach. A
   * departure releases on the same clock as every other, never instantly.
   */
  it("holds a pre-first-block download for the normal grace, never instantly", () => {
    const noBytes = { origin: "received", progressEverReceived: false } as const;
    expect(
      classifyTransfer(t({ ...noBytes, lastPeerLeftAt: NOW - 1 }), NOW)
    ).toBe("download");
    expect(
      classifyTransfer(
        t({ ...noBytes, lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS + 1 }),
        NOW
      )
    ).toBe("download");
    // The same boundary the flowed case gets, and no other.
    expect(
      classifyTransfer(
        t({ ...noBytes, lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS }),
        NOW
      )
    ).toBeNull();
  });

  /**
   * The sender is attached right now and has sent nothing yet: the opening
   * seconds of every download. `peersConnected > 0` is engine-observed, and
   * it must outrank every "looks finished" signal, a stale departure stamp
   * included.
   */
  it("holds a download whose sender is attached but has sent no block yet", () => {
    expect(
      classifyTransfer(
        t({ origin: "received", peersConnected: 1, progressEverReceived: false }),
        NOW
      )
    ).toBe("download");
    // Even with a departure stamped long ago: someone is attached now.
    expect(
      classifyTransfer(
        t({
          origin: "received",
          peersConnected: 1,
          progressEverReceived: false,
          lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS * 2,
        }),
        NOW
      )
    ).toBe("download");
  });

  it("holds a download that has not connected yet", () => {
    // No departure has ever been observed, so there is no evidence of an
    // ending — the pre-connect window of a grab that has just started.
    expect(
      classifyTransfer(
        t({ origin: "received", progressEverReceived: false, lastPeerLeftAt: null }),
        NOW
      )
    ).toBe("download");
  });

  it("holds a download whose lastPeerLeftAt is in the future", () => {
    // A clock that moved is not a transfer that ended. This branch fails
    // towards holding; the hosted branch fails the other way, deliberately.
    expect(
      classifyTransfer(
        t({
          origin: "received",
          progressEverReceived: false,
          lastPeerLeftAt: NOW + 5_000,
        }),
        NOW
      )
    ).toBe("download");
  });

  /**
   * `progressEverReceived` is not read on this branch at all, so its three
   * spellings must be indistinguishable. Stated as a positive control: if any
   * of them ever diverge, a no-bytes shortcut has been added.
   */
  it("does not consult progressEverReceived on the download branch", () => {
    for (const progressEverReceived of [true, false, undefined]) {
      expect(
        classifyTransfer(
          t({ origin: "received", progressEverReceived, lastPeerLeftAt: NOW - 1 }),
          NOW
        )
      ).toBe("download");
      expect(
        classifyTransfer(
          t({
            origin: "received",
            progressEverReceived,
            lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS,
          }),
          NOW
        )
      ).toBeNull();
    }
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

/**
 * `nextLastPeerLeftAt` is the single writer of `lastPeerLeftAt`, so a
 * departure stamp cannot outlive its departure. That the `peer-connected`,
 * `peer-disconnected` and `download-peer-disconnected` handlers all delegate
 * to it is not provable here: `backend.ts` imports react-native.
 */
describe("nextLastPeerLeftAt — D-11 F1 behaviour 2", () => {
  const AT = NOW;
  const OLD = NOW - 5_000;

  /** Positive control for the extraction. */
  it("stamps when the last peer leaves", () => {
    expect(
      nextLastPeerLeftAt({
        prevPeersConnected: 1,
        prevPeerIdCount: 1,
        nextPeersConnected: 0,
        prevLastPeerLeftAt: null,
        at: AT,
      })
    ).toBe(AT);
  });

  /**
   * The `download-peer-disconnected` handler zeroes `peerIds` and
   * `peersConnected` together, and it arrives AFTER the `peer-disconnected`
   * for the same socket close (`hyperdrive-engine.mjs:2107-2108` emits both).
   * The second event must not restart the window the first one opened.
   */
  it("does not restamp a departure already recorded", () => {
    expect(
      nextLastPeerLeftAt({
        prevPeersConnected: 0,
        prevPeerIdCount: 0,
        nextPeersConnected: 0,
        prevLastPeerLeftAt: OLD,
        at: AT,
      })
    ).toBe(OLD);
  });

  /** Nothing has ever left, so there is nothing to say. */
  it("leaves an unstamped record unstamped when no peer ever left", () => {
    expect(
      nextLastPeerLeftAt({
        prevPeersConnected: 0,
        prevPeerIdCount: 0,
        nextPeersConnected: 0,
        prevLastPeerLeftAt: null,
        at: AT,
      })
    ).toBeNull();
  });

  /**
   * THE DEFECT. The sender dropped, was stamped, and has re-attached. Leaving
   * the stamp in place records a peer who came back as one who left, and it
   * keeps ageing towards `IDLE_HOST_GRACE_MS` while bytes are flowing.
   */
  it("clears the stamp when a peer connects", () => {
    expect(
      nextLastPeerLeftAt({
        prevPeersConnected: 0,
        prevPeerIdCount: 0,
        nextPeersConnected: 1,
        prevLastPeerLeftAt: OLD,
        at: AT,
      })
    ).toBeNull();
  });

  /**
   * Two peers becoming one is not the last peer leaving — 8A's reason for the
   * falling-edge rule. It is also not a departure to time: one is still
   * attached, so any stamp is stale for the same reason as above.
   */
  it("clears the stamp while any peer is still attached", () => {
    expect(
      nextLastPeerLeftAt({
        prevPeersConnected: 2,
        prevPeerIdCount: 2,
        nextPeersConnected: 1,
        prevLastPeerLeftAt: OLD,
        at: AT,
      })
    ).toBeNull();
  });

  /**
   * The sequence the ruling names, end to end, through the real predicate:
   * connect (no block yet) → drop → reconnect → drop again. The second window
   * must be timed from the SECOND departure. With the stamp left stale, a
   * reconnect that lasted longer than the grace would be released by the first
   * departure's clock the instant the sender dropped again.
   */
  it("times the second window from the second departure, not the first", () => {
    const firstDrop = NOW;
    const reconnect = firstDrop + 60_000;
    const secondDrop = reconnect + IDLE_HOST_GRACE_MS + 60_000;

    const afterFirstDrop = nextLastPeerLeftAt({
      prevPeersConnected: 1,
      prevPeerIdCount: 1,
      nextPeersConnected: 0,
      prevLastPeerLeftAt: null,
      at: firstDrop,
    });
    expect(afterFirstDrop).toBe(firstDrop);

    const afterReconnect = nextLastPeerLeftAt({
      prevPeersConnected: 0,
      prevPeerIdCount: 0,
      nextPeersConnected: 1,
      prevLastPeerLeftAt: afterFirstDrop,
      at: reconnect,
    });
    expect(afterReconnect).toBeNull();

    // While attached with no stamp and no bytes, the predicate holds.
    expect(
      classifyTransfer(
        t({
          origin: "received",
          peersConnected: 1,
          progressEverReceived: false,
          lastPeerLeftAt: afterReconnect,
        }),
        secondDrop - 1
      )
    ).toBe("download");

    const afterSecondDrop = nextLastPeerLeftAt({
      prevPeersConnected: 1,
      prevPeerIdCount: 1,
      nextPeersConnected: 0,
      prevLastPeerLeftAt: afterReconnect,
      at: secondDrop,
    });
    expect(afterSecondDrop).toBe(secondDrop);

    // A full fresh grace window, timed from the second departure.
    const held = t({
      origin: "received",
      peersConnected: 0,
      progressEverReceived: false,
      lastPeerLeftAt: afterSecondDrop,
    });
    expect(classifyTransfer(held, secondDrop + IDLE_HOST_GRACE_MS - 1)).toBe(
      "download"
    );
    expect(
      classifyTransfer(held, secondDrop + IDLE_HOST_GRACE_MS)
    ).toBeNull();
  });
});

describe("isTransferActive", () => {
  it("is false for an empty list", () => {
    expect(isTransferActive([], NOW)).toBe(false);
  });

  /**
   * The third element is the shape that is finished on the evidence: a sender
   * that connected and left, with the grace window fully elapsed. A departure
   * one millisecond ago releases nothing, whatever `progressEverReceived`
   * says.
   */
  it("is false when every transfer is idle or finished", () => {
    const list = [
      t({ origin: "received", completed: true }),
      t(),
      t({
        origin: "received",
        progressEverReceived: false,
        lastPeerLeftAt: NOW - IDLE_HOST_GRACE_MS,
      }),
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

/**
 * `applyServiceForBackground` had ONE production call
 * site — the AppState background transition — and the effect on the other
 * side could only stop, so a transfer that BEGAN while the app was already
 * backgrounded ran with no service and no notification.
 *
 * These are the two halves of one pair, which is why they are one function.
 */
describe("decideServiceTransition — D-11 F7", () => {
  beforeEach(() => setForcedTransferActive(false, true));

  const live = t({ origin: "received" });
  const done = t({ origin: "received", completed: true });

  it("starts for a transfer that begins while already backgrounded", () => {
    expect(
      decideServiceTransition({
        appActive: false,
        serviceStartedForWindow: false,
        transfers: [live],
        now: NOW,
      })
    ).toBe("start");
  });

  it("does not start twice in the same window", () => {
    expect(
      decideServiceTransition({
        appActive: false,
        serviceStartedForWindow: true,
        transfers: [live],
        now: NOW,
      })
    ).toBe("none");
  });

  it("stops when the last transfer in a served window finishes", () => {
    expect(
      decideServiceTransition({
        appActive: false,
        serviceStartedForWindow: true,
        transfers: [done],
        now: NOW,
      })
    ).toBe("stop");
  });

  it("has nothing to release in a window it never served", () => {
    expect(
      decideServiceTransition({
        appActive: false,
        serviceStartedForWindow: false,
        transfers: [done],
        now: NOW,
      })
    ).toBe("none");
  });

  /**
   * The resume handler stops the service unconditionally and owns that
   * decision. Answering "stop" here too would emit one per foreground
   * transfer change.
   */
  it("says nothing at all while the app is in the foreground", () => {
    for (const started of [true, false]) {
      for (const list of [[live], [done], []]) {
        expect(
          decideServiceTransition({
            appActive: true,
            serviceStartedForWindow: started,
            transfers: list,
            now: NOW,
          })
        ).toBe("none");
      }
    }
  });

  it("reads the same predicate the release path does, override included", () => {
    setForcedTransferActive(true, true);
    expect(
      decideServiceTransition({
        appActive: false,
        serviceStartedForWindow: false,
        transfers: [],
        now: NOW,
      })
    ).toBe("start");
    setForcedTransferActive(false, true);
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

// =====================================================================
// Characterisation of the predicate as it behaves today.
//
// It calls `classifyTransfer` / `isTransferActive` / `describeActivity`
// directly and re-implements nothing: a green mirror over a broken predicate
// reads as evidence.
//
// It pins the predicate only. `applyServiceForBackground` in
// `src/state/backend.ts` is what turns an active predicate into a running
// foreground service, and that file imports react-native, so it is
// unreachable here. Passing means the predicate still says "active"; it says
// nothing about whether the service survives a screen lock, which stays a
// device measurement.
//
// 1. There is no `cancelled` field. A cancel is expressed as a shape —
//    `completed:true, peersConnected:0, lastPeerLeftAt:null` — written by
//    `markCancelled` and pinned in `cancelActivity.test.ts`.
// 2. There is no progress field. What stands in for it is
//    `origin:"received" && !completed && !stalled` for a download, and
//    `peersConnected > 0` for an upload.
// =====================================================================

describe("CHARACTERISATION: a live transfer holds the service", () => {
  // The module-level override would make every assertion below vacuously
  // true. Prove it is off before pinning anything.
  beforeEach(() => setForcedTransferActive(false, true));

  test("precondition: the forced-active instrument is off", () => {
    expect(isForcedTransferActive()).toBe(false);
  });

  /**
   * A download with bytes in flight. `completed:false`, `stalled:false` is
   * everything the predicate can see of "in flight"; there is no progress
   * field (see note 2 above).
   */
  test("a download in flight is active, so the service is held", () => {
    const inFlight = t({ origin: "received", completed: false, stalled: false });
    expect(classifyTransfer(inFlight, NOW)).toBe("download");
    expect(isTransferActive([inFlight], NOW)).toBe(true);
    // The line an exported log will carry for that window.
    expect(describeActivity([inFlight], NOW)).toBe(
      "active=true transfers=1 download=1"
    );
  });

  /**
   * The peer-drop case, stated as the failure it prevents. A receiver whose
   * sender momentarily drops is still mid-download; releasing the service
   * there lets the OS freeze the process in the gap, which is the exact
   * failure `IDLE_HOST_GRACE_MS` exists for on the other side.
   */
  test("a download stays active with peersConnected: 0", () => {
    const noPeers = t({ origin: "received", peersConnected: 0 });
    expect(classifyTransfer(noPeers, NOW)).toBe("download");
    expect(isTransferActive([noPeers], NOW)).toBe(true);
    // peersConnected is not consulted at all on the download branch: the
    // answer is identical at 0 and at 3.
    expect(classifyTransfer(t({ origin: "received", peersConnected: 3 }), NOW)).toBe(
      "download"
    );
  });

  /**
   * TRIPWIRE (`.claude/rules/measurement.md`, "the peer-event tripwire").
   *
   * `completed` is NOT terminal on a hosted drive: the RN watchdog sets it
   * when the last peer disconnects, so a drive that served one peer and is
   * now serving a second is `completed:true` WHILE BYTES FLOW. The peer
   * check at `transferActivity.ts:168-170` therefore runs BEFORE any
   * `completed` check, on purpose.
   *
   * If this test starts failing, the CONTRACT broke, not the test. Do not
   * adjust the expectation to match a new predicate.
   */
  test("TRIPWIRE: a hosted share with a peer is active even when completed", () => {
    const secondPeer = t({ origin: "hosted", completed: true, peersConnected: 1 });
    expect(classifyTransfer(secondPeer, NOW)).toBe("upload");
    expect(isTransferActive([secondPeer], NOW)).toBe(true);
    // The same holds for an unresolved origin — the peer check covers both
    // "hosted" and "unknown" before anything else is consulted.
    expect(
      classifyTransfer(t({ origin: "unknown", completed: true, peersConnected: 1 }), NOW)
    ).toBe("upload");
  });

  test("a completed download does not hold the service", () => {
    const done = t({ origin: "received", completed: true });
    expect(classifyTransfer(done, NOW)).toBeNull();
    expect(isTransferActive([done], NOW)).toBe(false);
    expect(describeActivity([done], NOW)).toBe("active=false transfers=1");
  });

  /**
   * The cancel shape. There is no `cancelled` field (note 1 above) — a
   * cancel reaches this module as the shape `markCancelled` writes. Pinned
   * here is only that the shape releases the service on both origins, so an
   * edit that reorders the branches cannot quietly re-hold it.
   */
  test("a cancelled transfer does not hold the service", () => {
    const cancelledReceived = t({
      origin: "received",
      completed: true,
      peersConnected: 0,
      lastPeerLeftAt: null,
    });
    const cancelledHosted = t({
      origin: "hosted",
      completed: true,
      peersConnected: 0,
      lastPeerLeftAt: null,
    });
    expect(classifyTransfer(cancelledReceived, NOW)).toBeNull();
    expect(classifyTransfer(cancelledHosted, NOW)).toBeNull();
    expect(isTransferActive([cancelledReceived, cancelledHosted], NOW)).toBe(false);
  });

  /**
   * The composite the service actually sees. One live transfer among
   * finished ones must still hold it: `isTransferActive` is an `any`, and
   * turning it into an "every" would break nothing above.
   */
  test("one live transfer among finished ones still holds the service", () => {
    const list = [
      t({ origin: "received", completed: true }),
      t({ origin: "hosted", completed: true, peersConnected: 0, lastPeerLeftAt: null }),
      t({ origin: "received" }), // the live one, last in the list
    ];
    expect(isTransferActive(list, NOW)).toBe(true);
    expect(activeTransfers(list, NOW)).toEqual([{ index: 2, reason: "download" }]);
    expect(describeActivity(list, NOW)).toBe("active=true transfers=3 download=1");
  });
});
