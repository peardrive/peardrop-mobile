/**
 * Delete must remove the received files and must not remove the user's own
 * copies. Every assertion runs against the real storage modules and the real
 * `src/lib/deleteReceivedPlan.ts`; only `react-native-fs` and
 * `../../lib/debugLog` are replaced. The probe is `deleteShare`, the symbol
 * the delete path already calls, so a failure lands on an assertion about the
 * filesystem rather than on a missing import.
 */

import { normalizeShareLink } from "../../lib/links";
import {
  appOwnedDownloadsRoot,
  describeDeleteConfirm,
  isAppOwnedCopy,
  planReceivedDelete,
} from "../../lib/deleteReceivedPlan";

type FakeFs = { files: Record<string, string>; unlinkFails: Set<string> };

// eslint-disable-next-line no-var
var mockFs: FakeFs = { files: {}, unlinkFails: new Set<string>() };

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
      if (mockFs.unlinkFails.has(p)) throw new Error("EBUSY");
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
const DOCS = "/data/user/0/com.peardrop/files";
const SHARES_FILE = `${DOCS}/peardrop-received-shares.json`;
const MIGRATION_FLAG = `${DOCS}/peardrop-shares-migrated.flag`;
const INDEX = `${DOCS}/peardrop-received-files.json`;
const DOWNLOADS = `${DOCS}/peardrop/downloads`;
/** Where `saveToDownloads` puts a copy the user asked for. Must survive. */
const USER_COPY = "/storage/emulated/0/Download/PearDrop/holiday.jpg";

const KEY = "a".repeat(64);
const LINK = `peardrop://${KEY}`;
const OTHER_KEY = "b".repeat(64);
const OTHER_LINK = `peardrop://${OTHER_KEY}`;

/** A fresh copy of the share store, with its module-level cache empty. */
function freshShares() {
  let mod!: typeof import("../receivedSharesStorage");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../receivedSharesStorage");
  });
  return mod;
}

function freshIndex() {
  let mod!: typeof import("../receivedFilesStorage");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../receivedFilesStorage");
  });
  return mod;
}

function indexEntry(name: string, dir: string, link?: string) {
  const path = `${DOWNLOADS}/${dir}/${name}`;
  return {
    id: `${name}:${path}`,
    name,
    path,
    type: name.split(".").pop() ?? "file",
    ...(link ? { shareLink: link } : {}),
    downloadedAt: 1,
  };
}

function seed() {
  fs.files[MIGRATION_FLAG] = "1";
  fs.files[`${DOWNLOADS}/Trip/holiday.jpg`] = "JPEGBYTES";
  fs.files[`${DOWNLOADS}/Trip/notes.txt`] = "NOTES";
  fs.files[USER_COPY] = "JPEGBYTES";
  fs.files[SHARES_FILE] = JSON.stringify([
    {
      shareKey: KEY,
      shareLink: LINK,
      shareName: "Trip",
      firstSeenAt: 1,
      lastUpdatedAt: 1,
      files: [
        {
          name: "holiday.jpg",
          size: 9,
          isDownloaded: true,
          localPath: `${DOWNLOADS}/Trip/holiday.jpg`,
        },
        {
          name: "notes.txt",
          size: 5,
          isDownloaded: true,
          localPath: `${DOWNLOADS}/Trip/notes.txt`,
        },
      ],
    },
  ]);
  fs.files[INDEX] = JSON.stringify([
    indexEntry("holiday.jpg", "Trip", LINK),
    indexEntry("notes.txt", "Trip", LINK),
  ]);
}

beforeEach(() => {
  for (const k of Object.keys(fs.files)) delete fs.files[k];
  fs.unlinkFails.clear();
});

describe("the bytes really go", () => {
  /**
   * THE PROBE. Pre-fix `deleteShare` dropped the record and nothing else, so
   * this fails on the two `toBeUndefined` assertions below — against the real
   * store, with the real filesystem calls it makes.
   */
  it("removes the app's own copy of every file in the share", async () => {
    seed();
    const shares = freshShares();
    expect(await shares.loadShares()).toHaveLength(1);

    await shares.deleteShare(KEY);

    expect(fs.files[`${DOWNLOADS}/Trip/holiday.jpg`]).toBeUndefined();
    expect(fs.files[`${DOWNLOADS}/Trip/notes.txt`]).toBeUndefined();
  });

  it("drops the share record too", async () => {
    seed();
    const shares = freshShares();
    await shares.deleteShare(KEY);
    expect(await freshShares().loadShares()).toEqual([]);
  });

  /**
   * THE SECOND HALF, and the reason either fix alone leaves the promise broken:
   * with the index entries still present the dedup probe answers "You've
   * already got these" and the share is un-re-gettable.
   */
  it("leaves the dedup probe with nothing to match, so a re-paste offers the files again", async () => {
    seed();
    await freshShares().deleteShare(KEY);

    const remaining = await freshIndex().loadDownloaded();
    // This is the exact predicate `ShareLinkFlowContext.runResolve` builds its
    // dedup candidates with.
    const candidates = remaining.filter(
      (it) => !!it.shareLink && normalizeShareLink(it.shareLink) === normalizeShareLink(LINK),
    );
    expect(candidates).toEqual([]);
  });

  it("persists the index removal instead of recomputing a tombstone on every read", async () => {
    seed();
    await freshShares().deleteShare(KEY);
    expect(fs.files[INDEX]).not.toContain("holiday.jpg");
    expect(fs.files[INDEX]).not.toContain("notes.txt");
  });

  it("does not abort the rest of the delete when one unlink fails, and reports it", async () => {
    seed();
    fs.unlinkFails.add(`${DOWNLOADS}/Trip/holiday.jpg`);
    const outcome = await freshShares().deleteShare(KEY);

    expect(outcome.failed).toEqual([`${DOWNLOADS}/Trip/holiday.jpg`]);
    expect(outcome.unlinked).toEqual([`${DOWNLOADS}/Trip/notes.txt`]);
    expect(fs.files[`${DOWNLOADS}/Trip/notes.txt`]).toBeUndefined();
    expect(fs.files[`${DOWNLOADS}/Trip/holiday.jpg`]).toBe("JPEGBYTES");
  });

  it("is a no-op on a share key that is not there", async () => {
    seed();
    const outcome = await freshShares().deleteShare(OTHER_KEY);
    expect(outcome.unlinked).toEqual([]);
    expect(fs.files[`${DOWNLOADS}/Trip/holiday.jpg`]).toBe("JPEGBYTES");
    expect(outcome.shares).toHaveLength(1);
  });
});

describe("what Delete must never touch", () => {
  it("leaves the user's own copy in Download/PearDrop alone", async () => {
    seed();
    await freshShares().deleteShare(KEY);
    expect(fs.files[USER_COPY]).toBe("JPEGBYTES");
  });

  it("leaves another share's files completely alone", async () => {
    seed();
    fs.files[`${DOWNLOADS}/Other/doc.pdf`] = "PDF";
    const index = JSON.parse(fs.files[INDEX] as string) as unknown[];
    index.push(indexEntry("doc.pdf", "Other", OTHER_LINK));
    fs.files[INDEX] = JSON.stringify(index);

    await freshShares().deleteShare(KEY);

    expect(fs.files[`${DOWNLOADS}/Other/doc.pdf`]).toBe("PDF");
    const remaining = await freshIndex().loadDownloaded();
    expect(remaining.map((r) => r.name)).toEqual(["doc.pdf"]);
  });

  it("leaves link-less legacy entries alone — their share cannot be identified", async () => {
    seed();
    fs.files[`${DOWNLOADS}/Old/mystery.bin`] = "BIN";
    const index = JSON.parse(fs.files[INDEX] as string) as unknown[];
    index.push(indexEntry("mystery.bin", "Old"));
    fs.files[INDEX] = JSON.stringify(index);

    await freshShares().deleteShare(KEY);
    expect(fs.files[`${DOWNLOADS}/Old/mystery.bin`]).toBe("BIN");
  });

  it("refuses any path outside the app's own downloads directory", () => {
    expect(appOwnedDownloadsRoot(DOCS)).toBe(DOWNLOADS);
    expect(isAppOwnedCopy(`${DOWNLOADS}/Trip/a.jpg`, DOCS)).toBe(true);

    for (const outside of [
      USER_COPY,
      "/storage/emulated/0/DCIM/Camera/IMG_0001.jpg",
      `${DOCS}/peardrop/drives/abc/data`,
      `${DOCS}/peardrop-received-files.json`,
      // Prefix-adjacent: must not match on a bare startsWith.
      `${DOWNLOADS}-elsewhere/a.jpg`,
      // The directory itself is not a file.
      DOWNLOADS,
      // Traversal is refused outright rather than resolved.
      `${DOWNLOADS}/../../../../storage/emulated/0/DCIM/IMG.jpg`,
      "",
    ]) {
      expect([outside, isAppOwnedCopy(outside, DOCS)]).toEqual([outside, false]);
    }
  });

  it("reports an out-of-app path as kept rather than silently dropping it", () => {
    const plan = planReceivedDelete({
      shareFiles: [{ name: "holiday.jpg", localPath: USER_COPY }],
      legacy: [],
      shareLink: LINK,
      documentDirectoryPath: DOCS,
      normalizeLink: normalizeShareLink,
    });
    expect(plan.unlink).toEqual([]);
    expect(plan.keptOutsideApp).toEqual([USER_COPY]);
  });
});

describe("the confirm says what happens", () => {
  it("names both what goes and what stays, for a received share", () => {
    const copy = describeDeleteConfirm("received");
    expect(copy.body).toMatch(/Downloads stays/);
    expect(copy.body).toMatch(/PearDrop's copy/);
    expect(copy.body).toMatch(/Can't undo/);
  });

  it("carries none of the banned copy, and promises no re-download", () => {
    for (const kind of ["received", "hosted"] as const) {
      const { title, body } = describeDeleteConfirm(kind);
      const text = `${title} ${body}`.toLowerCase();
      for (const banned of ["network", "offline", "wi-fi", "wifi", "internet", "expire"]) {
        expect([kind, banned, text.includes(banned)]).toEqual([kind, banned, false]);
      }
      // The confirm may not promise a re-paste: that also needs the sender
      // still hosting, which this device cannot establish.
      expect(text).not.toContain("paste the link again");
    }
  });

  it("leaves the hosted wording exactly as it ships — D-14 is the received side", () => {
    expect(describeDeleteConfirm("hosted")).toEqual({
      title: "Delete this drive?",
      body: "Removes the data from your device. Can't undo.",
    });
  });
});
