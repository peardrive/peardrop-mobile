import {
  NOTIFICATION_UPDATE_INTERVAL_MS,
  describeTransferNotification,
  shouldPostNotification,
  type NotificationContent,
  type NotificationTransferInput,
} from "../notificationProgress";

const NOW = 1_700_000_000_000;

function t(
  over: Partial<NotificationTransferInput> = {}
): NotificationTransferInput {
  return {
    driveId: "drive-1",
    origin: "received",
    completed: false,
    stalled: false,
    peersConnected: 0,
    lastPeerLeftAt: null,
    percent: null,
    bytesTransferred: 0,
    totalBytes: null,
    driveSize: null,
    ...over,
  };
}

const noName = () => null;

describe("describeTransferNotification", () => {
  it("returns null when nothing is active, so the caller does not post", () => {
    expect(describeTransferNotification([], NOW, noName)).toBeNull();
    // A completed download is not active.
    expect(
      describeTransferNotification([t({ completed: true })], NOW, noName)
    ).toBeNull();
  });

  it("names the direction even when the drive name is unknown", () => {
    const out = describeTransferNotification([t()], NOW, noName);
    expect(out?.title).toBe("Receiving");
  });

  it("uses the drive name when it resolves", () => {
    const out = describeTransferNotification(
      [t({ bytesTransferred: 512, totalBytes: 1024 })],
      NOW,
      () => "video.mp4"
    );
    expect(out?.title).toBe("Receiving video.mp4");
    expect(out?.text).toBe("50% · 512 B of 1.0 KB");
    expect(out?.percent).toBe(50);
  });

  it("calls a hosted drive with a connected peer a send", () => {
    const out = describeTransferNotification(
      [t({ origin: "hosted", peersConnected: 1 })],
      NOW,
      () => "holiday.zip"
    );
    expect(out?.title).toBe("Sending holiday.zip");
  });

  it("never produces an empty title or an empty body", () => {
    const out = describeTransferNotification([t()], NOW, () => "   ");
    expect(out?.title).toBe("Receiving");
    expect(out?.text).toBe("Connecting…");
    expect(out?.percent).toBe(-1);
  });

  it("aggregates several transfers and pluralises the title", () => {
    const out = describeTransferNotification(
      [
        t({ driveId: "a", bytesTransferred: 100, totalBytes: 200 }),
        t({ driveId: "b", bytesTransferred: 100, totalBytes: 200 }),
      ],
      NOW,
      () => "ignored-when-many"
    );
    expect(out?.title).toBe("Receiving 2 shares");
    expect(out?.percent).toBe(50);
  });

  it("says Transferring when directions are mixed", () => {
    const out = describeTransferNotification(
      [t({ driveId: "a" }), t({ driveId: "b", origin: "hosted", peersConnected: 1 })],
      NOW,
      noName
    );
    expect(out?.title).toBe("Transferring 2 shares");
  });

  it("stays indeterminate rather than reporting a partial sum as a percentage", () => {
    const out = describeTransferNotification(
      [
        t({ driveId: "a", bytesTransferred: 100, totalBytes: 200 }),
        t({ driveId: "b", bytesTransferred: 50, totalBytes: null }),
      ],
      NOW,
      noName
    );
    expect(out?.percent).toBe(-1);
    expect(out?.text).toBe("150 B so far");
  });

  it("falls back to driveSize when totalBytes is absent", () => {
    const out = describeTransferNotification(
      [t({ bytesTransferred: 256, totalBytes: null, driveSize: 1024 })],
      NOW,
      noName
    );
    expect(out?.percent).toBe(25);
  });

  it("falls back to the engine percent for a lone transfer with no totals", () => {
    const out = describeTransferNotification([t({ percent: 43 })], NOW, noName);
    expect(out?.percent).toBe(43);
    expect(out?.text).toBe("43%");
  });

  // measurement.md: NaN is a number, and a threshold comparison admits it.
  it("rejects NaN and Infinity at the boundary instead of rendering them", () => {
    const out = describeTransferNotification(
      [t({ percent: NaN, bytesTransferred: NaN, totalBytes: Infinity })],
      NOW,
      noName
    );
    expect(out?.percent).toBe(-1);
    expect(out?.text).toBe("Connecting…");
    expect(out?.title).toBe("Receiving");
  });

  it("clamps an out-of-range engine percent", () => {
    expect(describeTransferNotification([t({ percent: 140 })], NOW, noName)?.percent).toBe(100);
    expect(describeTransferNotification([t({ percent: -8 })], NOW, noName)?.percent).toBe(0);
  });

  // The Cancel action's label states its scope. There is one notification —
  // the single id a foreground service may own — and it carries no driveId,
  // so the button necessarily stops everything active. A button reading
  // "Cancel" that silently kills three transfers is the trap it avoids.
  describe("cancel label", () => {
    it("says Cancel for a single active transfer", () => {
      expect(describeTransferNotification([t({})], NOW, noName)?.cancelLabel).toBe(
        "Cancel",
      );
    });

    it("says Cancel all once more than one is active", () => {
      const content = describeTransferNotification(
        [t({ driveId: "a" }), t({ driveId: "b" })],
        NOW,
        noName,
      );
      expect(content?.cancelLabel).toBe("Cancel all");
      // Derived from the same `picked` set as the title, so the two can never
      // disagree about how many transfers the button will stop.
      expect(content?.title).toContain("2 shares");
    });

    it("counts only ACTIVE transfers, not the whole list", () => {
      // A completed transfer is not in `picked`, so it must not push the
      // label to the plural: the button would claim a wider scope than it
      // cancels.
      const content = describeTransferNotification(
        [t({ driveId: "a" }), t({ driveId: "b", completed: true })],
        NOW,
        noName,
      );
      expect(content?.cancelLabel).toBe("Cancel");
    });
  });
});

describe("shouldPostNotification", () => {
  const content: NotificationContent = {
    title: "Receiving a.mp4",
    text: "10%",
    percent: 10,
    cancelLabel: "Cancel",
  };
  const changed: NotificationContent = { ...content, text: "11%", percent: 11 };

  // The label is part of the content, so a second transfer starting counts as
  // changed content rather than being dropped as identical — a button whose
  // label lags the action it performs is the trap the label prevents.
  //
  // Asserted past the throttle window: a label-only change is rate-limited
  // like any other, and the two suppressions are independent. The pair below
  // isolates the equality check — same elapsed time, only the label differs.
  it("treats a cancel-label change as changed content, not identical", () => {
    const later = NOW + NOTIFICATION_UPDATE_INTERVAL_MS * 10;
    // Identical content is dropped however long it has been.
    expect(shouldPostNotification({ at: NOW, content }, content, later)).toBe(false);
    // The same comparison with only the label differing is not identical.
    const relabelled: NotificationContent = { ...content, cancelLabel: "Cancel all" };
    expect(shouldPostNotification({ at: NOW, content }, relabelled, later)).toBe(true);
  });

  it("always posts the first update of a window", () => {
    expect(shouldPostNotification(null, content, NOW)).toBe(true);
  });

  it("drops identical content however long it has been", () => {
    const last = { at: NOW - 60_000, content };
    expect(shouldPostNotification(last, { ...content }, NOW)).toBe(false);
  });

  it("holds changed content to the interval", () => {
    const last = { at: NOW, content };
    expect(shouldPostNotification(last, changed, NOW + 100)).toBe(false);
    expect(
      shouldPostNotification(last, changed, NOW + NOTIFICATION_UPDATE_INTERVAL_MS)
    ).toBe(true);
  });

  it("does not wedge when the clock moves backwards", () => {
    const last = { at: NOW + 5_000, content };
    expect(shouldPostNotification(last, changed, NOW)).toBe(true);
  });

  it("throttles the engine's 100 ms cadence to roughly one post per second", () => {
    let last: { at: number; content: NotificationContent } | null = null;
    let posts = 0;
    for (let i = 0; i < 100; i++) {
      const now = NOW + i * 100;
      const next: NotificationContent = {
        title: "Receiving a.mp4",
        text: `${i}%`,
        percent: i,
        cancelLabel: "Cancel",
      };
      if (shouldPostNotification(last, next, now)) {
        posts++;
        last = { at: now, content: next };
      }
    }
    // 10 s of events at 10/s would be 100 posts unthrottled.
    expect(posts).toBe(10);
  });
});
