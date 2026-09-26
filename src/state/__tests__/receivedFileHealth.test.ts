/**
 * The row must stop claiming a file is on the device when it is not, and a
 * recovered grab must become visible.
 *
 * The real `src/lib/receivedFileHealth.ts`, `src/state/receivedSharesStorage.ts`
 * and `src/state/reconcileReceivedRunner.ts` run; only `react-native-fs` and
 * `../../lib/debugLog` are replaced. The `.tsx` call sites are out of reach,
 * so what is asserted is the decision they delegate to.
 */

import { demoteMissingFile, healShareFiles } from "../../lib/receivedFileHealth";

type FakeFs = { files: Record<string, string> };

// eslint-disable-next-line no-var
var mockFs: FakeFs = { files: {} };
// eslint-disable-next-line no-var
var mockLogs: string[] = [];

jest.mock("react-native-fs", () => {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(mockFs.files, p);
  return {
    DocumentDirectoryPath: "/data/user/0/com.peardrop/files",
    CachesDirectoryPath: "/data/user/0/com.peardrop/cache",
    exists: async (p: string) => has(p),
    readFile: async (p: string) => {
      if (!has(p)) throw new Error(`ENOENT: ${p}`);
      return mockFs.files[p] ?? "";
    },
    writeFile: async (p: string, c: string) => {
      mockFs.files[p] = c;
    },
    moveFile: async (from: string, to: string) => {
      if (!has(from)) throw new Error(`ENOENT: ${from}`);
      mockFs.files[to] = mockFs.files[from] ?? "";
      delete mockFs.files[from];
    },
    unlink: async (p: string) => {
      if (!has(p)) throw new Error(`ENOENT: ${p}`);
      delete mockFs.files[p];
    },
  };
});

jest.mock("../../lib/debugLog", () => ({
  log: (level: string, tag: string, msg: string) => {
    mockLogs.push(`${level} ${tag} ${msg}`);
  },
  logDebug: () => {},
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
  logStructuredError: () => {},
}));

const fs = mockFs;
const logs = mockLogs;
const DOCS = "/data/user/0/com.peardrop/files";
const SHARES_FILE = `${DOCS}/peardrop-received-shares.json`;
const MIGRATION_FLAG = `${DOCS}/peardrop-shares-migrated.flag`;
const INDEX = `${DOCS}/peardrop-received-files.json`;
const DOWNLOADS = `${DOCS}/peardrop/downloads`;

const KEY = "a".repeat(64);
const LINK = `peardrop://${KEY}`;
const HOLIDAY = `${DOWNLOADS}/Trip/holiday.jpg`;
const NOTES = `${DOWNLOADS}/Trip/notes.txt`;

function freshShares() {
  let mod!: typeof import("../receivedSharesStorage");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../receivedSharesStorage");
  });
  return mod;
}

function freshRunner() {
  let mod!: typeof import("../reconcileReceivedRunner");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../reconcileReceivedRunner");
  });
  return mod;
}

function seedShareRecord(files: unknown[]) {
  fs.files[MIGRATION_FLAG] = "1";
  fs.files[SHARES_FILE] = JSON.stringify([
    {
      shareKey: KEY,
      shareLink: LINK,
      shareName: "Trip",
      firstSeenAt: 1,
      lastUpdatedAt: 1,
      files,
    },
  ]);
}

beforeEach(() => {
  for (const k of Object.keys(fs.files)) delete fs.files[k];
  logs.length = 0;
});

describe("a stored flag is not evidence the file is there", () => {
  /**
   * THE PROBE for the latch. Pre-fix `reconcileShareRecord` carried
   * `isDownloaded: true` forward whenever a prior record had a `localPath`,
   * with no filesystem call anywhere in `receivedSharesStorage`. This is that
   * decision, now isolated: with the file absent the flag must not survive.
   */
  it("retracts isDownloaded when the recorded path is gone", () => {
    const healed = healShareFiles({
      manifestFiles: [{ name: "holiday.jpg", size: 9 }],
      prior: [
        { name: "holiday.jpg", size: 9, isDownloaded: true, localPath: HOLIDAY },
      ],
      isOnDisk: () => false,
    });
    expect(healed.files[0]?.isDownloaded).toBe(false);
    expect(healed.files[0]?.localPath).toBeUndefined();
    expect(healed.demoted).toEqual([HOLIDAY]);
  });

  /**
   * Collapsing a thrown `RNFS.exists` into `false` reads one transient i/o
   * error as "the file is gone": the entry is demoted and its `localPath`
   * stripped, leaving bytes on disk that nothing can unlink, because delete
   * looks the path up on the record. An unanswered probe must cost nothing.
   */
  it("holds the record when the probe cannot answer, rather than assuming gone", () => {
    const healed = healShareFiles({
      manifestFiles: [{ name: "holiday.jpg", size: 9 }],
      prior: [
        { name: "holiday.jpg", size: 9, isDownloaded: true, localPath: HOLIDAY },
      ],
      // `undefined` = the probe threw. Not `false`, which means proven absent.
      isOnDisk: () => undefined,
    });
    expect(healed.files[0]?.isDownloaded).toBe(true);
    // The path must survive, or Delete can never reach the bytes.
    expect(healed.files[0]?.localPath).toBe(HOLIDAY);
    expect(healed.demoted).toEqual([]);
  });

  it("keeps isDownloaded when the file really is there", () => {
    const healed = healShareFiles({
      manifestFiles: [{ name: "holiday.jpg", size: 9 }],
      prior: [
        {
          name: "holiday.jpg",
          size: 9,
          isDownloaded: true,
          localPath: HOLIDAY,
          downloadedAt: 7,
        },
      ],
      isOnDisk: (p) => p === HOLIDAY,
    });
    expect(healed.files[0]).toEqual({
      name: "holiday.jpg",
      size: 9,
      isDownloaded: true,
      localPath: HOLIDAY,
      downloadedAt: 7,
    });
    expect(healed.demoted).toEqual([]);
  });

  /**
   * The off-manifest branch carried the flag forward with NO check at all —
   * not even the weak one the main branch had. It is the easiest half to miss.
   */
  it("checks files the manifest no longer lists, instead of trusting them", () => {
    const healed = healShareFiles({
      manifestFiles: [{ name: "notes.txt", size: 5 }],
      prior: [
        { name: "gone.bin", size: 3, isDownloaded: true, localPath: `${DOWNLOADS}/gone.bin` },
        { name: "kept.bin", size: 3, isDownloaded: true, localPath: `${DOWNLOADS}/kept.bin` },
      ],
      isOnDisk: (p) => p === `${DOWNLOADS}/kept.bin`,
    });
    expect(healed.files.map((f) => f.name)).toEqual(["notes.txt", "kept.bin"]);
    expect(healed.demoted).toEqual([`${DOWNLOADS}/gone.bin`]);
  });

  it("probes only files that claim to be downloaded", () => {
    const probed: string[] = [];
    healShareFiles({
      manifestFiles: [{ name: "a.txt" }, { name: "b.txt" }],
      prior: [
        { name: "a.txt", size: 1, isDownloaded: false },
        { name: "b.txt", size: 1, isDownloaded: true, localPath: `${DOWNLOADS}/b.txt` },
      ],
      isOnDisk: (p) => {
        probed.push(p);
        return true;
      },
    });
    expect(probed).toEqual([`${DOWNLOADS}/b.txt`]);
  });

  /**
   * THE SECOND PROBE. `markFileMissing` is the only `true → false` transition
   * for `isDownloaded` in the tree; before this task there was none at all, so
   * `previewFile` proved the file was gone and then discarded the finding.
   */
  it("markFileMissing writes the retraction through to disk", async () => {
    seedShareRecord([
      { name: "holiday.jpg", size: 9, isDownloaded: true, localPath: HOLIDAY },
      { name: "notes.txt", size: 5, isDownloaded: true, localPath: NOTES },
    ]);
    const mod = freshShares();
    expect(await mod.markFileMissing(KEY, HOLIDAY)).toBe(true);

    const afterRestart = await freshShares().loadShares();
    const files = afterRestart[0]?.files ?? [];
    expect(files.find((f) => f.name === "holiday.jpg")?.isDownloaded).toBe(false);
    // The sibling is untouched.
    expect(files.find((f) => f.name === "notes.txt")?.isDownloaded).toBe(true);
  });

  it("markFileMissing is a no-op when nothing matches, so it does not churn the store", async () => {
    seedShareRecord([
      { name: "holiday.jpg", size: 9, isDownloaded: true, localPath: HOLIDAY },
    ]);
    const mod = freshShares();
    expect(await mod.markFileMissing(KEY, `${DOWNLOADS}/not-in-this-share.bin`)).toBe(false);
    expect(await mod.markFileMissing("", HOLIDAY)).toBe(false);
    expect(demoteMissingFile([], HOLIDAY)).toBeNull();
  });
});

describe("a recovered grab has to be visible", () => {
  /**
   * THE THIRD PROBE. Pre-fix `runReceivedReconcile` wrote ONLY
   * `appendDownloadResults` — `receivedFilesStorage`, which the rendered list
   * is not built from. The one live path from that store into the list is the
   * one-shot legacy migration, gated behind a flag file that any booted
   * install already has. So recovery landed somewhere nothing renders, and the
   * row went on saying nothing had been downloaded.
   */
  it("writes the recovery into the store the rendered list reads", async () => {
    fs.files[HOLIDAY] = "JPEGBYTES";
    // The share record exists because the resolve upserts it BEFORE the
    // download starts — this is the state a killed grab leaves behind.
    seedShareRecord([
      { name: "holiday.jpg", size: 9, isDownloaded: false },
      { name: "notes.txt", size: 5, isDownloaded: false },
    ]);
    fs.files[INDEX] = JSON.stringify([]);

    const wrote = await freshRunner().runReceivedReconcile(
      [
        {
          id: "drive-1",
          origin: "received",
          shareLink: LINK,
          lastActivityAt: 123,
          localFiles: [{ name: "holiday.jpg", path: HOLIDAY, size: 9 }],
        },
      ],
      "test",
    );
    expect(wrote).toBe(1);

    const shares = await freshShares().loadShares();
    const holiday = shares[0]?.files.find((f) => f.name === "holiday.jpg");
    expect(holiday?.isDownloaded).toBe(true);
    expect(holiday?.localPath).toBe(HOLIDAY);
    // The file that never arrived stays honest.
    expect(shares[0]?.files.find((f) => f.name === "notes.txt")?.isDownloaded).toBe(false);
  });

  it("still writes the legacy index, and logs how many became visible", async () => {
    fs.files[HOLIDAY] = "JPEGBYTES";
    seedShareRecord([{ name: "holiday.jpg", size: 9, isDownloaded: false }]);
    fs.files[INDEX] = JSON.stringify([]);

    await freshRunner().runReceivedReconcile(
      [
        {
          id: "drive-1",
          origin: "received",
          shareLink: LINK,
          lastActivityAt: 123,
          localFiles: [{ name: "holiday.jpg", path: HOLIDAY, size: 9 }],
        },
      ],
      "test",
    );
    expect(fs.files[INDEX]).toContain("holiday.jpg");
    const line = logs.find((l) => l.includes("rn.reconcile"));
    expect(line).toContain("1 shown in the list");
  });

  /**
   * TRIGGER-IS-LIVE, and deliberately left live: `runReceivedReconcile`
   * returns without logging when it wrote nothing, so **the absence of the
   * `rn.reconcile` line is itself the signature**. Changing that would
   * invalidate the diagnostic the task's own verification depends on.
   */
  it("says nothing at all when there was nothing to recover", async () => {
    seedShareRecord([{ name: "holiday.jpg", size: 9, isDownloaded: false }]);
    fs.files[INDEX] = JSON.stringify([]);
    const wrote = await freshRunner().runReceivedReconcile([], "test");
    expect(wrote).toBe(0);
    expect(logs.filter((l) => l.includes("rn.reconcile"))).toEqual([]);
  });

  it("does not invent a share record when the resolve never made one", async () => {
    fs.files[HOLIDAY] = "JPEGBYTES";
    fs.files[MIGRATION_FLAG] = "1";
    fs.files[SHARES_FILE] = JSON.stringify([]);
    fs.files[INDEX] = JSON.stringify([]);

    const wrote = await freshRunner().runReceivedReconcile(
      [
        {
          id: "drive-1",
          origin: "received",
          shareLink: LINK,
          lastActivityAt: 123,
          localFiles: [{ name: "holiday.jpg", path: HOLIDAY, size: 9 }],
        },
      ],
      "test",
    );
    // The index recovery still happens; the share store gains no phantom row.
    expect(wrote).toBe(1);
    expect(await freshShares().loadShares()).toEqual([]);
  });
});
