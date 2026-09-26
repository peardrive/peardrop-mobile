import {
  buildShareKeyDriveIndex,
  cancelledRowLabel,
  clampReceivePercent,
  grabCompletionMessage,
  receiveRowStatus,
  resolveReceivedTransfer,
} from "../receiveProgress";

/**
 * The pure layer only — no engine, no React, no mocked worklet. That progress
 * actually advances on a real receive is not covered here and cannot be.
 */

/**
 * This helper is a trap: ts-jest runs with `strict: false`, so a required
 * field omitted from this literal leaves the suite green while `tsc`
 * (`strict: true`) fails. The suite passing is not evidence that the literal
 * is complete.
 */
const transfer = (over: Partial<Parameters<typeof receiveRowStatus>[0] & object> = {}) => ({
  percent: null as number | null,
  completed: false,
  cancelled: false,
  stalled: false,
  progressEverReceived: false,
  ...over,
});

describe("buildShareKeyDriveIndex", () => {
  it("indexes received drives by share key", () => {
    const index = buildShareKeyDriveIndex([
      { id: "drive-a", key: "AAAA", origin: "received" },
      { id: "drive-b", key: "bbbb", origin: "received" },
    ]);
    expect(index.get("aaaa")).toBe("drive-a");
    expect(index.get("bbbb")).toBe("drive-b");
  });

  it("ignores hosted drives — a hosted row keys off its driveId directly", () => {
    const index = buildShareKeyDriveIndex([
      { id: "drive-a", key: "aaaa", origin: "hosted" },
      { id: "drive-b", key: "bbbb" },
    ]);
    expect(index.size).toBe(0);
  });

  it("skips entries missing either half of the mapping", () => {
    const index = buildShareKeyDriveIndex([
      { id: "drive-a", origin: "received" },
      { id: "", key: "bbbb", origin: "received" },
    ]);
    expect(index.size).toBe(0);
  });

  it("lets the live session OVERRIDE a stale drive-list entry", () => {
    // The in-flight grab is the only one the user is watching, and the drive
    // list is behind by definition on the receive path — no drive-created or
    // drive-hydrated is emitted there.
    const index = buildShareKeyDriveIndex(
      [{ id: "old-drive", key: "aaaa", origin: "received" }],
      { shareKey: "AAAA", driveId: "live-drive" },
    );
    expect(index.get("aaaa")).toBe("live-drive");
  });

  it("adds the live session when the drive list has nothing at all", () => {
    const index = buildShareKeyDriveIndex([], {
      shareKey: "aaaa",
      driveId: "live-drive",
    });
    expect(index.get("aaaa")).toBe("live-drive");
  });

  it("ignores a half-populated live session", () => {
    expect(
      buildShareKeyDriveIndex([], { shareKey: "aaaa", driveId: null }).size,
    ).toBe(0);
    expect(
      buildShareKeyDriveIndex([], { shareKey: null, driveId: "live" }).size,
    ).toBe(0);
  });

  it("tolerates null/undefined drive lists", () => {
    expect(buildShareKeyDriveIndex(null).size).toBe(0);
    expect(buildShareKeyDriveIndex(undefined).size).toBe(0);
  });
});

describe("resolveReceivedTransfer", () => {
  const index = new Map([["aaaa", "drive-a"]]);
  const transfers = new Map([["drive-a", { tag: "found" }]]);

  it("resolves a share key through to its transfer", () => {
    expect(resolveReceivedTransfer("aaaa", index, transfers)).toEqual({
      tag: "found",
    });
  });

  it("is case-insensitive on the share key", () => {
    expect(resolveReceivedTransfer("AAAA", index, transfers)).toEqual({
      tag: "found",
    });
  });

  it("returns undefined for an unknown key rather than throwing", () => {
    expect(resolveReceivedTransfer("zzzz", index, transfers)).toBeUndefined();
    expect(resolveReceivedTransfer(null, index, transfers)).toBeUndefined();
    expect(resolveReceivedTransfer(undefined, index, transfers)).toBeUndefined();
  });

  it("returns undefined when the driveId maps to no transfer yet", () => {
    expect(resolveReceivedTransfer("aaaa", index, new Map())).toBeUndefined();
  });
});

describe("receiveRowStatus", () => {
  it("reports idle with no transfer", () => {
    expect(receiveRowStatus(null).state).toBe("idle");
    expect(receiveRowStatus(undefined).state).toBe("idle");
  });

  it("reports starting before any bytes land", () => {
    const s = receiveRowStatus(transfer());
    expect(s.state).toBe("starting");
    expect(s.label).toBe("Starting…");
  });

  it("reports receiving with a percent while bytes move", () => {
    const s = receiveRowStatus(transfer({ percent: 42 }));
    expect(s.state).toBe("receiving");
    expect(s.label).toBe("Receiving (42%)");
  });

  it("stays in receiving once progress was seen but percent reads 0", () => {
    // A drive with an unknown denominator emits percent 0 with real
    // bytesTransferred; "Starting…" forever would be a lie.
    const s = receiveRowStatus(transfer({ percent: 0, progressEverReceived: true }));
    expect(s.state).toBe("receiving");
  });

  it("DISTINGUISHES a finished download from one stuck at 100%", () => {
    // Same percent, different state, different label. If these two ever
    // collapse, a stuck grab reads as a finished one again.
    const stuck = receiveRowStatus(transfer({ percent: 100, completed: false }));
    const done = receiveRowStatus(transfer({ percent: 100, completed: true }));

    expect(stuck.state).toBe("finishing");
    expect(done.state).toBe("saved");
    expect(stuck.label).not.toBe(done.label);
  });

  it("treats completion as terminal regardless of percent", () => {
    // `upload-complete` is the authority; a completed transfer whose
    // percent never reached 100 (block-accounting drift) still reads done.
    expect(receiveRowStatus(transfer({ percent: 97, completed: true })).state).toBe(
      "saved",
    );
    expect(receiveRowStatus(transfer({ percent: null, completed: true })).state).toBe(
      "saved",
    );
  });

  it("lets completion outrank a stale stall flag", () => {
    expect(
      receiveRowStatus(transfer({ completed: true, stalled: true })).state,
    ).toBe("saved");
  });

  it("surfaces a stall as its own state", () => {
    const s = receiveRowStatus(transfer({ percent: 30, stalled: true }));
    expect(s.state).toBe("stalled");
    expect(s.tone).toBe("danger");
  });

  // The row for a download the user stopped read "Saved".
  describe("a transfer the user cancelled", () => {
    // The ordering probe. `markCancelled` writes `completed: true` and
    // `cancelled: true` into the same object, so a `cancelled` branch placed
    // below the `completed` branch is unreachable and the row still lies.
    // This fails if the branch is moved down by one.
    it("does NOT read as Saved, even though completed is also true", () => {
      const s = receiveRowStatus(transfer({ completed: true, cancelled: true }));
      expect(s.state).toBe("cancelled");
      expect(s.state).not.toBe("saved");
      expect(s.label).not.toBe("Saved");
    });

    it("names the count the engine reported", () => {
      expect(
        receiveRowStatus(transfer({ completed: true, cancelled: true, filesKept: 3 }))
          .label,
      ).toBe("Stopped — 3 files saved");
    });

    it("singularises one kept file", () => {
      expect(
        receiveRowStatus(transfer({ completed: true, cancelled: true, filesKept: 1 }))
          .label,
      ).toBe("Stopped — 1 file saved");
    });

    it("says nothing was saved when nothing was", () => {
      expect(
        receiveRowStatus(transfer({ completed: true, cancelled: true, filesKept: 0 }))
          .label,
      ).toBe("Stopped — nothing saved");
    });

    // The distinction a `?? 0` would destroy. `cancelInFlight`'s
    // `alreadyInactive` path settles the row with no event behind it, so
    // there is no count, and "nothing saved" over files that are on disk is a
    // claim the app never observed.
    it("does not invent a zero when the count is unknown", () => {
      for (const missing of [undefined, null]) {
        const s = receiveRowStatus(
          transfer({ completed: true, cancelled: true, filesKept: missing }),
        );
        expect(s.label).toBe("Stopped");
        expect(s.label).not.toContain("nothing saved");
      }
    });

    // Muted, not danger. The user asked for this; a red row apologises for
    // obeying. Same reasoning `grabCompletionMessage` applies when it returns
    // `kind: "info"` rather than "error" on a cancel.
    it("is muted, not danger — there is nothing to apologise for", () => {
      const s = receiveRowStatus(transfer({ completed: true, cancelled: true }));
      expect(s.tone).toBe("muted");
      expect(s.tone).not.toBe("danger");
    });

    // The row must agree with the toast — the same sentence, not a similar
    // one.
    it("says exactly what the toast says", () => {
      for (const kept of [0, 1, 3, 12]) {
        expect(`${cancelledRowLabel(kept)}.`).toBe(
          grabCompletionMessage({ saved: kept, failed: 0, cancelled: true }).text,
        );
      }
    });

    it("outranks a stale stall flag as well as completion", () => {
      expect(
        receiveRowStatus(transfer({ completed: true, cancelled: true, stalled: true }))
          .state,
      ).toBe("cancelled");
    });

    // The app cannot tell "the host is offline" from "DHT discovery is still
    // running", and nothing here expires. A cancel is the one terminal state
    // the app genuinely observed.
    it("claims nothing the app did not observe", () => {
      for (const kept of [null, 0, 1, 5]) {
        const label = cancelledRowLabel(kept);
        expect(label).not.toMatch(/network|offline|Wi-?Fi|internet|expire/i);
        expect(label).not.toMatch(/check your/i);
      }
    });

    it("treats a garbage count as unknown rather than as a number", () => {
      expect(cancelledRowLabel(Number.NaN)).toBe("Stopped");
      expect(cancelledRowLabel(Number.POSITIVE_INFINITY)).toBe("Stopped");
      expect(cancelledRowLabel(-1)).toBe("Stopped");
      expect(cancelledRowLabel(2.4)).toBe("Stopped — 2 files saved");
    });
  });

  // `download-outcome` writes `completed: true` on all three outcomes,
  // because every "this is over" reader consults it — so a row that reads
  // `completed` first says "Saved" over a grab that saved nothing.
  describe("a grab the engine graded", () => {
    // The ordering probe, same shape as the one above: a `downloadOutcome`
    // clause placed below the `completed` clause is unreachable code that
    // looks like a fix. This fails if the branch is moved down one.
    it("does NOT read as Saved when nothing arrived", () => {
      const s = receiveRowStatus(
        transfer({
          completed: true,
          downloadOutcome: { outcome: "failed", kept: 0, failed: 3 },
        }),
      );
      expect(s.state).toBe("failed");
      expect(s.state).not.toBe("saved");
      expect(s.label).not.toBe("Saved");
      expect(s.label).toBe("Couldn't grab 3 files");
      // The user did not ask for this. Unlike a cancel, there is something to
      // apologise for, so the muted tone is wrong here.
      expect(s.tone).toBe("danger");
    });

    it("singularises a single casualty", () => {
      expect(
        receiveRowStatus(
          transfer({
            completed: true,
            downloadOutcome: { outcome: "failed", kept: 0, failed: 1 },
          }),
        ).label,
      ).toBe("Couldn't grab that file");
    });

    it("names both counts on a partial grab", () => {
      const s = receiveRowStatus(
        transfer({
          completed: true,
          downloadOutcome: { outcome: "partial", kept: 2, failed: 1 },
        }),
      );
      expect(s.state).toBe("partial");
      expect(s.label).toBe("Saved 2 of 3 — 1 didn't make it");
      expect(s.label).not.toBe("Saved");
      // `warning`, not `danger`: mirrors the haptic split — warning for
      // partial, error for failed.
      expect(s.tone).toBe("warning");
    });

    it("leaves a complete grab exactly as it was", () => {
      const s = receiveRowStatus(
        transfer({
          percent: 100,
          completed: true,
          downloadOutcome: { outcome: "complete", kept: 3, failed: 0 },
        }),
      );
      expect(s.state).toBe("saved");
      expect(s.label).toBe("Saved");
      expect(s.tone).toBe("primary");
    });

    // The user's own stop outranks the engine's grading of it. A cancelled
    // grab is `partial` by the counts and "Stopped" by intent, and
    // `grabCompletionMessage` settles it the same way: its `cancelled` arm
    // sits above the failed/saved split.
    it("lets a cancel outrank the outcome grading", () => {
      const s = receiveRowStatus(
        transfer({
          completed: true,
          cancelled: true,
          filesKept: 2,
          downloadOutcome: { outcome: "partial", kept: 2, failed: 1 },
        }),
      );
      expect(s.state).toBe("cancelled");
      expect(s.label).toBe("Stopped — 2 files saved");
      expect(s.label).not.toContain("didn't make it");
    });

    it("outranks a stale stall flag, as completion does", () => {
      expect(
        receiveRowStatus(
          transfer({
            completed: true,
            stalled: true,
            downloadOutcome: { outcome: "failed", kept: 0, failed: 2 },
          }),
        ).state,
      ).toBe("failed");
    });

    // Reachable, not defensive. `download-outcome`'s handler treats an
    // unrecognised or missing `outcome` as "failed" and defaults both counts
    // to 0, so `failed` with no counts is a real state. "Couldn't grab 0
    // files" is not an acceptable rendering of it.
    it("says nothing was saved rather than naming a zero count", () => {
      const s = receiveRowStatus(
        transfer({
          completed: true,
          downloadOutcome: { outcome: "failed", kept: 0, failed: 0 },
        }),
      );
      expect(s.state).toBe("failed");
      expect(s.label).toBe("Nothing saved");
      expect(s.label).not.toContain("0 files");
    });

    it("does not claim a split it cannot name", () => {
      // `partial` with no casualty count: the split is unknown, so the row
      // says what it observed and stops there.
      expect(
        receiveRowStatus(
          transfer({
            completed: true,
            downloadOutcome: { outcome: "partial", kept: 2, failed: 0 },
          }),
        ).label,
      ).toBe("Some files didn't arrive");
      // `partial` with nothing kept is a failed grab wearing the wrong label.
      expect(
        receiveRowStatus(
          transfer({
            completed: true,
            downloadOutcome: { outcome: "partial", kept: 0, failed: 4 },
          }),
        ).label,
      ).toBe("Couldn't grab 4 files");
    });

    it("treats garbage counts as unknown rather than as numbers", () => {
      expect(
        receiveRowStatus(
          transfer({
            completed: true,
            downloadOutcome: {
              outcome: "failed",
              kept: Number.NaN,
              failed: Number.NaN,
            },
          }),
        ).label,
      ).toBe("Nothing saved");
      expect(
        receiveRowStatus(
          transfer({
            completed: true,
            downloadOutcome: {
              outcome: "partial",
              kept: 2,
              failed: Number.POSITIVE_INFINITY,
            },
          }),
        ).label,
      ).toBe("Some files didn't arrive");
    });

    // An absent `downloadOutcome` is the hosted row and the in-flight
    // received row. Neither may be graded; "not known" must stay not known.
    it("changes nothing when the outcome is absent", () => {
      expect(receiveRowStatus(transfer({ completed: true })).state).toBe("saved");
      expect(receiveRowStatus(transfer({ percent: 42 })).state).toBe("receiving");
    });

    // The app cannot tell "the host is offline" from "DHT discovery is still
    // running", and nothing here expires. These labels say what happened and
    // nothing about why.
    it("claims nothing the app did not observe", () => {
      const outcomes = [
        { outcome: "failed" as const, kept: 0, failed: 0 },
        { outcome: "failed" as const, kept: 0, failed: 1 },
        { outcome: "failed" as const, kept: 0, failed: 5 },
        { outcome: "partial" as const, kept: 2, failed: 0 },
        { outcome: "partial" as const, kept: 2, failed: 3 },
      ];
      for (const downloadOutcome of outcomes) {
        const { label } = receiveRowStatus(transfer({ completed: true, downloadOutcome }));
        expect(label).not.toMatch(/network|offline|Wi-?Fi|internet|expire/i);
        expect(label).not.toMatch(/check your/i);
      }
    });
  });

  it("does not render a NaN percent as progress", () => {
    // NaN is a number and slips past every comparison; `NaN >= 100` and
    // `NaN > 0` are both false. Guarded at the boundary, not here.
    const s = receiveRowStatus(transfer({ percent: Number.NaN }));
    expect(s.label).toBe("Starting…");
    expect(s.label).not.toContain("NaN");
  });
});

describe("clampReceivePercent", () => {
  it("clamps into 0..100 and rounds", () => {
    expect(clampReceivePercent(-5)).toBe(0);
    expect(clampReceivePercent(140)).toBe(100);
    expect(clampReceivePercent(41.6)).toBe(42);
  });

  it("maps non-finite input to 0", () => {
    expect(clampReceivePercent(Number.NaN)).toBe(0);
    expect(clampReceivePercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampReceivePercent(null)).toBe(0);
    expect(clampReceivePercent(undefined)).toBe(0);
  });
});

describe("grabCompletionMessage", () => {
  it("reports a clean grab as a success", () => {
    expect(grabCompletionMessage({ saved: 3, failed: 0 })).toEqual({
      text: "Got it — 3 files saved.",
      kind: "success",
    });
  });

  it("singularizes one file", () => {
    expect(grabCompletionMessage({ saved: 1, failed: 0 }).text).toBe(
      "Got it — 1 file saved.",
    );
  });

  it("does NOT report a partial grab as an unqualified success", () => {
    // engineDownload returns ok:true with survivors in `files` and casualties
    // in `failed`, so a success message there leaves the user with a
    // truncated set and no way to know.
    const msg = grabCompletionMessage({ saved: 2, failed: 1 });
    expect(msg.kind).toBe("error");
    expect(msg.text).toContain("2 of 3");
  });

  it("reports a total failure plainly", () => {
    expect(grabCompletionMessage({ saved: 0, failed: 4 })).toEqual({
      text: "Couldn't grab 4 files.",
      kind: "error",
    });
    expect(grabCompletionMessage({ saved: 0, failed: 1 }).text).toBe(
      "Couldn't grab that file.",
    );
  });

  // Cancelling a ten-file share after three must say what was kept. Silence
  // leaves the user to work out what they have.
  describe("cancelled grabs", () => {
    it("says what was kept, without celebrating or apologising", () => {
      expect(grabCompletionMessage({ saved: 3, failed: 0, cancelled: true })).toEqual({
        text: "Stopped — 3 files saved.",
        kind: "info",
      });
    });

    it("singularises one kept file", () => {
      expect(grabCompletionMessage({ saved: 1, failed: 0, cancelled: true }).text).toBe(
        "Stopped — 1 file saved.",
      );
    });

    it("still answers when the cancel beat the first file", () => {
      expect(grabCompletionMessage({ saved: 0, failed: 0, cancelled: true })).toEqual({
        text: "Stopped — nothing saved.",
        kind: "info",
      });
    });

    // A cancelled grab and a broken one both end with fewer files than asked
    // for, and only one is the user's own doing, so only one may be phrased
    // as loss.
    it("never uses the partial-FAILURE wording, even with a failed count", () => {
      const cancelled = grabCompletionMessage({ saved: 2, failed: 1, cancelled: true });
      expect(cancelled.kind).toBe("info");
      expect(cancelled.text).toBe("Stopped — 2 files saved.");
      expect(cancelled.text).not.toContain("didn't make it");
      expect(cancelled.text).not.toContain("2 of 3");

      // Same counts, not cancelled: still reported as the partial failure
      // it is. Cancelling must not become a way to hide real casualties.
      const broken = grabCompletionMessage({ saved: 2, failed: 1 });
      expect(broken.kind).toBe("error");
      expect(broken.text).toContain("2 of 3");
    });
  });
});
