import {
  describeNotificationRows,
  formatNotificationBytes,
  joinNames,
  NAME_LIST_MAX_CHARS,
  PROGRESS_INDETERMINATE,
  PROGRESS_NONE,
  selectReceivingCancelTargets,
  type NotificationTransferInput,
} from "../notificationContent";

/** The two rows as content. That Kotlin renders them needs a device. */

const NOW = 1_700_000_000_000;

/** A receive with a sender attached: `classifyTransfer` → "download". */
function download(
  over: Partial<NotificationTransferInput> = {}
): NotificationTransferInput {
  return {
    driveId: "drive-recv",
    origin: "received",
    completed: false,
    stalled: false,
    peersConnected: 1,
    lastPeerLeftAt: null,
    bytesTransferred: 0,
    totalBytes: null,
    driveSize: null,
    ...over,
  };
}

/** A hosted share with a peer attached: `classifyTransfer` → "upload". */
function serving(
  over: Partial<NotificationTransferInput> = {}
): NotificationTransferInput {
  return {
    driveId: "drive-host",
    origin: "hosted",
    completed: false,
    stalled: false,
    peersConnected: 1,
    lastPeerLeftAt: null,
    bytesTransferred: 0,
    totalBytes: null,
    driveSize: null,
    ...over,
  };
}

/** In its grace window: no peer, but the service is held, so a row may exist. */
function hostInGrace(
  over: Partial<NotificationTransferInput> = {}
): NotificationTransferInput {
  return {
    ...serving({ peersConnected: 0, lastPeerLeftAt: NOW - 1000 }),
    ...over,
  };
}

/** Resolver built from a plain map, missing by default. */
function namesFrom(map: Record<string, string[]>) {
  return (driveId: string) => map[driveId] ?? [];
}
const noNames = () => [] as string[];

describe("nothing active", () => {
  it("returns no rows and no service row", () => {
    expect(describeNotificationRows([], NOW, noNames)).toEqual({
      receiving: null,
      sharing: null,
      serviceRow: null,
    });
  });

  /** An idle share holds no service, so it must produce no row. */
  it("produces no Sharing row for an idle hosted share", () => {
    const idle = serving({ peersConnected: 0, lastPeerLeftAt: null });
    const rows = describeNotificationRows([idle], NOW, noNames);
    expect(rows).toEqual({ receiving: null, sharing: null, serviceRow: null });
  });
});

describe("the Receiving row — singular and plural", () => {
  it("says `1 file` for one file", () => {
    const rows = describeNotificationRows(
      [download()],
      NOW,
      namesFrom({ "drive-recv": ["holiday.jpg"] })
    );
    expect(rows.receiving?.title).toBe("Receiving 1 file");
    expect(rows.receiving?.text).toBe("holiday.jpg");
  });

  it("says `3 files` for three files in one share", () => {
    const rows = describeNotificationRows(
      [download()],
      NOW,
      namesFrom({ "drive-recv": ["a.jpg", "b.pdf", "c.mp4"] })
    );
    expect(rows.receiving?.title).toBe("Receiving 3 files");
    expect(rows.receiving?.text).toBe("a.jpg, b.pdf, c.mp4");
  });

  /** "It covers every active download, across all shares." */
  it("covers downloads across several shares in one row", () => {
    const rows = describeNotificationRows(
      [
        download({ driveId: "d1" }),
        download({ driveId: "d2" }),
      ],
      NOW,
      namesFrom({ d1: ["one.txt"], d2: ["two.txt", "three.txt"] })
    );
    expect(rows.receiving?.title).toBe("Receiving 3 files");
    expect(rows.receiving?.text).toBe("one.txt, two.txt, three.txt");
  });

  /** The manifest carries no received drive mid-download, so the row falls back
   * to a transfer count and still reads correctly. */
  it("degrades to a transfer count and Connecting… with no names", () => {
    const rows = describeNotificationRows([download()], NOW, noNames);
    expect(rows.receiving?.title).toBe("Receiving 1 file");
    expect(rows.receiving?.text).toBe("Connecting…");
  });

  it("drops empty and whitespace-only names before counting", () => {
    const rows = describeNotificationRows(
      [download()],
      NOW,
      namesFrom({ "drive-recv": ["a.jpg", "   ", "", "b.jpg"] })
    );
    expect(rows.receiving?.title).toBe("Receiving 2 files");
    expect(rows.receiving?.text).toBe("a.jpg, b.jpg");
  });

  it("is absent when no download is running", () => {
    const rows = describeNotificationRows([serving()], NOW, noNames);
    expect(rows.receiving).toBeNull();
  });
});

describe("truncation", () => {
  it("leaves a short list alone", () => {
    expect(joinNames(["a.jpg", "b.pdf"])).toBe("a.jpg, b.pdf");
  });

  it("leaves a list that is an exact fit alone, with no ellipsis", () => {
    // Exactly NAME_LIST_MAX_CHARS once joined.
    const exact = ["x".repeat(29), "y".repeat(29)];
    const joined = joinNames(exact);
    expect(joined).toHaveLength(NAME_LIST_MAX_CHARS);
    expect(joined).toBe(`${"x".repeat(29)}, ${"y".repeat(29)}`);
    expect(joined.endsWith("…")).toBe(false);
  });

  it("leaves a list one character under the limit alone", () => {
    const joined = joinNames(["x".repeat(29), "y".repeat(28)]);
    expect(joined).toHaveLength(NAME_LIST_MAX_CHARS - 1);
    expect(joined.endsWith("…")).toBe(false);
  });

  /** At most the limit: a cut landing on a separator trims shorter. */
  it("cuts a long list and ends in an ellipsis, never longer than the limit", () => {
    const joined = joinNames([
      "chapter-one-the-beginning.pdf",
      "chapter-two-the-middle.pdf",
      "chapter-three-the-end.pdf",
    ]);
    expect(joined.length).toBeLessThanOrEqual(NAME_LIST_MAX_CHARS);
    expect(joined.endsWith("…")).toBe(true);
    // The dropped name is genuinely gone, not silently half-rendered.
    expect(joined).toBe(
      "chapter-one-the-beginning.pdf, chapter-two-the-middle.pdf…"
    );
  });

  it("cuts one very long name", () => {
    const joined = joinNames([`${"q".repeat(200)}.bin`]);
    expect(joined).toHaveLength(NAME_LIST_MAX_CHARS);
    expect(joined).toBe(`${"q".repeat(NAME_LIST_MAX_CHARS - 1)}…`);
  });

  /** Never `a.jpg, …` — the separator is trimmed before the ellipsis. */
  it("trims a trailing separator before the ellipsis", () => {
    // 58 characters, then ", " lands exactly at the cut boundary.
    const joined = joinNames(["z".repeat(58), "tail.pdf"]);
    expect(joined).toBe(`${"z".repeat(58)}…`);
    expect(joined).not.toContain(", …");
  });

  it("returns an empty string for no names", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["", "  "])).toBe("");
  });
});

describe("sizes", () => {
  function sublineFor(bytes: number, total: number | null): string {
    const rows = describeNotificationRows(
      [download({ bytesTransferred: bytes, totalBytes: total })],
      NOW,
      noNames
    );
    return rows.receiving?.subline ?? "";
  }

  it("renders bytes", () => {
    expect(sublineFor(512, 1000)).toBe("512 B of 1000 B");
  });

  it("renders kilobytes", () => {
    expect(sublineFor(2048, 8192)).toBe("2 KB of 8 KB");
  });

  it("renders megabytes", () => {
    expect(sublineFor(120 * 1024 * 1024, 450 * 1024 * 1024)).toBe(
      "120 MB of 450 MB"
    );
  });

  it("renders gigabytes, keeping a fractional digit", () => {
    expect(sublineFor(1.5 * 1024 ** 3, 3 * 1024 ** 3)).toBe("1.5 GB of 3 GB");
  });

  /** The unknown-total branch: `X received`, and a sweeping bar. */
  it("renders an unknown total as `received`, with an indeterminate bar", () => {
    const rows = describeNotificationRows(
      [download({ bytesTransferred: 120 * 1024 * 1024, totalBytes: null })],
      NOW,
      noNames
    );
    expect(rows.receiving?.subline).toBe("120 MB received");
    expect(rows.receiving?.percent).toBe(PROGRESS_INDETERMINATE);
  });

  it("falls back to driveSize when totalBytes is absent", () => {
    expect(
      describeNotificationRows(
        [download({ bytesTransferred: 50, totalBytes: null, driveSize: 200 })],
        NOW,
        noNames
      ).receiving?.subline
    ).toBe("50 B of 200 B");
  });

  /** A partial sum is confidently wrong, which is worse than a sweeping bar. */
  it("goes indeterminate when only SOME downloads know their total", () => {
    const rows = describeNotificationRows(
      [
        download({ driveId: "d1", bytesTransferred: 100, totalBytes: 1000 }),
        download({ driveId: "d2", bytesTransferred: 50, totalBytes: null }),
      ],
      NOW,
      noNames
    );
    expect(rows.receiving?.percent).toBe(PROGRESS_INDETERMINATE);
    expect(rows.receiving?.subline).toBe("150 B received");
  });

  it("computes a determinate percentage from the summed totals", () => {
    const rows = describeNotificationRows(
      [
        download({ driveId: "d1", bytesTransferred: 100, totalBytes: 200 }),
        download({ driveId: "d2", bytesTransferred: 50, totalBytes: 200 }),
      ],
      NOW,
      noNames
    );
    expect(rows.receiving?.percent).toBe(38);
  });

  /** `NaN` is a `number`. This is where that stops. */
  it("treats a NaN byte count as zero rather than producing NaN", () => {
    const rows = describeNotificationRows(
      [download({ bytesTransferred: Number.NaN, totalBytes: 1000 })],
      NOW,
      noNames
    );
    expect(rows.receiving?.percent).toBe(0);
    expect(rows.receiving?.subline).toBe("0 B of 1000 B");
  });

  it("drops a trailing .0 but keeps a real fraction", () => {
    expect(formatNotificationBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatNotificationBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatNotificationBytes(0)).toBe("0 B");
    expect(formatNotificationBytes(null)).toBe("0 B");
  });
});

describe("the Sharing row — zero peers and N peers", () => {
  it("says shares are ready when nobody is downloading", () => {
    const rows = describeNotificationRows([hostInGrace()], NOW, noNames);
    expect(rows.sharing).toEqual({
      title: "Shares are ready to download",
      text: "No requests yet…",
      subline: "",
      percent: PROGRESS_NONE,
    });
  });

  it("says `1 pear is` for one downloader", () => {
    const rows = describeNotificationRows(
      [serving()],
      NOW,
      namesFrom({ "drive-host": ["Holiday photos"] })
    );
    expect(rows.sharing?.title).toBe("1 pear is receiving from you");
    expect(rows.sharing?.text).toBe("Holiday photos");
  });

  it("says `3 pears are` for three downloaders on one share", () => {
    const rows = describeNotificationRows(
      [serving({ peersConnected: 3 })],
      NOW,
      namesFrom({ "drive-host": ["Holiday photos"] })
    );
    expect(rows.sharing?.title).toBe("3 pears are receiving from you");
  });

  /** Each share is its own swarm, and no stable cross-swarm identity exists to
   * deduplicate on, so one phone on two shares counts twice. */
  it("sums peers across shares, so one phone on two shares reads as 2", () => {
    const rows = describeNotificationRows(
      [
        serving({ driveId: "h1", peersConnected: 1 }),
        serving({ driveId: "h2", peersConnected: 1 }),
      ],
      NOW,
      namesFrom({ h1: ["Photos"], h2: ["Docs"] })
    );
    expect(rows.sharing?.title).toBe("2 pears are receiving from you");
    expect(rows.sharing?.text).toBe("Photos, Docs");
  });

  it("names only the shares actually being downloaded", () => {
    const rows = describeNotificationRows(
      [
        serving({ driveId: "busy", peersConnected: 1 }),
        hostInGrace({ driveId: "quiet" }),
      ],
      NOW,
      namesFrom({ busy: ["Photos"], quiet: ["Nobody wants this"] })
    );
    expect(rows.sharing?.text).toBe("Photos");
  });

  it("degrades to a generic line when a share name is unknown", () => {
    const rows = describeNotificationRows([serving()], NOW, noNames);
    expect(rows.sharing?.text).toBe("A share is being downloaded");
  });

  it("truncates a long list of share names", () => {
    const rows = describeNotificationRows(
      [
        serving({ driveId: "h1" }),
        serving({ driveId: "h2" }),
        serving({ driveId: "h3" }),
      ],
      NOW,
      namesFrom({
        h1: ["The first very long share name indeed"],
        h2: ["The second very long share name indeed"],
        h3: ["The third"],
      })
    );
    expect(rows.sharing?.text).toHaveLength(NAME_LIST_MAX_CHARS);
    expect(rows.sharing?.text.endsWith("…")).toBe(true);
  });

  /** A receive-only user has no shares, so there is no Sharing row at all. */
  it("is absent when there is no hosted share", () => {
    const rows = describeNotificationRows([download()], NOW, noNames);
    expect(rows.sharing).toBeNull();
  });

  it("never carries a progress bar", () => {
    for (const list of [[serving()], [hostInGrace()]]) {
      const rows = describeNotificationRows(list, NOW, noNames);
      expect(rows.sharing?.percent).toBe(PROGRESS_NONE);
      expect(rows.sharing?.subline).toBe("");
    }
  });
});

describe("which row is the service row", () => {
  it("is Receiving while a download is running", () => {
    expect(describeNotificationRows([download()], NOW, noNames).serviceRow).toBe(
      "receiving"
    );
  });

  it("is Receiving even when a share is also being served", () => {
    const rows = describeNotificationRows(
      [download(), serving()],
      NOW,
      noNames
    );
    expect(rows.serviceRow).toBe("receiving");
    // Both rows exist — this is the two-row case from the phone checklist.
    expect(rows.receiving).not.toBeNull();
    expect(rows.sharing).not.toBeNull();
  });

  it("is Sharing when only a share is active", () => {
    expect(describeNotificationRows([serving()], NOW, noNames).serviceRow).toBe(
      "sharing"
    );
  });

  it("is Sharing for a share inside its grace window", () => {
    expect(
      describeNotificationRows([hostInGrace()], NOW, noNames).serviceRow
    ).toBe("sharing");
  });

  it("is null when there is nothing to post", () => {
    expect(describeNotificationRows([], NOW, noNames).serviceRow).toBeNull();
  });
});

describe("the split cancel", () => {
  /** Cancel receiving never reaches the hosting stop path. */
  it("returns only download drive ids, never a hosted one", () => {
    const targets = selectReceivingCancelTargets(
      [
        download({ driveId: "recv-1" }),
        serving({ driveId: "host-1" }),
        download({ driveId: "recv-2" }),
        hostInGrace({ driveId: "host-2" }),
      ],
      NOW
    );
    expect(targets).toEqual(["recv-1", "recv-2"]);
    expect(targets).not.toContain("host-1");
    expect(targets).not.toContain("host-2");
  });

  it("returns nothing when only shares are active, so hosting cannot be stopped", () => {
    expect(
      selectReceivingCancelTargets(
        [serving({ driveId: "host-1" }), hostInGrace({ driveId: "host-2" })],
        NOW
      )
    ).toEqual([]);
  });

  /** An `unknown` origin with a peer is hosting, or a transient origin reopens it. */
  it("excludes an unknown-origin transfer with a peer attached", () => {
    expect(
      selectReceivingCancelTargets(
        [serving({ driveId: "mystery", origin: "unknown" })],
        NOW
      )
    ).toEqual([]);
  });

  it("returns nothing for an empty list", () => {
    expect(selectReceivingCancelTargets([], NOW)).toEqual([]);
  });

  it("skips a completed download", () => {
    expect(
      selectReceivingCancelTargets(
        [download({ driveId: "done", completed: true })],
        NOW
      )
    ).toEqual([]);
  });

  /** The row's set and its Cancel's set are one, or the button overreaches. */
  it("matches the Receiving row's own set", () => {
    const list = [
      download({ driveId: "r1" }),
      serving({ driveId: "h1" }),
      download({ driveId: "r2" }),
    ];
    const rows = describeNotificationRows(list, NOW, noNames);
    const targets = selectReceivingCancelTargets(list, NOW);
    expect(rows.receiving?.title).toBe("Receiving 2 files");
    expect(targets).toHaveLength(2);
  });
});
