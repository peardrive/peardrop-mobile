import {
  RESHARE_INCOMPLETE_HINT,
  RESHARE_SHARE_LABEL,
  RESHARE_START_FAILED_TEXT,
  RESHARE_STARTED_TEXT,
  RESHARE_STOP_FAILED_TEXT,
  RESHARE_STOP_LABEL,
  RESHARE_STOPPED_TEXT,
  receivedShareIsAnnouncing,
  reshareControl,
  reshareStartOutcome,
  reshareStopOutcome,
  type ReshareSignals,
} from "../reshareControl";

/**
 * The re-share decision. The wiring that reaches this module is pinned
 * separately in `reshareWiring.test.ts`: a green suite over a module nothing
 * calls is not evidence, and this file cannot tell the difference on its own.
 */

/** A complete, hydrated, re-shared received copy. Arms vary one field. */
function signals(over: Partial<ReshareSignals> = {}): ReshareSignals {
  return {
    origin: "received",
    complete: true,
    driveId: "drive-1",
    reshared: true,
    sessionUp: true,
    observedMode: null,
    ...over,
  };
}

describe("receivedShareIsAnnouncing", () => {
  /**
   * The defect this module exists for. A hydrated received drive sits in the
   * engine's `activeDrives` with `swarm: null`, so a gate keyed on "active"
   * is true while the phone advertises nothing. `active` is not an input here
   * at all: with the persisted pair absent, the answer is not announcing.
   */
  it("is false for a hydrated received copy that has never been re-shared", () => {
    expect(
      receivedShareIsAnnouncing(signals({ reshared: false })),
    ).toBe(false);
  });

  it("is true for the boot rule's own pair: reshared AND complete AND a live session", () => {
    expect(receivedShareIsAnnouncing(signals())).toBe(true);
  });

  it("refuses the persisted intent when the copy is not complete", () => {
    expect(receivedShareIsAnnouncing(signals({ complete: false }))).toBe(false);
  });

  it("refuses the persisted intent when the session did not come up", () => {
    expect(receivedShareIsAnnouncing(signals({ sessionUp: false }))).toBe(false);
  });

  /**
   * Precedence, both directions. A live `activate` reply is a reading; the
   * persisted pair is a prediction about what the boot rule did. The reading
   * wins, including when it is the disappointing answer: a stale
   * `reshared: true` must not keep a link on screen after the engine has
   * answered `client`.
   */
  it("lets a live client reply override a stale reshared flag", () => {
    expect(
      receivedShareIsAnnouncing(signals({ observedMode: "client" })),
    ).toBe(false);
    expect(
      receivedShareIsAnnouncing(signals({ observedMode: "none" })),
    ).toBe(false);
  });

  it("lets a live server reply override an unset reshared flag", () => {
    expect(
      receivedShareIsAnnouncing(
        signals({ reshared: false, observedMode: "server" }),
      ),
    ).toBe(true);
  });
});

describe("reshareControl", () => {
  it("offers nothing on a hosted row", () => {
    expect(reshareControl(signals({ origin: "hosted" })).kind).toBe("none");
    expect(reshareControl(signals({ origin: undefined })).kind).toBe("none");
  });

  it("offers Stop sharing while this phone is announcing", () => {
    expect(reshareControl(signals())).toEqual({
      kind: "stop",
      label: RESHARE_STOP_LABEL,
      enabled: true,
      disabledReason: null,
    });
    expect(RESHARE_STOP_LABEL).toBe("Stop sharing");
  });

  it("offers an enabled Share on a complete copy that is not announcing", () => {
    expect(reshareControl(signals({ reshared: false }))).toEqual({
      kind: "share",
      label: RESHARE_SHARE_LABEL,
      enabled: true,
      disabledReason: null,
    });
    expect(RESHARE_SHARE_LABEL).toBe("Share");
  });

  /**
   * Pinned as a literal rather than through the constant alone: the
   * requirement is a specific sentence, and a test that compares the constant
   * to itself passes after someone rewrites it.
   */
  it("shows the Share control DISABLED, not hidden, on an incomplete copy", () => {
    const c = reshareControl(signals({ complete: false, reshared: false }));
    expect(c.kind).toBe("share");
    expect(c.enabled).toBe(false);
    expect(c.disabledReason).toBe("Finish downloading to share it.");
    expect(RESHARE_INCOMPLETE_HINT).toBe("Finish downloading to share it.");
  });

  /**
   * The disabled arm is reachable without a driveId. An incomplete copy is
   * explained before the app asks whether it could act, because the
   * explanation is the point and a half-downloaded share may have no
   * persisted driveId yet.
   */
  it("still explains an incomplete copy when no driveId is known", () => {
    const c = reshareControl(
      signals({ complete: false, reshared: false, driveId: null }),
    );
    expect(c.kind).toBe("share");
    expect(c.disabledReason).toBe(RESHARE_INCOMPLETE_HINT);
  });

  /**
   * Fail closed. Without an engine driveId the only reachable outcome of a
   * tap is `engineActivateDrive`'s `drive-not-found`, which is raw engine
   * text no user may see, so there is no button.
   */
  it("offers nothing when the engine driveId is unknown", () => {
    expect(reshareControl(signals({ reshared: false, driveId: null })).kind).toBe(
      "none",
    );
    expect(reshareControl(signals({ reshared: false, driveId: "" })).kind).toBe(
      "none",
    );
  });
});

describe("reshareStartOutcome", () => {
  /**
   * The load-bearing test of this file. Both arms are
   * `ok: true, mode: "client"` and the only difference is `serveRefused`, so
   * they must not produce the same sentence: one user has a download to
   * finish, the other had a promotion fail. A reader keyed on `mode` cannot
   * tell them apart and is wrong for one of them every time.
   */
  it("distinguishes a refusal from a failed promotion on the same mode", () => {
    const refused = reshareStartOutcome({
      ok: true,
      mode: "client",
      serveRefused: "incomplete",
    });
    const failedPromotion = reshareStartOutcome({
      ok: true,
      mode: "client",
      serveRefused: null,
    });

    expect(refused.kind).toBe("refused-incomplete");
    expect(refused.text).toBe(RESHARE_INCOMPLETE_HINT);
    expect(refused.tone).toBe("info");

    expect(failedPromotion.kind).toBe("not-announcing");
    expect(failedPromotion.text).toBe(RESHARE_START_FAILED_TEXT);
    expect(failedPromotion.tone).toBe("error");

    expect(refused.text).not.toBe(failedPromotion.text);
    expect(refused.mode).toBe(failedPromotion.mode);
  });

  it("reports announcing only on mode server", () => {
    const out = reshareStartOutcome({ ok: true, mode: "server" });
    expect(out).toEqual({
      kind: "announcing",
      mode: "server",
      text: RESHARE_STARTED_TEXT,
      tone: "success",
      announcing: true,
    });
  });

  /** `ok` alone is never the gate: a refusal is `ok: true`. */
  it("never claims announcing from ok alone", () => {
    for (const mode of ["client", "none"] as const) {
      expect(reshareStartOutcome({ ok: true, mode }).announcing).toBe(false);
    }
  });

  it("treats a failed reply, a missing reply and a missing mode as failure", () => {
    expect(reshareStartOutcome({ ok: false }).kind).toBe("failed");
    expect(reshareStartOutcome(null).kind).toBe("failed");
    expect(reshareStartOutcome(undefined).kind).toBe("failed");
    expect(reshareStartOutcome({ ok: true }).mode).toBe("none");
    expect(reshareStartOutcome({ ok: false }).text).toBe(
      RESHARE_START_FAILED_TEXT,
    );
  });
});

describe("reshareStopOutcome", () => {
  it("reports stopped when the swarm came down to client or none", () => {
    for (const mode of ["client", "none"] as const) {
      const out = reshareStopOutcome({ ok: true, mode });
      expect(out.kind).toBe("stopped");
      expect(out.text).toBe(RESHARE_STOPPED_TEXT);
      expect(out.announcing).toBe(false);
    }
  });

  /**
   * Reporting a stop that did not take hides the link while the phone keeps
   * announcing: the user believes they have stopped and they have not.
   */
  it("refuses to report success while the reply still says server", () => {
    const out = reshareStopOutcome({ ok: true, mode: "server" });
    expect(out.kind).toBe("not-stopped");
    expect(out.text).toBe(RESHARE_STOP_FAILED_TEXT);
    expect(out.announcing).toBe(true);
  });

  it("keeps announcing true on a failed stop that still reported server", () => {
    expect(reshareStopOutcome({ ok: false, mode: "server" }).announcing).toBe(
      true,
    );
    expect(reshareStopOutcome({ ok: false, mode: "client" }).announcing).toBe(
      false,
    );
  });
});
