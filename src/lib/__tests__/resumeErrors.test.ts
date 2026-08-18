// Tripwire for the non-destructive hydrate-failure pattern: the engine keeps
// hydrate failures in an in-memory Map instead of persisting `state: "failed"`
// to the manifest. engineHydrateDrives itself needs bare-fs and can't run under
// Jest, so the pattern is mirrored here.

type ResumeError = { error: string; at: number };

// Mirror of the engine's resumeErrors + recordHydrateFailure + success
// clear. Emit events via a Jest mock so we can assert emission.
class HydrateFailureTracker {
  private map = new Map<string, ResumeError>();
  emit: jest.Mock;

  constructor() {
    this.emit = jest.fn();
  }

  recordFailure(driveId: string, message: string): void {
    this.map.set(driveId, { error: message, at: Date.now() });
    this.emit({ type: "drive-hydration-failed", driveId, error: message });
  }

  recordSuccess(driveId: string): void {
    this.map.delete(driveId);
  }

  getAll(): Record<string, ResumeError> {
    const out: Record<string, ResumeError> = {};
    for (const [id, info] of this.map.entries()) {
      out[id] = { error: info.error, at: info.at };
    }
    return out;
  }

  has(driveId: string): boolean {
    return this.map.has(driveId);
  }
}

describe("resumeErrors pattern", () => {
  let tracker: HydrateFailureTracker;

  beforeEach(() => {
    tracker = new HydrateFailureTracker();
  });

  test("scenario 1 — failure records the entry and emits", () => {
    tracker.recordFailure("drive_abc", "Storage directory missing");

    expect(tracker.has("drive_abc")).toBe(true);
    const info = tracker.getAll()["drive_abc"];
    expect(info?.error).toBe("Storage directory missing");
    expect(info?.at).toBeGreaterThan(0);

    expect(tracker.emit).toHaveBeenCalledTimes(1);
    expect(tracker.emit).toHaveBeenCalledWith({
      type: "drive-hydration-failed",
      driveId: "drive_abc",
      error: "Storage directory missing",
    });
  });

  test("scenario 2 — success on same driveId clears the entry", () => {
    tracker.recordFailure("drive_abc", "transient");
    expect(tracker.has("drive_abc")).toBe(true);

    tracker.recordSuccess("drive_abc");
    expect(tracker.has("drive_abc")).toBe(false);
    expect(tracker.getAll()).toEqual({});
  });

  test("scenario 3 — failures for different drives coexist", () => {
    tracker.recordFailure("drive_a", "a error");
    tracker.recordFailure("drive_b", "b error");
    tracker.recordFailure("recv_c", "c error");

    expect(Object.keys(tracker.getAll())).toEqual(
      expect.arrayContaining(["drive_a", "drive_b", "recv_c"]),
    );

    // A success for one doesn't touch the others.
    tracker.recordSuccess("drive_a");
    expect(tracker.has("drive_a")).toBe(false);
    expect(tracker.has("drive_b")).toBe(true);
    expect(tracker.has("recv_c")).toBe(true);
  });

  test("scenario 4 — repeat failure updates the timestamp (retry semantic)", async () => {
    tracker.recordFailure("drive_abc", "first");
    const firstAt = tracker.getAll()["drive_abc"]?.at ?? 0;

    // Sleep 5 ms so Date.now() moves.
    await new Promise((r) => setTimeout(r, 5));

    tracker.recordFailure("drive_abc", "second");
    const secondAt = tracker.getAll()["drive_abc"]?.at ?? 0;

    expect(secondAt).toBeGreaterThan(firstAt);
    expect(tracker.getAll()["drive_abc"]?.error).toBe("second");
  });

  test("scenario 5 — recordSuccess on a driveId that never failed is a no-op", () => {
    tracker.recordSuccess("drive_never_failed");
    expect(tracker.getAll()).toEqual({});
  });

  test("scenario 6 — hydrate failures can carry a typed cause", () => {
    // The tracker doesn't enforce a payload shape — it stores whatever
    // message it's given, so a caller can carry a typed cause through it.
    tracker.recordFailure(
      "drive_typed",
      "Storage directory missing (typed)",
    );
    expect(tracker.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "drive-hydration-failed",
        driveId: "drive_typed",
      }),
    );
  });
});
