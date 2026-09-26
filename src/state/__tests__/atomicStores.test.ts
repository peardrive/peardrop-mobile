/**
 * A torn write must not empty a store. The real `src/state/*Storage.ts` and
 * `src/lib/atomicFile.ts` run; only the platform boundary is faked.
 *
 * `tearNextWriteTo(path)` makes the next `writeFile` whose destination is
 * `path` write a truncated prefix of its payload and then reject, which is
 * what the filesystem is left holding when the process dies part-way through
 * `RNFS.writeFile`. A fake that rejects without writing would prove nothing.
 */

type FakeFs = {
  files: Record<string, string>;
  tearNext: string | null;
  failReadOf: string | null;
  failExistsOf: string | null;
};

// `mock`-prefixed so jest's hoisted `jest.mock` factories may close over them.
// eslint-disable-next-line no-var
var mockFs: FakeFs = {
  files: {},
  tearNext: null,
  failReadOf: null,
  failExistsOf: null,
};
// eslint-disable-next-line no-var
var mockLogs: string[] = [];

jest.mock("react-native-fs", () => {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(mockFs.files, p);
  return {
    DocumentDirectoryPath: "/docs",
    CachesDirectoryPath: "/cache",
    exists: async (p: string) => {
      if (mockFs.failExistsOf === p) throw new Error("EIO: exists failed");
      return has(p);
    },
    readFile: async (p: string) => {
      if (mockFs.failReadOf === p) throw new Error("EACCES: permission denied");
      if (!has(p)) throw new Error(`ENOENT: ${p}`);
      return mockFs.files[p] ?? "";
    },
    writeFile: async (p: string, c: string) => {
      if (mockFs.tearNext === p) {
        mockFs.tearNext = null;
        // Half the bytes land, then the process dies.
        mockFs.files[p] = c.slice(0, Math.floor(c.length / 2));
        throw new Error("EIO: torn write");
      }
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
  logWarn: (tag: string, msg: string) => {
    mockLogs.push(`warn ${tag} ${msg}`);
  },
  logError: () => {},
  logStructuredError: (tag: string, context: string) => {
    mockLogs.push(`error ${tag} ${context}`);
  },
}));

const fs = mockFs;
const logs = mockLogs;

const SHARES_FILE = "/docs/peardrop-received-shares.json";
const MIGRATION_FLAG = "/docs/peardrop-shares-migrated.flag";
const FLAGS_FILE = "/docs/peardrop-hosted-flags.json";

function shareRecord(key: string, name: string) {
  return {
    shareKey: key,
    shareLink: `peardrop://${key}`,
    shareName: name,
    firstSeenAt: 1,
    lastUpdatedAt: 1,
    files: [{ name: "a.txt", size: 10, isDownloaded: false }],
  };
}

/** A fresh copy of the store module, with its module-level cache empty. */
function freshShares() {
  let mod!: typeof import("../receivedSharesStorage");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../receivedSharesStorage");
  });
  return mod;
}

function freshHostedFlags() {
  let mod!: typeof import("../hostedShareFlagsStorage");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../hostedShareFlagsStorage");
  });
  return mod;
}

beforeEach(() => {
  for (const k of Object.keys(fs.files)) delete fs.files[k];
  fs.tearNext = null;
  fs.failReadOf = null;
  fs.failExistsOf = null;
  logs.length = 0;
  // Skip the one-shot legacy migration — it is not what these probes are about,
  // and its own writes would otherwise share the torn-write arming.
  fs.files[MIGRATION_FLAG] = "1";
});

describe("a torn store write must not empty the store", () => {
  /**
   * THE PROBE. Pre-fix this fails on the assertion below, not on an import:
   * `receivedSharesStorage.writeToDisk` called `RNFS.writeFile` straight onto
   * the final path, so the truncated payload IS the store, and the next read's
   * `JSON.parse` throws into `catch { return []; }`.
   */
  it("keeps the previous contents when a write is killed part-way through", async () => {
    fs.files[SHARES_FILE] = JSON.stringify([shareRecord("a".repeat(64), "Keep me")]);

    const first = freshShares();
    expect((await first.loadShares()).map((s) => s.shareName)).toEqual(["Keep me"]);

    fs.tearNext = SHARES_FILE;
    await first.upsertShare(shareRecord("b".repeat(64), "New one") as never).catch(() => {});

    // The process died. Everything in memory is gone; only disk survives.
    const afterRestart = freshShares();
    const survived = await afterRestart.loadShares();
    expect(survived.map((s) => s.shareName)).toContain("Keep me");
    expect(survived).not.toHaveLength(0);
  });

  it("leaves no readable store file half-written", async () => {
    fs.files[SHARES_FILE] = JSON.stringify([shareRecord("a".repeat(64), "Keep me")]);
    const mod = freshShares();
    await mod.loadShares();

    fs.tearNext = SHARES_FILE;
    await mod.upsertShare(shareRecord("b".repeat(64), "New one") as never).catch(() => {});

    // Whatever is at the real path must still parse.
    expect(() => JSON.parse(fs.files[SHARES_FILE] ?? "")).not.toThrow();
  });

  it("applies to hostedShareFlagsStorage too", async () => {
    fs.files[FLAGS_FILE] = JSON.stringify([
      { driveId: "drive-1", isPinned: true, isFavorite: false },
    ]);
    const mod = freshHostedFlags();
    expect(await mod.loadHostedFlags()).toHaveLength(1);

    fs.tearNext = FLAGS_FILE;
    await mod.setHostedShareFavorite("drive-1", true).catch(() => {});

    const afterRestart = freshHostedFlags();
    expect(await afterRestart.loadHostedFlags()).toHaveLength(1);
  });
});

describe("an unreadable or corrupt store is preserved, not overwritten", () => {
  /**
   * A parse failure must not return `[]` with no backup, because the next
   * write then puts `[]` over the damaged file. The store is renamed to a
   * `.corrupted-*` file first.
   */
  it("renames a corrupt store aside before anything can overwrite it", async () => {
    fs.files[SHARES_FILE] = "{ this is not json";

    const mod = freshShares();
    expect(await mod.loadShares()).toEqual([]);

    const preserved = Object.keys(fs.files).filter((p) =>
      p.startsWith(`${SHARES_FILE}.corrupted-`),
    );
    expect(preserved).toHaveLength(1);
    expect(fs.files[preserved[0] as string]).toBe("{ this is not json");
  });

  it("renames aside a store that cannot be read at all, and does not call it missing", async () => {
    fs.files[SHARES_FILE] = JSON.stringify([shareRecord("a".repeat(64), "Keep me")]);
    fs.failReadOf = SHARES_FILE;

    const mod = freshShares();
    expect(await mod.loadShares()).toEqual([]);

    const preserved = Object.keys(fs.files).filter((p) =>
      p.startsWith(`${SHARES_FILE}.corrupted-`),
    );
    expect(preserved).toHaveLength(1);
    // The EACCES case must be logged — pre-fix the whole module was silent.
    expect(logs.some((l) => l.startsWith("error rn.store"))).toBe(true);
  });

  it("does not preserve or log anything for a store that was simply never written", async () => {
    const mod = freshShares();
    expect(await mod.loadShares()).toEqual([]);
    expect(Object.keys(fs.files).filter((p) => p.includes(".corrupted-"))).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});
