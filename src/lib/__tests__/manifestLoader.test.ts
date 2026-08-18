// Tripwire for the non-destructive manifest loader. backend/manifest-recovery.mjs
// uses bare-fs, which Jest can't load, so this mirrors the load logic against
// node:fs.promises and asserts the "never prune, never touch drive folders"
// guarantees. Any change to the production loader must be mirrored here or
// these tests stop catching regressions.

import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mirror of backend/manifest-recovery.mjs (loadManifest only) --- //

function defaultManifest() {
  return {
    drives: {},
    stats: { totalCreated: 0, totalPurged: 0, totalBytesShared: 0 },
  };
}

function isWellFormed(parsed: unknown): boolean {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    // @ts-expect-error — shape check by definition
    !!parsed.drives &&
    // @ts-expect-error — same
    typeof parsed.drives === "object"
  );
}

async function backupCorrupted(manifestPath: string): Promise<void> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const backupPath = `${manifestPath}.corrupted.${Date.now()}`;
    await fs.writeFile(backupPath, raw, "utf8");
  } catch {
    // swallow
  }
}

async function loadManifest(
  manifestPath: string,
): Promise<{ drives: Record<string, unknown>; stats: Record<string, number> }> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultManifest();
    }
    return defaultManifest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupCorrupted(manifestPath);
    return defaultManifest();
  }
  if (!isWellFormed(parsed)) {
    await backupCorrupted(manifestPath);
    return defaultManifest();
  }
  // Non-null via isWellFormed above; use assertions rather than a shape guard.
  const okParsed = parsed as {
    drives: Record<string, unknown>;
    stats?: Record<string, number>;
  };
  return {
    drives: okParsed.drives,
    stats: {
      totalCreated: 0,
      totalPurged: 0,
      totalBytesShared: 0,
      ...(okParsed.stats || {}),
    },
  };
}

// --- Tests --- //

describe("loadManifest — non-destructive loader tripwire", () => {
  let tmp: string;
  let manifestPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "peardrop-manifest-load-"));
    manifestPath = join(tmp, "drives-manifest.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("scenario 1 — happy path round-trip", async () => {
    const data = {
      drives: {
        drive_abc: { key: "abc", state: "active", storagePath: "/x/y" },
        recv_def: { key: "def", state: "inactive", storagePath: "/x/z" },
      },
      stats: { totalCreated: 2, totalPurged: 0, totalBytesShared: 512 },
    };
    await fs.writeFile(manifestPath, JSON.stringify(data, null, 2), "utf8");

    const loaded = await loadManifest(manifestPath);
    expect(loaded).toEqual(data);
  });

  test("scenario 2 — missing file returns empty (no backup)", async () => {
    const loaded = await loadManifest(manifestPath);
    expect(loaded).toEqual(defaultManifest());

    // No backup file created (nothing to back up).
    const siblings = await fs.readdir(tmp);
    expect(siblings.filter((f) => f.includes(".corrupted."))).toEqual([]);
  });

  test("scenario 3 — corrupt JSON returns empty + writes backup", async () => {
    await fs.writeFile(manifestPath, '{"drives": { unclose', "utf8");

    const loaded = await loadManifest(manifestPath);
    expect(loaded).toEqual(defaultManifest());

    // Backup exists and preserves the original content.
    const siblings = await fs.readdir(tmp);
    const backups = siblings.filter((f) => f.includes(".corrupted."));
    expect(backups.length).toBe(1);
    const backupName = backups[0];
    if (!backupName) throw new Error("backup missing");
    const backupContent = await fs.readFile(join(tmp, backupName), "utf8");
    expect(backupContent).toBe('{"drives": { unclose');
  });

  test("scenario 4 — malformed shape (missing drives) returns empty + backup", async () => {
    // Valid JSON but wrong shape — no `drives` field.
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ stats: {} }, null, 2),
      "utf8",
    );

    const loaded = await loadManifest(manifestPath);
    expect(loaded).toEqual(defaultManifest());

    const siblings = await fs.readdir(tmp);
    expect(siblings.filter((f) => f.includes(".corrupted."))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.corrupted\./)]),
    );
  });

  test("scenario 5 — load does NOT read drives folder; entries survive when folders are gone", async () => {
    // The load-bearing test: manifest references drive IDs whose storage
    // folders don't exist. The load must NOT prune them.
    const data = {
      drives: {
        drive_gone: {
          key: "abc",
          state: "active",
          storagePath: join(tmp, "drives", "drive_gone"),
        },
        recv_gone: {
          key: "def",
          state: "seeking",
          storagePath: join(tmp, "drives", "recv_gone"),
        },
      },
      stats: { totalCreated: 2, totalPurged: 0, totalBytesShared: 0 },
    };
    await fs.writeFile(manifestPath, JSON.stringify(data, null, 2), "utf8");
    // Intentionally do NOT create tmp/drives/ — the storage folders are
    // referenced but missing.

    const loaded = await loadManifest(manifestPath);
    expect(Object.keys(loaded.drives)).toEqual(
      expect.arrayContaining(["drive_gone", "recv_gone"]),
    );
    expect(Object.keys(loaded.drives).length).toBe(2);

    // Also verify the loader did not create the drives folder.
    await expect(fs.access(join(tmp, "drives"))).rejects.toThrow();
  });

  test("scenario 6 — load does not modify the manifest file on disk", async () => {
    const data = {
      drives: {
        drive_abc: { key: "abc", state: "active" },
      },
      stats: { totalCreated: 1, totalPurged: 0, totalBytesShared: 100 },
    };
    const serialized = JSON.stringify(data, null, 2);
    await fs.writeFile(manifestPath, serialized, "utf8");
    const mtimeBefore = (await fs.stat(manifestPath)).mtimeMs;

    // Loading must not rewrite the file (matters for atomic-save
    // reasoning and for user diff-based backup tools).
    await loadManifest(manifestPath);
    // Reading a file typically doesn't touch mtime; verifying content
    // instead is what actually matters.
    const raw = await fs.readFile(manifestPath, "utf8");
    expect(raw).toBe(serialized);
    // mtime is a weaker signal (atime updates can bump ctime, etc.);
    // reference to silence the linter and document intent.
    expect(mtimeBefore).toBeGreaterThan(0);
  });

  test("scenario 7 — stats defaults merged when only some fields are present", async () => {
    // Older manifests may have only totalCreated. The loader should
    // fill in missing stat fields with 0.
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ drives: {}, stats: { totalCreated: 5 } }, null, 2),
      "utf8",
    );

    const loaded = await loadManifest(manifestPath);
    expect(loaded.stats).toEqual({
      totalCreated: 5,
      totalPurged: 0,
      totalBytesShared: 0,
    });
  });
});
