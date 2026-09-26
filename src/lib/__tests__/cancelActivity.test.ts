/**
 * A cancelled transfer must release the foreground service through
 * `transferActivity.ts`'s existing branches, never through a new cancelled
 * branch in the predicate, so cancelling has to produce a shape
 * `classifyTransfer` already returns null for. The field that matters is
 * `lastPeerLeftAt: null`: a hosted transfer with a non-null value takes the
 * idle-host-grace branch and holds the service for the whole grace window.
 */

import {
  classifyTransfer,
  isTransferActive,
  IDLE_HOST_GRACE_MS,
  type TransferActivityInput,
} from "../transferActivity";

const NOW = 1_700_000_000_000;

/**
 * The shape `markCancelled` writes, reduced to what `classifyTransfer` reads.
 * Kept as a literal rather than imported from `src/state/backend.ts`: that
 * module pulls in react-native and this suite runs under jest's "node"
 * environment. If the two drift, that drift is what this file catches.
 */
function cancelledShape(
  origin: TransferActivityInput["origin"]
): TransferActivityInput {
  return {
    origin,
    completed: true,
    stalled: false,
    peersConnected: 0,
    lastPeerLeftAt: null,
  };
}

describe("a cancelled transfer releases the foreground service", () => {
  test("received: cancelled is not active", () => {
    expect(classifyTransfer(cancelledShape("received"), NOW)).toBeNull();
    expect(isTransferActive([cancelledShape("received")], NOW)).toBe(false);
  });

  test("hosted: cancelled is not active", () => {
    expect(classifyTransfer(cancelledShape("hosted"), NOW)).toBeNull();
    expect(isTransferActive([cancelledShape("hosted")], NOW)).toBe(false);
  });

  test("unknown origin: cancelled is not active", () => {
    expect(classifyTransfer(cancelledShape("unknown"), NOW)).toBeNull();
  });

  // The regression guard. This is what `lastPeerLeftAt: null` buys, stated
  // as the failure it prevents rather than as the field it sets.
  test("hosted: leaving lastPeerLeftAt set would hold the service for the whole grace window", () => {
    const leftAt = NOW - 1000;
    const withTimestamp: TransferActivityInput = {
      ...cancelledShape("hosted"),
      lastPeerLeftAt: leftAt,
    };
    // Correct behaviour for a peer that dropped on its own, and the wrong
    // answer for a cancel — which is why `markCancelled` must null the field.
    expect(classifyTransfer(withTimestamp, NOW)).toBe("idle-host-grace");
    expect(classifyTransfer(cancelledShape("hosted"), NOW)).toBeNull();

    // And it would keep holding it until the window closes — measured from
    // `lastPeerLeftAt`, not from the cancel.
    expect(
      classifyTransfer(withTimestamp, leftAt + IDLE_HOST_GRACE_MS - 1)
    ).toBe("idle-host-grace");
    expect(
      classifyTransfer(withTimestamp, leftAt + IDLE_HOST_GRACE_MS)
    ).toBeNull();
  });

  test("a cancelled transfer does not keep a live one from holding the service", () => {
    const live: TransferActivityInput = {
      origin: "received",
      completed: false,
      stalled: false,
      peersConnected: 1,
      lastPeerLeftAt: null,
    };
    expect(isTransferActive([cancelledShape("hosted"), live], NOW)).toBe(true);
    expect(classifyTransfer(live, NOW)).toBe("download");
  });
});
