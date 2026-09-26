/**
 * Tripwire on what Delete does to the manifest entry. The engine module cannot
 * load under jest, so this mirrors `engineStopDrive`'s decision; a mirror that
 * diverges stops catching regressions. Two rules are defended. A drive with no
 * live session is still deletable, since every inactive drive is light-hydrated
 * without one. And the entry goes only when the storage did: dropping it after
 * a failed `fs.rm` orphans a corestore, so a failed purge keeps its tombstone
 * and that tombstone keeps its `storagePath`.
 */

type StopInput = {
  hasSession: boolean;
  hasEntry: boolean;
  /** `opts.purge !== false` — Delete is true, deactivate-style stop is false. */
  purge: boolean;
  /** From the session, else the manifest entry. Null for simulated entries. */
  storagePath: string | null;
  /** Did `fs.rm` resolve? `force: true` also resolves when already absent. */
  rmSucceeds: boolean;
};

type StopOutcome =
  /** `failure("drive.not-active")` — nothing here to delete. */
  | "not-found"
  /** Entry deleted from `manifest.drives`. */
  | "entry-removed"
  /** Entry kept, state PURGED, storagePath retained for a future sweep. */
  | "tombstone-purged"
  /** Entry kept, state STOPPED — the non-destructive stop. */
  | "tombstone-stopped";

/** Mirror of the decision in `engineStopDrive`. */
function stopDriveOutcome(input: StopInput): StopOutcome {
  const { hasSession, hasEntry, purge, storagePath, rmSucceeds } = input;

  if (!hasSession && !hasEntry) return "not-found";

  let storageGone = false;
  if (purge) {
    if (!storagePath) storageGone = true;
    else storageGone = rmSucceeds;
  }

  if (!hasEntry) return "not-found";
  if (purge && storageGone) return "entry-removed";
  return purge ? "tombstone-purged" : "tombstone-stopped";
}

const base: StopInput = {
  hasSession: true,
  hasEntry: true,
  purge: true,
  storagePath: "/data/peardrop/drives/drive_1789823373814_1x6f6hxw",
  rmSucceeds: true,
};

describe("Delete without a live session (the 9J-F-7 regression)", () => {
  test("THE FIX: a sessionless drive with an entry is deleted, not refused", () => {
    expect(stopDriveOutcome({ ...base, hasSession: false })).toBe("entry-removed");
  });

  test("…and behaves identically to the same delete with a session", () => {
    // The session only governs teardown. It must not govern whether the bytes
    // and the entry go.
    expect(stopDriveOutcome({ ...base, hasSession: false })).toBe(
      stopDriveOutcome({ ...base, hasSession: true }),
    );
  });

  test("an unknown id is still refused — the failure is kept on purpose", () => {
    expect(
      stopDriveOutcome({ ...base, hasSession: false, hasEntry: false }),
    ).toBe("not-found");
  });
});

describe("The storage guard (data-loss branch)", () => {
  test("rm failed → entry KEPT as a tombstone, never removed", () => {
    // Removing it here would orphan the corestore permanently.
    expect(stopDriveOutcome({ ...base, rmSucceeds: false })).toBe(
      "tombstone-purged",
    );
  });

  test("rm failed on a sessionless drive → still a tombstone", () => {
    expect(
      stopDriveOutcome({ ...base, hasSession: false, rmSucceeds: false }),
    ).toBe("tombstone-purged");
  });

  test("no storagePath at all → nothing to orphan, entry removed", () => {
    // simulated entries carry `storagePath: null`.
    expect(
      stopDriveOutcome({ ...base, storagePath: null, rmSucceeds: false }),
    ).toBe("entry-removed");
  });

  test("the guard reads the rm RESULT, not merely whether a path existed", () => {
    // Same path, opposite outcomes — so a refactor that drops the result and
    // assumes success fails here rather than in the field.
    const ok = stopDriveOutcome({ ...base, rmSucceeds: true });
    const failed = stopDriveOutcome({ ...base, rmSucceeds: false });
    expect(ok).toBe("entry-removed");
    expect(failed).toBe("tombstone-purged");
    expect(ok).not.toBe(failed);
  });
});

describe("Non-destructive stop is unchanged", () => {
  test("purge:false leaves a STOPPED entry and never removes it", () => {
    expect(stopDriveOutcome({ ...base, purge: false })).toBe("tombstone-stopped");
    expect(stopDriveOutcome({ ...base, purge: false, hasSession: false })).toBe(
      "tombstone-stopped",
    );
  });

  test("purge:false does not touch storage, so rm result is irrelevant", () => {
    expect(
      stopDriveOutcome({ ...base, purge: false, rmSucceeds: false }),
    ).toBe("tombstone-stopped");
  });
});
