import {
  comparePinned,
  PINNING_ENABLED,
  stripStoredPins,
} from "../pinning";

/** Behavioural tests of the switch, its sort level and the migration. */

describe("the switch", () => {
  it("is off", () => {
    expect(PINNING_ENABLED).toBe(false);
  });
});

describe("comparePinned — the sort level", () => {
  /** Both directions, or a constant non-zero comparator would pass. */
  it("ranks a pinned row equal to an unpinned one while the switch is off", () => {
    expect(comparePinned({ isPinned: true }, { isPinned: false })).toBe(0);
    expect(comparePinned({ isPinned: false }, { isPinned: true })).toBe(0);
  });

  it("ranks two rows with the same flag equal", () => {
    expect(comparePinned({ isPinned: true }, { isPinned: true })).toBe(0);
    expect(comparePinned({ isPinned: false }, { isPinned: false })).toBe(0);
  });

  it("treats an absent flag the same as false", () => {
    expect(comparePinned({}, { isPinned: true })).toBe(0);
    expect(comparePinned({ isPinned: true }, {})).toBe(0);
  });

  /** The call-site consequence `MainScreen.tsx` cannot assert about itself. */
  it("leaves a pinned-plus-recency sort in pure recency order", () => {
    const rows = [
      { id: "old-pinned", isPinned: true, lastActivityAt: 100 },
      { id: "new-plain", isPinned: false, lastActivityAt: 300 },
      { id: "mid-pinned", isPinned: true, lastActivityAt: 200 },
    ];
    const sorted = [...rows].sort((a, b) => {
      const pinned = comparePinned(a, b);
      if (pinned !== 0) return pinned;
      return b.lastActivityAt - a.lastActivityAt;
    });
    expect(sorted.map((r) => r.id)).toEqual([
      "new-plain",
      "mid-pinned",
      "old-pinned",
    ]);
  });
});

describe("stripStoredPins — the one-time migration", () => {
  it("removes the key, leaving no `isPinned` at all", () => {
    const out = stripStoredPins([{ driveId: "a", isPinned: true }]);
    expect(out.cleared).toBe(1);
    expect(out.records[0]).not.toHaveProperty("isPinned");
  });

  /** The key is retired, not the value: `false` left behind never settles. */
  it("removes the key even when it was already false", () => {
    const out = stripStoredPins([{ driveId: "a", isPinned: false }]);
    expect(out.cleared).toBe(1);
    expect(out.records[0]).not.toHaveProperty("isPinned");
  });

  it("NEVER drops a record — length is preserved", () => {
    const stored = [
      { driveId: "a", isPinned: true },
      { driveId: "b" },
      { driveId: "c", isPinned: false },
    ];
    const out = stripStoredPins(stored);
    expect(out.records).toHaveLength(3);
    expect(out.records.map((r) => (r as { driveId: string }).driveId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  /** `upsertFlags` prunes all-default entries on write; the migration must not. */
  it("keeps a record whose only flag was the pin", () => {
    const out = stripStoredPins([{ driveId: "only-pinned", isPinned: true }]);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toEqual({ driveId: "only-pinned" });
  });

  it("NEVER changes any other field, including ones it does not know", () => {
    const stored = [
      {
        shareKey: "f".repeat(64),
        shareName: "Holiday photos",
        isPinned: true,
        isFavorite: true,
        files: [{ name: "a.jpg", size: 10 }],
        driveId: "drive-7",
        downloadFolder: "/sdcard/x",
        aFieldFromTheFuture: { nested: [1, 2, 3] },
      },
    ];
    const before = JSON.parse(JSON.stringify(stored[0]));
    const out = stripStoredPins(stored);
    const after = out.records[0] as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      if (key === "isPinned") continue;
      expect(after[key]).toEqual(before[key]);
    }
    // And nothing new was invented.
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter((k) => k !== "isPinned")
        .sort()
    );
  });

  it("does not mutate its input", () => {
    const stored = [{ driveId: "a", isPinned: true }];
    stripStoredPins(stored);
    expect(stored[0]).toHaveProperty("isPinned", true);
  });

  /** Idempotence is what makes it safe on every load; callers skip 0. */
  it("is idempotent — a second pass clears nothing", () => {
    const first = stripStoredPins([
      { driveId: "a", isPinned: true },
      { driveId: "b", isFavorite: true },
    ]);
    expect(first.cleared).toBe(1);
    const second = stripStoredPins(first.records);
    expect(second.cleared).toBe(0);
    expect(second.records).toEqual(first.records);
  });

  it("reports 0 for a store that never had a pin", () => {
    const stored = [{ driveId: "a", isFavorite: true }, { driveId: "b" }];
    expect(stripStoredPins(stored).cleared).toBe(0);
  });

  it("counts only the records that carried the key", () => {
    const out = stripStoredPins([
      { driveId: "a", isPinned: true },
      { driveId: "b" },
      { driveId: "c", isPinned: false },
      { driveId: "d", isFavorite: true },
    ]);
    expect(out.cleared).toBe(2);
  });

  it("passes non-object entries through untouched", () => {
    const stored = [null, 7, "x", undefined, { driveId: "a", isPinned: true }];
    const out = stripStoredPins(stored);
    expect(out.cleared).toBe(1);
    expect(out.records.slice(0, 4)).toEqual([null, 7, "x", undefined]);
  });

  it("handles an empty store", () => {
    expect(stripStoredPins([])).toEqual({ records: [], cleared: 0 });
  });
});
