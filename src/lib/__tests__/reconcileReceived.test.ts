import {
  reconcileReceivedFiles,
  type EngineDriveLike,
  type RecordedFileLike,
} from "../reconcileReceived";

const NOW = 1_700_000_000_000;

function drive(over: Partial<EngineDriveLike> = {}): EngineDriveLike {
  return {
    id: "drive_1",
    origin: "received",
    shareLink: "peardrop://aaaa",
    lastActivityAt: NOW - 5_000,
    localFiles: [{ name: "a.txt", path: "/data/dl/a.txt", size: 10 }],
    ...over,
  };
}

function recorded(...paths: string[]): RecordedFileLike[] {
  return paths.map((path) => ({ path }));
}

describe("reconcileReceivedFiles", () => {
  it("returns nothing when the record already has everything", () => {
    const res = reconcileReceivedFiles({
      drives: [drive()],
      recorded: recorded("/data/dl/a.txt"),
      now: NOW,
    });
    expect(res.groups).toEqual([]);
    expect(res.totalFiles).toBe(0);
  });

  it("is idempotent — a second pass over the back-filled record finds nothing", () => {
    const d = drive({
      localFiles: [
        { name: "a.txt", path: "/data/dl/a.txt", size: 10 },
        { name: "b.txt", path: "/data/dl/b.txt", size: 20 },
      ],
    });
    const first = reconcileReceivedFiles({ drives: [d], recorded: [], now: NOW });
    expect(first.totalFiles).toBe(2);

    const backFilled = first.groups.flatMap((g) => g.files.map((f) => ({ path: f.path })));
    const second = reconcileReceivedFiles({ drives: [d], recorded: backFilled, now: NOW });
    expect(second.groups).toEqual([]);
    expect(second.totalFiles).toBe(0);
  });

  it("returns only the subset that is missing", () => {
    const d = drive({
      localFiles: [
        { name: "a.txt", path: "/data/dl/a.txt", size: 10 },
        { name: "b.txt", path: "/data/dl/b.txt", size: 20 },
        { name: "c.txt", path: "/data/dl/c.txt", size: 30 },
      ],
    });
    const res = reconcileReceivedFiles({
      drives: [d],
      recorded: recorded("/data/dl/b.txt"),
      now: NOW,
    });
    expect(res.totalFiles).toBe(2);
    expect(res.groups[0]?.files.map((f) => f.path)).toEqual([
      "/data/dl/a.txt",
      "/data/dl/c.txt",
    ]);
  });

  it("returns everything when the record is empty", () => {
    const res = reconcileReceivedFiles({ drives: [drive()], recorded: [], now: NOW });
    expect(res.totalFiles).toBe(1);
    expect(res.groups[0]).toMatchObject({
      driveId: "drive_1",
      shareLink: "peardrop://aaaa",
      downloadedAt: NOW - 5_000,
    });
    expect(res.groups[0]?.files[0]).toEqual({
      name: "a.txt",
      path: "/data/dl/a.txt",
      size: 10,
    });
  });

  it("keeps same-basename files from different shares distinct", () => {
    const res = reconcileReceivedFiles({
      drives: [
        drive({
          id: "drive_1",
          shareLink: "peardrop://aaaa",
          localFiles: [{ name: "photo.jpg", path: "/data/dl/one/photo.jpg", size: 1 }],
        }),
        drive({
          id: "drive_2",
          shareLink: "peardrop://bbbb",
          localFiles: [{ name: "photo.jpg", path: "/data/dl/two/photo.jpg", size: 2 }],
        }),
      ],
      recorded: [],
      now: NOW,
    });
    // Joining on basename would have dropped one of these.
    expect(res.totalFiles).toBe(2);
    expect(res.groups.map((g) => g.driveId)).toEqual(["drive_1", "drive_2"]);
  });

  it("does not re-propose a same-basename file that IS already recorded", () => {
    const res = reconcileReceivedFiles({
      drives: [
        drive({
          id: "drive_1",
          localFiles: [{ name: "photo.jpg", path: "/data/dl/one/photo.jpg", size: 1 }],
        }),
        drive({
          id: "drive_2",
          localFiles: [{ name: "photo.jpg", path: "/data/dl/two/photo.jpg", size: 2 }],
        }),
      ],
      recorded: recorded("/data/dl/one/photo.jpg"),
      now: NOW,
    });
    expect(res.totalFiles).toBe(1);
    expect(res.groups[0]?.driveId).toBe("drive_2");
  });

  it("collapses a duplicate path appearing on two drives", () => {
    const res = reconcileReceivedFiles({
      drives: [
        drive({ id: "drive_1", localFiles: [{ name: "a.txt", path: "/dup/a.txt", size: 1 }] }),
        drive({ id: "drive_2", localFiles: [{ name: "a.txt", path: "/dup/a.txt", size: 1 }] }),
      ],
      recorded: [],
      now: NOW,
    });
    expect(res.totalFiles).toBe(1);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]?.driveId).toBe("drive_1");
  });

  it("does not resurrect a path listed in ignorePaths", () => {
    const res = reconcileReceivedFiles({
      drives: [
        drive({
          localFiles: [
            { name: "kept.txt", path: "/data/dl/kept.txt", size: 1 },
            { name: "deleted.txt", path: "/data/dl/deleted.txt", size: 2 },
          ],
        }),
      ],
      recorded: [],
      ignorePaths: ["/data/dl/deleted.txt"],
      now: NOW,
    });
    expect(res.totalFiles).toBe(1);
    expect(res.groups[0]?.files.map((f) => f.name)).toEqual(["kept.txt"]);
  });

  it("ignores hosted drives entirely", () => {
    const res = reconcileReceivedFiles({
      drives: [drive({ origin: "hosted" })],
      recorded: [],
      now: NOW,
    });
    expect(res.groups).toEqual([]);
  });

  it("skips drives with no localFiles, and empty input", () => {
    expect(
      reconcileReceivedFiles({ drives: [drive({ localFiles: [] })], recorded: [], now: NOW })
        .groups
    ).toEqual([]);
    expect(
      reconcileReceivedFiles({ drives: [drive({ localFiles: null })], recorded: [], now: NOW })
        .groups
    ).toEqual([]);
    expect(reconcileReceivedFiles({ drives: [], recorded: [], now: NOW }).groups).toEqual([]);
    expect(
      reconcileReceivedFiles({ drives: null, recorded: null, now: NOW })
    ).toEqual({ groups: [], totalFiles: 0 });
  });

  it("skips malformed entries rather than emitting a broken record", () => {
    const res = reconcileReceivedFiles({
      drives: [
        drive({
          localFiles: [
            { name: "ok.txt", path: "/data/dl/ok.txt", size: 5 },
            { name: "no-path.txt", path: "", size: 1 },
            { name: "nully", path: null, size: 1 },
          ],
        }),
        drive({ id: "", localFiles: [{ name: "x.txt", path: "/x.txt", size: 1 }] }),
      ],
      recorded: [],
      now: NOW,
    });
    expect(res.totalFiles).toBe(1);
    expect(res.groups[0]?.files[0]?.name).toBe("ok.txt");
  });

  it("derives a basename when the engine name is missing or path-shaped", () => {
    const res = reconcileReceivedFiles({
      drives: [
        drive({
          localFiles: [
            { path: "/data/dl/derived.txt", size: 1 },
            { name: "/leading/slash/full.txt", path: "/data/dl/full.txt", size: 2 },
          ],
        }),
      ],
      recorded: [],
      now: NOW,
    });
    expect(res.groups[0]?.files.map((f) => f.name)).toEqual(["derived.txt", "full.txt"]);
  });

  it("falls back through lastActivityAt -> createdAt -> now for the timestamp", () => {
    const withCreated = reconcileReceivedFiles({
      drives: [drive({ lastActivityAt: null, createdAt: NOW - 99 })],
      recorded: [],
      now: NOW,
    });
    expect(withCreated.groups[0]?.downloadedAt).toBe(NOW - 99);

    const withNeither = reconcileReceivedFiles({
      drives: [drive({ lastActivityAt: null, createdAt: null })],
      recorded: [],
      now: NOW,
    });
    expect(withNeither.groups[0]?.downloadedAt).toBe(NOW);
  });

  it("defaults a missing size to 0 rather than undefined", () => {
    const res = reconcileReceivedFiles({
      drives: [drive({ localFiles: [{ name: "a.txt", path: "/a.txt" }] })],
      recorded: [],
      now: NOW,
    });
    expect(res.groups[0]?.files[0]?.size).toBe(0);
  });
});
