// Proof-of-concept: round-trip a 5 MB file through Hyperdrive with streaming
// on both ends, verifying byte-for-byte fidelity.
//
// Runs under Node, not Bare — bare-fs needs the Bare global. What it exercises
// is the pipe contract between Hyperdrive's streams and a Node fs stream;
// Hyperdrive uses streamx directly and bare-fs uses streamx via bare-stream,
// so the same Readable/Writable conventions apply on both. It does not prove
// out bare-fs's own stream implementation.
//
// Run: node backend/__poc__/stream-poc.mjs

import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";

const SIZE_MB = 5;
const FIXTURE_BYTES = SIZE_MB * 1024 * 1024;

function md5(path) {
  const h = createHash("md5");
  h.update(readFileSync(path));
  return h.digest("hex");
}

async function pipeAwaitClose(src, dst) {
  // Match the production pattern proposed for the engine — pipe, then
  // wait for the destination's 'close'. Hyperdrive's createWriteStream
  // sequences the in-drive `db.put` inside its `final` callback, which
  // means 'close' fires only after the manifest entry is committed.
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    src.once("error", done);
    dst.once("error", done);
    dst.once("close", () => done(null));
    src.pipe(dst);
  });
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "peardrop-stream-poc-"));
  const srcPath = join(work, "src.bin");
  const dstPath = join(work, "dst.bin");
  const storePath = join(work, "store");

  console.log("[poc] workspace:", work);
  console.log("[poc] generating", SIZE_MB, "MB fixture…");
  writeFileSync(srcPath, randomBytes(FIXTURE_BYTES));
  const srcMd5 = md5(srcPath);
  const srcSize = statSync(srcPath).size;
  console.log("[poc] src md5:", srcMd5, "size:", srcSize);

  let store, drive;
  try {
    store = new Corestore(storePath);
    await store.ready();
    drive = new Hyperdrive(store);
    await drive.ready();
    console.log("[poc] drive ready, key:", drive.key.toString("hex").slice(0, 16), "…");

    // ---- SEND path: fs.createReadStream → drive.createWriteStream ----
    console.log("[poc] writing into drive via stream…");
    const t0 = Date.now();
    await pipeAwaitClose(createReadStream(srcPath), drive.createWriteStream("/payload.bin"));
    console.log("[poc] write elapsed:", Date.now() - t0, "ms");

    // Confirm the entry actually committed
    const entry = await drive.entry("/payload.bin");
    if (!entry) throw new Error("no entry after write");
    if (entry.value.blob.byteLength !== srcSize) {
      throw new Error(`size mismatch after write: drive=${entry.value.blob.byteLength} src=${srcSize}`);
    }
    console.log("[poc] entry size matches:", entry.value.blob.byteLength);

    // ---- RECV path: drive.createReadStream → fs.createWriteStream ----
    console.log("[poc] reading back via stream…");
    const t1 = Date.now();
    await pipeAwaitClose(drive.createReadStream("/payload.bin"), createWriteStream(dstPath));
    console.log("[poc] read elapsed:", Date.now() - t1, "ms");

    const dstMd5 = md5(dstPath);
    const dstSize = statSync(dstPath).size;
    console.log("[poc] dst md5:", dstMd5, "size:", dstSize);

    if (srcMd5 !== dstMd5) throw new Error(`MD5 mismatch: src=${srcMd5} dst=${dstMd5}`);
    if (srcSize !== dstSize) throw new Error(`size mismatch: src=${srcSize} dst=${dstSize}`);

    console.log("[poc] ✅ round-trip byte-for-byte match");

    // ---- Error-path check: write source that errors mid-pipe ----
    console.log("[poc] error-path: src error should propagate to write…");
    const bad = createReadStream(join(work, "does-not-exist.bin"));
    let propagated = null;
    try {
      await pipeAwaitClose(bad, drive.createWriteStream("/should-not-exist.bin"));
    } catch (err) {
      propagated = err;
    }
    if (!propagated) throw new Error("expected error did not propagate");
    console.log("[poc] error propagated as:", propagated.code || propagated.message);

    // ---- Backpressure sanity: write 5 MB in chunks via write() return value ----
    // This isn't a full backpressure test (Node's pipe handles it for us
    // above) — it just confirms the Writable.write() return value is the
    // streamx contract (boolean) so manual pumping would work too.
    console.log("[poc] backpressure smoke check…");
    const ws = drive.createWriteStream("/bp.bin");
    const chunk = Buffer.alloc(64 * 1024, 0x7f);
    let okCount = 0;
    let drainCount = 0;
    for (let i = 0; i < 32; i++) {
      const ok = ws.write(chunk);
      if (ok === true) okCount++;
      else {
        drainCount++;
        await new Promise((res) => ws.once("drain", res));
      }
    }
    await new Promise((res, rej) => {
      ws.once("close", res);
      ws.once("error", rej);
      ws.end();
    });
    console.log("[poc] backpressure: write()=true count:", okCount, "drains awaited:", drainCount);
  } finally {
    try { await drive?.close?.(); } catch {}
    try { await store?.close?.(); } catch {}
    rmSync(work, { recursive: true, force: true });
    console.log("[poc] workspace cleaned");
  }
}

main().then(() => {
  console.log("[poc] DONE");
  process.exit(0);
}, (err) => {
  console.error("[poc] FAIL:", err);
  process.exit(1);
});
