// Tripwire for Hyperdrive's stream contract. The engine pipes bare-fs streams
// through hyperdrive.createReadStream / createWriteStream; this exercises the
// same pipe pattern with Node's `fs`, since Jest can't load bare-fs. It catches
// Hyperdrive-side contract breakage; bare-fs ↔ Hyperdrive interop is only
// covered by the phone test and backend/__poc__/stream-poc.mjs.

import { createReadStream, createWriteStream, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import Corestore from "corestore";
import Hyperdrive from "hyperdrive";

const ONE_MB = 1024 * 1024;

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

// Mirrors the engine's helper shape: pipe and await 'close' (not 'finish')
// so the in-drive db entry is committed before resolution. Listen on both
// ends and guard against double-settle.
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

    // The entry MUST be in the drive after 'close' — that's the whole
    // point of awaiting 'close' rather than 'finish'. If this assertion
    // fails after a Hyperdrive upgrade, the engine's helper needs a
    // matching update.
    const entry = await drive!.entry("/payload.bin");
    expect(entry).not.toBeNull();
    expect(entry!.value.blob.byteLength).toBe(ONE_MB);

    // Receive: hyperdrive read → fs write
    await pipeAwaitClose(drive!.createReadStream("/payload.bin"), createWriteStream(dstPath));

    const dstBuf = readFileSync(dstPath);
    expect(dstBuf.byteLength).toBe(ONE_MB);
    expect(md5(dstBuf)).toBe(srcDigest);
  }, 30_000);
});
