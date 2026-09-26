/**
 * A received share persists the engine `driveId` it was last opened as and
 * the folder its files were downloaded into. A derived in-memory mapping does
 * not survive a restart, leaving a re-opened share no id to open it by.
 *
 * `upsertShare` merges with `{ ...prev, ...share }`: an omitted key is
 * preserved, but a record carrying `driveId: undefined` explicitly spreads
 * that over the stored value and erases it silently.
 */

type FakeFs = { files: Record<string, string> };

// `mock`-prefixed so jest's hoisted `jest.mock` factories may close over them.
// eslint-disable-next-line no-var
var mockFs: FakeFs = { files: {} };

jest.mock("react-native-fs", () => {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(mockFs.files, p);
  return {
    DocumentDirectoryPath: "/docs",
    CachesDirectoryPath: "/cache",
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
  log: () => {},
  logDebug: () => {},
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
  logStructuredError: () => {},
}));

const fs = mockFs;
const SHARES_FILE = "/docs/peardrop-received-shares.json";
const MIGRATION_FLAG = "/docs/peardrop-shares-migrated.flag";

type StoreModule = typeof import("../receivedSharesStorage");

/** A fresh copy of the store module, with its module-level cache empty. */
function freshStore(): StoreModule {
  let mod!: StoreModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../receivedSharesStorage");
  });
  return mod;
}

function record(key: string, extra: Record<string, unknown> = {}) {
  return {
    shareKey: key,
    shareLink: `peardrop://${key}`,
    shareName: "Holiday photos",
    firstSeenAt: 1,
    lastUpdatedAt: 1,
    files: [
      { name: "a.txt", size: 10, isDownloaded: false },
      { name: "b.txt", size: 20, isDownloaded: false },
    ],
    ...extra,
  } as Parameters<StoreModule["upsertShare"]>[0];
}

beforeEach(() => {
  fs.files = {};
  // The store migrates from a legacy store on first load; the flag short-circuits
  // that so these tests exercise only the read/write path under test.
  fs.files[MIGRATION_FLAG] = "1";
});

describe("the driveId is persisted and survives a reload", () => {
  it("round-trips a driveId through disk, not through an in-memory index", async () => {
    const a = freshStore();
    await a.upsertShare(record("ab12", { driveId: "recv_1700_abcd" }));

    // A SECOND module instance with an empty cache — this is the restart. If the
    // value only lived in a derived Map it would be gone here.
    const b = freshStore();
    const loaded = await b.loadShare("ab12");
    expect(loaded?.driveId).toBe("recv_1700_abcd");
  });

  it("is absent, not empty-string, on a record written before this build", async () => {
    // An older record on disk: no driveId, no downloadFolder.
    fs.files[SHARES_FILE] = JSON.stringify([
      {
        shareKey: "cd34",
        shareLink: "peardrop://cd34",
        shareName: "Old",
        firstSeenAt: 1,
        lastUpdatedAt: 1,
        files: [{ name: "a.txt", size: 1, isDownloaded: true, localPath: "/d/a.txt" }],
      },
    ]);
    const store = freshStore();
    const loaded = await store.loadShare("cd34");
    // "not known" must read as absent. `""` or `null` would read as known-and-empty
    // at every call site, and a caller would open a drive by the empty string.
    expect(loaded).not.toBeNull();
    expect(loaded?.driveId).toBeUndefined();
    expect(loaded?.downloadFolder).toBeUndefined();
  });

  it("rejects a non-string or empty driveId rather than storing a falsehood", async () => {
    fs.files[SHARES_FILE] = JSON.stringify([
      {
        shareKey: "ef56",
        shareLink: "peardrop://ef56",
        shareName: "Junk",
        firstSeenAt: 1,
        lastUpdatedAt: 1,
        files: [],
        driveId: "",
        downloadFolder: 42,
      },
    ]);
    const store = freshStore();
    const loaded = await store.loadShare("ef56");
    expect(loaded?.driveId).toBeUndefined();
    expect(loaded?.downloadFolder).toBeUndefined();
  });
});

describe("a later upsert must not erase the stored driveId", () => {
  it("preserves a stored driveId when a later upsert omits it", async () => {
    const store = freshStore();
    await store.upsertShare(record("ab12", { driveId: "recv_1700_abcd" }));

    // A re-resolve carries a newer manifest and no driveId at all.
    await store.upsertShare(record("ab12", { shareName: "Holiday photos (renamed)" }));

    const loaded = await store.loadShare("ab12");
    expect(loaded?.driveId).toBe("recv_1700_abcd");
    // The re-resolve's newer truth DOES win for the name — this is a targeted
    // preserve, not a blanket one.
    expect(loaded?.shareName).toBe("Holiday photos (renamed)");
  });

  it("preserves it even when the later upsert carries an explicit undefined", async () => {
    const store = freshStore();
    await store.upsertShare(record("ab12", { driveId: "recv_1700_abcd" }));

    // THE REAL CASE. Mapping an engine reply whose field was absent produces a
    // literal with the key present and the value `undefined`, and a plain spread
    // writes that over the stored value.
    await store.upsertShare(record("ab12", { driveId: undefined, downloadFolder: undefined }));

    const loaded = await store.loadShare("ab12");
    expect(loaded?.driveId).toBe("recv_1700_abcd");
  });

  it("lets a genuinely new driveId replace the old one", async () => {
    // The engine mints a fresh driveId per `engineOpenDrive`, so the newest
    // session's id must win. Preserve-on-absent must not become never-update.
    const store = freshStore();
    await store.upsertShare(record("ab12", { driveId: "recv_1_old" }));
    await store.upsertShare(record("ab12", { driveId: "recv_2_new" }));
    const loaded = await store.loadShare("ab12");
    expect(loaded?.driveId).toBe("recv_2_new");
  });
});

describe("the download folder is persisted (D-43)", () => {
  it("rememberDriveSession stores both facts and they survive a reload", async () => {
    const a = freshStore();
    await a.upsertShare(record("ab12"));
    await a.rememberDriveSession("ab12", {
      driveId: "recv_1700_abcd",
      downloadFolder: "/storage/emulated/0/Download/PearDrop",
    });

    const b = freshStore();
    const loaded = await b.loadShare("ab12");
    expect(loaded?.driveId).toBe("recv_1700_abcd");
    expect(loaded?.downloadFolder).toBe("/storage/emulated/0/Download/PearDrop");
  });

  it("does not touch the file list", async () => {
    const store = freshStore();
    await store.upsertShare(record("ab12"));
    const before = (await store.loadShare("ab12"))?.files;
    await store.rememberDriveSession("ab12", { downloadFolder: "/d" });
    const after = (await store.loadShare("ab12"))?.files;
    expect(after).toEqual(before);
  });

  it("ignores empty and null facts rather than storing them", async () => {
    const store = freshStore();
    await store.upsertShare(record("ab12", { downloadFolder: "/real/folder" }));
    await store.rememberDriveSession("ab12", { downloadFolder: "", driveId: null });
    const loaded = await store.loadShare("ab12");
    expect(loaded?.downloadFolder).toBe("/real/folder");
    expect(loaded?.driveId).toBeUndefined();
  });

  it("does not bump lastUpdatedAt when there is nothing new to say", async () => {
    // A grab that reports no destDir must not re-sort the user's list.
    const store = freshStore();
    await store.upsertShare(record("ab12", { driveId: "recv_x", downloadFolder: "/d" }));
    const before = (await store.loadShare("ab12"))?.lastUpdatedAt;
    await store.rememberDriveSession("ab12", { driveId: "recv_x", downloadFolder: "/d" });
    const after = (await store.loadShare("ab12"))?.lastUpdatedAt;
    expect(after).toBe(before);
  });

  it("is a no-op for a share that is not on record", async () => {
    const store = freshStore();
    const list = await store.rememberDriveSession("nope", { driveId: "recv_x" });
    expect(list).toEqual([]);
  });
});
