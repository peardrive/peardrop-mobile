// The RN-side transfer stall watchdog's decision rule.
//
// Distinct from stallWatchdog.test.ts, which covers the ENGINE's per-file
// download stall detector inside pipeDriveToFile. This one covers the
// BackendProvider watchdog that rules on whole transfers, and specifically
// the guard that stops a backgrounded window from producing a verdict.

import {
  DEFAULT_STALL_MS,
  evaluateStall,
  type StallInput,
} from "../transferStall";

const T0 = 1_800_000_000_000;

function input(over: Partial<StallInput> = {}): StallInput {
  return {
    now: T0,
    lastEventAt: T0,
    foregroundSince: T0 - 10 * 60_000,
    completed: false,
    progressEverReceived: true,
    stalled: false,
    origin: "hosted",
    ...over,
  };
}

describe("evaluateStall — the background-window guard", () => {
  test("a resume after a long background produces no verdict", () => {
    // Ten minutes backgrounded. The transfer's last event is from before
    // the app went away, so `lastEventAt` is far past the threshold — but
    // the app has only just come back, so nothing may be ruled on.
    const backgroundedFor = 10 * 60_000;
    const now = T0 + backgroundedFor;
    expect(
      evaluateStall(
        input({
          now,
          lastEventAt: T0,
          foregroundSince: now, // just resumed
        })
      )
    ).toBe("none");
  });

  test("received transfers are equally protected on resume", () => {
    const now = T0 + 10 * 60_000;
    expect(
      evaluateStall(
        input({ now, lastEventAt: T0, foregroundSince: now, origin: "received" })
      )
    ).toBe("none");
  });

  test("still suppressed one millisecond before the foreground window closes", () => {
    const now = T0 + 10 * 60_000;
    const foregroundSince = now - (DEFAULT_STALL_MS - 1);
    expect(
      evaluateStall(input({ now, lastEventAt: T0, foregroundSince }))
    ).toBe("none");
  });

  test("rules again once a full foreground window has elapsed", () => {
    const now = T0 + 10 * 60_000;
    const foregroundSince = now - DEFAULT_STALL_MS;
    expect(
      evaluateStall(input({ now, lastEventAt: T0, foregroundSince }))
    ).toBe("hosted-complete");
  });

  test("a non-finite foregroundSince fails closed", () => {
    expect(
      evaluateStall(input({ foregroundSince: Number.NaN, lastEventAt: T0 - 60_000 }))
    ).toBe("none");
  });
});

describe("evaluateStall — a genuine foreground stall still fires", () => {
  test("hosted goes to completed after the quiet period", () => {
    const now = T0 + DEFAULT_STALL_MS;
    expect(
      evaluateStall(input({ now, lastEventAt: T0, origin: "hosted" }))
    ).toBe("hosted-complete");
  });

  test("received goes to stalled after the quiet period", () => {
    const now = T0 + DEFAULT_STALL_MS;
    expect(
      evaluateStall(input({ now, lastEventAt: T0, origin: "received" }))
    ).toBe("received-stalled");
  });

  test("a live transfer inside the quiet period is untouched", () => {
    const now = T0 + DEFAULT_STALL_MS - 1;
    expect(evaluateStall(input({ now, lastEventAt: T0 }))).toBe("none");
  });
});

describe("evaluateStall — preconditions unchanged", () => {
  test("completed transfers are never ruled on", () => {
    const now = T0 + 10 * DEFAULT_STALL_MS;
    expect(evaluateStall(input({ now, lastEventAt: T0, completed: true }))).toBe(
      "none"
    );
  });

  test("a transfer that never saw progress is never ruled on", () => {
    const now = T0 + 10 * DEFAULT_STALL_MS;
    expect(
      evaluateStall(input({ now, lastEventAt: T0, progressEverReceived: false }))
    ).toBe("none");
  });

  test("an already-stalled received transfer is not re-flagged", () => {
    const now = T0 + 10 * DEFAULT_STALL_MS;
    expect(
      evaluateStall(
        input({ now, lastEventAt: T0, origin: "received", stalled: true })
      )
    ).toBe("none");
  });

  test("unknown origin is never ruled on", () => {
    const now = T0 + 10 * DEFAULT_STALL_MS;
    expect(
      evaluateStall(input({ now, lastEventAt: T0, origin: "unknown" }))
    ).toBe("none");
  });

  test("an explicit stallMs override is honoured in both directions", () => {
    const now = T0 + 5_000;
    expect(
      evaluateStall(
        input({ now, lastEventAt: T0, foregroundSince: T0 - 60_000, stallMs: 4_000 })
      )
    ).toBe("hosted-complete");
    expect(
      evaluateStall(
        input({ now, lastEventAt: T0, foregroundSince: T0 - 60_000, stallMs: 6_000 })
      )
    ).toBe("none");
  });
});
