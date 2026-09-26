// Tripwire for Hyperdrive's stream contract. The engine pipes bare-fs streams
// through hyperdrive.createReadStream / createWriteStream; this exercises the
// same pipe pattern with Node's `fs`, because Jest cannot load bare-fs — it
// needs the Bare global. One MB, byte-for-byte, sequentially piped the way the
// engine does it. The bare-fs side of the interop is not reachable from here.

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import Corestore from "corestore";
import Hyperdrive from "hyperdrive";

const ONE_MB = 1024 * 1024;

// Mirrors backend/hyperdrive-engine.mjs. Duplicated rather than imported
// because the engine module needs the Bare global and cannot load here. If
// the engine's constant changes, this one must change with it.
const PARTIAL_SUFFIX = ".peardrop-part";

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

// Mirrors the engine's helper: pipe and await 'close', not 'finish', so the
// in-drive db entry is committed before resolution. Both ends are listened to
// and the settle is guarded against firing twice.
function pipeAwaitClose(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    src.once("error", (err) => done(err as Error));
    dst.once("error", (err) => done(err as Error));
    dst.once("close", () => done(null));
    src.pipe(dst as unknown as NodeJS.WritableStream);
  });
}

describe("hyperdrive stream round-trip", () => {
  let workspace: string;
  let store: { ready(): Promise<void>; close(): Promise<void> } | null = null;
  let drive: {
    ready(): Promise<void>;
    close(): Promise<void>;
    createWriteStream(name: string): NodeJS.WritableStream;
    createReadStream(name: string): NodeJS.ReadableStream;
    entry(name: string): Promise<{ value: { blob: { byteLength: number } } } | null>;
    key: Buffer;
  } | null = null;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "peardrop-jest-stream-"));
    store = new Corestore(join(workspace, "store"));
    await store!.ready();
    drive = new Hyperdrive(store);
    await drive!.ready();
  });

  afterAll(async () => {
    try { await drive?.close?.(); } catch {}
    try { await store?.close?.(); } catch {}
    try { rmSync(workspace, { recursive: true, force: true }); } catch {}
  });

  test("1 MB pipe-in then pipe-out yields byte-for-byte identical data", async () => {
    const srcPath = join(workspace, "src.bin");
    const dstPath = join(workspace, "dst.bin");
    const fixture = randomBytes(ONE_MB);
    writeFileSync(srcPath, fixture);
    const srcDigest = md5(fixture);

    // Send: fs read → hyperdrive write
    await pipeAwaitClose(createReadStream(srcPath), drive!.createWriteStream("/payload.bin"));

    // The entry must be in the drive after 'close' — the whole point of
    // awaiting 'close' rather than 'finish'. If this fails after a Hyperdrive
    // upgrade, the engine's helper needs a matching update.
    const entry = await drive!.entry("/payload.bin");
    expect(entry).not.toBeNull();
    expect(entry!.value.blob.byteLength).toBe(ONE_MB);

    // Receive: hyperdrive read → fs write
    await pipeAwaitClose(drive!.createReadStream("/payload.bin"), createWriteStream(dstPath));

    const dstBuf = readFileSync(dstPath);
    expect(dstBuf.byteLength).toBe(ONE_MB);
    expect(md5(dstBuf)).toBe(srcDigest);
  }, 30_000);

  // The receive side writes to `<dest>.peardrop-part` and renames onto
  // `<dest>` after 'close'. Two ordering properties, both of which only a
  // real stream can demonstrate: the final path does not exist until the
  // rename, which is what stops `uniquePath` seeing a partial as an existing
  // file and handing the retry "photo (1).jpg"; and the rename happens after
  // 'close', not 'finish', so the bytes are flushed before the file takes its
  // real name.
  test("partial suffix: final path appears only after the post-close rename", async () => {
    const dstPath = join(workspace, "renamed.bin");
    const partPath = `${dstPath}${PARTIAL_SUFFIX}`;
    const fixture = randomBytes(ONE_MB);
    const srcDigest = md5(fixture);

    writeFileSync(join(workspace, "src2.bin"), fixture);
    await pipeAwaitClose(
      createReadStream(join(workspace, "src2.bin")),
      drive!.createWriteStream("/payload2.bin"),
    );

    const ws = createWriteStream(partPath);
    let finalExistedBeforeRename: boolean | null = null;
    // Sampled on 'close' — the moment the engine's `done(null)` runs, before
    // its `fs.rename`. The final name must still be absent here.
    ws.once("close", () => {
      finalExistedBeforeRename = existsSync(dstPath);
    });
    await pipeAwaitClose(drive!.createReadStream("/payload2.bin"), ws);

    expect(finalExistedBeforeRename).toBe(false);
    expect(existsSync(partPath)).toBe(true);

    renameSync(partPath, dstPath);

    expect(existsSync(partPath)).toBe(false);
    const dstBuf = readFileSync(dstPath);
    expect(dstBuf.byteLength).toBe(ONE_MB);
    expect(md5(dstBuf)).toBe(srcDigest);
  }, 30_000);
});
