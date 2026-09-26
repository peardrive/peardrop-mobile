import {
  enqueueIntent,
  setIntentHandler,
  openIntentGate,
  closeIntentGate,
  isIntentGateOpen,
  pendingIntentCount,
  resetPendingIntents,
  intentAgeMs,
  INTENT_SHARE_LINK,
  type PendingIntent,
  type DeliveredIntent,
} from "../pendingIntents";

const LINK = `peardrop://${"a".repeat(64)}`;
const OTHER = `peardrop://${"b".repeat(64)}`;

const share = (value: string): PendingIntent => ({
  kind: INTENT_SHARE_LINK,
  value,
});

beforeEach(() => {
  resetPendingIntents();
});

describe("the gate", () => {
  it("starts closed, so a cold-start intent is held not acted on", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));

    enqueueIntent(share(LINK));

    expect(isIntentGateOpen()).toBe(false);
    expect(seen).toEqual([]);
    expect(pendingIntentCount()).toBe(1);
  });

  it("drains what it was holding when it opens", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
    enqueueIntent(share(LINK));

    openIntentGate();

    expect(seen).toEqual([LINK]);
    expect(pendingIntentCount()).toBe(0);
  });

  it("is idempotent — a second open does not replay", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
    enqueueIntent(share(LINK));

    openIntentGate();
    openIntentGate();

    expect(seen).toEqual([LINK]);
  });

  it("passes intents straight through once open (warm start)", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
    openIntentGate();

    enqueueIntent(share(LINK));

    expect(seen).toEqual([LINK]);
    expect(pendingIntentCount()).toBe(0);
  });

  it("holds again after closing", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
    openIntentGate();
    closeIntentGate();

    enqueueIntent(share(LINK));

    expect(seen).toEqual([]);
    expect(pendingIntentCount()).toBe(1);
  });
});

describe("handler registration", () => {
  it("holds an intent that has no handler yet, even with the gate open", () => {
    openIntentGate();
    enqueueIntent(share(LINK));

    expect(pendingIntentCount()).toBe(1);
  });

  it("drains to a handler that registers late", () => {
    openIntentGate();
    enqueueIntent(share(LINK));

    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));

    expect(seen).toEqual([LINK]);
    expect(pendingIntentCount()).toBe(0);
  });

  it("stops delivering after unsubscribe", () => {
    const seen: string[] = [];
    const off = setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
    openIntentGate();
    off();

    enqueueIntent(share(LINK));

    expect(seen).toEqual([]);
    expect(pendingIntentCount()).toBe(1);
  });

  it("a stale cleanup does not unregister a newer handler", () => {
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = setIntentHandler(INTENT_SHARE_LINK, (i) => first.push(i.value));
    setIntentHandler(INTENT_SHARE_LINK, (i) => second.push(i.value));
    offFirst();

    openIntentGate();
    enqueueIntent(share(LINK));

    expect(first).toEqual([]);
    expect(second).toEqual([LINK]);
  });

  it("routes kinds independently and leaves unhandled kinds queued", () => {
    const links: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => links.push(i.value));
    openIntentGate();

    enqueueIntent({ kind: "notification", value: "tap-1" });
    enqueueIntent(share(LINK));

    expect(links).toEqual([LINK]);
    // The notification intent waits for its handler to be registered.
    expect(pendingIntentCount()).toBe(1);

    const taps: string[] = [];
    setIntentHandler("notification", (i) => taps.push(i.value));
    expect(taps).toEqual(["tap-1"]);
    expect(pendingIntentCount()).toBe(0);
  });
});

describe("dedupe", () => {
  it("drops a duplicate of something already queued (the cold-start case)", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));

    // Gate closed: exactly what happens on a cold start when the URL
    // arrives via both the initial-URL read and the `url` event.
    enqueueIntent(share(LINK));
    enqueueIntent(share(LINK));
    expect(pendingIntentCount()).toBe(1);

    openIntentGate();
    expect(seen).toEqual([LINK]);
  });

  it("keeps distinct links queued separately, in arrival order", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));

    enqueueIntent(share(LINK));
    enqueueIntent(share(OTHER));
    expect(pendingIntentCount()).toBe(2);

    openIntentGate();
    expect(seen).toEqual([LINK, OTHER]);
  });

  it("does not conflate the same value across different kinds", () => {
    openIntentGate();
    enqueueIntent({ kind: "a", value: LINK });
    enqueueIntent({ kind: "b", value: LINK });

    expect(pendingIntentCount()).toBe(2);
  });

  it("suppresses an immediate redelivery of a just-drained intent", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
    openIntentGate();

    enqueueIntent(share(LINK));
    enqueueIntent(share(LINK));

    expect(seen).toEqual([LINK]);
  });

  it("allows a deliberate re-tap once the dedupe window has passed", () => {
    const now = jest.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      const seen: string[] = [];
      setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));
      openIntentGate();

      enqueueIntent(share(LINK));
      expect(seen).toEqual([LINK]);

      // Well past DEDUPE_WINDOW_MS — the user tapping the same link again
      // after a failed resolve must not be silently ignored.
      now.mockReturnValue(1_000_000 + 60_000);
      enqueueIntent(share(LINK));

      expect(seen).toEqual([LINK, LINK]);
    } finally {
      now.mockRestore();
    }
  });
});

// The gate can hold an intent for an unbounded stretch, so handlers need to
// know how long it sat. The holder supplies the timestamp and nothing else;
// the staleness policy is the consumer's.
describe("timestamps", () => {
  it("stamps `at` at enqueue time and delivers it to the handler", () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const seen: DeliveredIntent[] = [];
      setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i));
      openIntentGate();

      enqueueIntent(share(LINK));

      expect(seen).toHaveLength(1);
      expect(seen[0]?.at).toBe(1_700_000_000_000);
    } finally {
      now.mockRestore();
    }
  });

  it("preserves the enqueue-time stamp across a long hold", () => {
    const now = jest.spyOn(Date, "now");
    try {
      // Offered while the gate is shut — e.g. a link tapped before
      // onboarding finished.
      now.mockReturnValue(1_000_000);
      setIntentHandler(INTENT_SHARE_LINK, () => {});
      enqueueIntent(share(LINK));

      const seen: DeliveredIntent[] = [];
      setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i));

      // ...and drained five minutes later.
      now.mockReturnValue(1_000_000 + 300_000);
      openIntentGate();

      expect(seen).toHaveLength(1);
      // The stamp is when it arrived, not when it drained — that
      // difference is the whole point.
      expect(seen[0]?.at).toBe(1_000_000);
      expect(intentAgeMs(seen[0] as DeliveredIntent)).toBe(300_000);
    } finally {
      now.mockRestore();
    }
  });

  it("honours a caller-supplied `at`", () => {
    const seen: DeliveredIntent[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i));
    openIntentGate();

    const explicit: PendingIntent = { ...share(LINK), at: 12_345 };
    enqueueIntent(explicit);

    expect(seen[0]?.at).toBe(12_345);
  });

  it("does not let `at` affect dedupe", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => seen.push(i.value));

    // Same (kind, value), different stamps, both held behind the gate.
    enqueueIntent({ ...share(LINK), at: 1 });
    enqueueIntent({ ...share(LINK), at: 999_999 });

    expect(pendingIntentCount()).toBe(1);
    openIntentGate();
    expect(seen).toEqual([LINK]);
  });

  it("intentAgeMs never reports a negative age", () => {
    const future: DeliveredIntent = { ...share(LINK), at: 5_000 };
    expect(intentAgeMs(future, 1_000)).toBe(0);
    expect(intentAgeMs(future, 9_000)).toBe(4_000);
  });
});

describe("robustness", () => {
  it("a throwing handler does not strand the rest of the queue", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => {
      seen.push(i.value);
      if (i.value === LINK) throw new Error("boom");
    });

    enqueueIntent(share(LINK));
    enqueueIntent(share(OTHER));
    expect(() => openIntentGate()).not.toThrow();

    expect(seen).toEqual([LINK, OTHER]);
    expect(pendingIntentCount()).toBe(0);
  });

  it("handles an intent enqueued from inside a handler without recursing", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => {
      seen.push(i.value);
      if (i.value === LINK) enqueueIntent(share(OTHER));
    });
    openIntentGate();

    enqueueIntent(share(LINK));

    expect(seen).toEqual([LINK, OTHER]);
    expect(pendingIntentCount()).toBe(0);
  });

  it("stops draining if a handler closes the gate mid-drain", () => {
    const seen: string[] = [];
    setIntentHandler(INTENT_SHARE_LINK, (i) => {
      seen.push(i.value);
      closeIntentGate();
    });

    enqueueIntent(share(LINK));
    enqueueIntent(share(OTHER));
    openIntentGate();

    expect(seen).toEqual([LINK]);
    expect(pendingIntentCount()).toBe(1);
  });
});
