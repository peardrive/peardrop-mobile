// Tripwire for the atomic manifest write pattern. backend/atomic-save.mjs uses
// bare-fs, which Jest can't load (it needs the Bare global), so this mirrors
// the same logic against node:fs.promises.

import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirror of atomicWriteJson from backend/atomic-save.mjs. If this diverges
// from the .mjs, the tests below catch nothing useful — so any change to
// backend/atomic-save.mjs must be mirrored here.
async function atomicWriteJson(
  fsLike: {
    writeFile: (
      p: string,
      data: string,
      enc: BufferEncoding,
    ) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    unlink: (p: string) => Promise<void>;
  },
  path: string,
  data: unknown,
): Promise<void> {
  const tmpPath = `${path}.tmp`;
  try {
    await fsLike.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fsLike.rename(tmpPath, path);
  } catch (err) {
    try {
      await fsLike.unlink(tmpPath);
    } catch {}
    throw err;
  }
}

// Mirror of the engine's saveManifest chain shape.
function createSerializedWriter(
  fsLike: Parameters<typeof atomicWriteJson>[0],
  targetPath: string,
) {
  let chain: Promise<void> = Promise.resolve();
  return function save(data: unknown): Promise<void> {
    const next = chain
      .catch(() => {})
      .then(() => atomicWriteJson(fsLike, targetPath, data));
    chain = next;
    return next;
  };
}

describe("atomicWriteJson tripwire", () => {
  let tmp: string;
  let target: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "peardrop-atomic-save-"));
    target = join(tmp, "drives-manifest.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("scenario 1 — save-and-load round-trip", async () => {
    const data = {
      drives: { a: { key: "abc", state: "active" } },
      stats: { totalCreated: 1, totalPurged: 0, totalBytesShared: 42 },
    };

    await atomicWriteJson(fs, target, data);

    const raw = await fs.readFile(target, "utf8");
    expect(JSON.parse(raw)).toEqual(data);

    // No .tmp remains after a successful save.
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

  test("scenario 2 — concurrent saves serialize; final content is last-fired", async () => {
    const save = createSerializedWriter(fs, target);

    const N = 10;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(save({ generation: i, drives: {}, stats: {} }));
    }
    await Promise.all(promises);

    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { generation: number };
    // Last save wins because they run serially in chain order.
    expect(parsed.generation).toBe(N - 1);

    // No leftover .tmp after the burst.
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

  test("scenario 3 — writeFile failure leaves prior manifest intact + tmp cleaned", async () => {
    const prior = { drives: { keep: { key: "keep" } }, stats: {} };
    await atomicWriteJson(fs, target, prior);

    const throwingFs = {
      writeFile: async (): Promise<void> => {
        throw new Error("simulated writeFile failure");
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
    };

    await expect(
      atomicWriteJson(throwingFs, target, { drives: { wrong: {} }, stats: {} }),
    ).rejects.toThrow("simulated writeFile failure");

    // Main manifest still holds the prior content.
    const raw = await fs.readFile(target, "utf8");
    expect(JSON.parse(raw)).toEqual(prior);

    // No .tmp accumulated (unlink was best-effort on the failure path;
    // since writeFile never created the tmp file in this scenario, the
    // unlink call ENOENTs which the helper swallows).
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

  test("scenario 4 — rename failure leaves prior manifest intact + tmp cleaned", async () => {
    const prior = { drives: { keep: { key: "keep" } }, stats: {} };
    await atomicWriteJson(fs, target, prior);

    let unlinkCalled = false;
    const throwingFs = {
      writeFile: fs.writeFile.bind(fs),
      rename: async (): Promise<void> => {
        throw new Error("simulated rename failure");
      },
      unlink: async (p: string): Promise<void> => {
        unlinkCalled = true;
        await fs.unlink(p);
      },
    };

    await expect(
      atomicWriteJson(throwingFs, target, { drives: { wrong: {} }, stats: {} }),
    ).rejects.toThrow("simulated rename failure");

    // Main manifest still holds the prior content.
    const raw = await fs.readFile(target, "utf8");
    expect(JSON.parse(raw)).toEqual(prior);

    // Unlink was invoked as the best-effort cleanup path.
    expect(unlinkCalled).toBe(true);

    // .tmp is gone (the unlink succeeded — real fs.unlink was called
    // by the wrapper).
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

  test("scenario 2b — chain isolates errors: a failed save doesn't poison later saves", async () => {
    // The engine's chain uses .catch(() => {}) before .then() so that a
    // rejection in one save doesn't propagate into the next. Verify the
    // pattern behaves.
    let failOnce = true;
    const flakyFs = {
      writeFile: async (p: string, d: string, e: BufferEncoding) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("first save fails");
        }
        return fs.writeFile(p, d, e);
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
    };

    let chain: Promise<void> = Promise.resolve();
    const save = (data: unknown) => {
      const next = chain
        .catch(() => {})
        .then(() => atomicWriteJson(flakyFs, target, data));
      chain = next;
      return next;
    };

    const first = save({ generation: 0, drives: {}, stats: {} });
    const second = save({ generation: 1, drives: {}, stats: {} });

    await expect(first).rejects.toThrow("first save fails");
    await expect(second).resolves.toBeUndefined();

    const raw = await fs.readFile(target, "utf8");
    expect((JSON.parse(raw) as { generation: number }).generation).toBe(1);
  });
});
