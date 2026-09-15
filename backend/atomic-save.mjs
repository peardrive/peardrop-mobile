// atomic manifest write primitive.
//
// The pattern: write to <path>.tmp, then rename onto <path>. On POSIX
// (Android's runtime, via libuv's uv_fs_rename → rename(2)) a same-
// filesystem rename is atomic — readers see the old file or the new
// file, never a truncated in-between state. This closes the "app killed
// mid-fs.writeFile leaves a torn manifest" hole that the recovery chain
// previously had to salvage from on the next boot.
//
// Residual risk: bare-fs does not expose fsync (see
// node_modules/bare-fs/index.js:2297 — `// exports.fsync = fsync TODO`).
// Without an fsync between the write and the rename, a power loss during
// the small window between the tmp write and the rename metadata commit
// could theoretically leave the manifest pointing at an inode whose data
// hasn't hit disk. Modern Android journaled filesystems (F2FS on newer
// devices, ext4 on older ones) tend to preserve ordering under normal
// power loss, but the guarantee is best-effort here, not iron-clad. We
// still take the change because "atomic against process kill" — the
// common case — is fully protected, and the alternative (bare writeFile)
// gives no atomicity guarantee at all.
//
// Concurrency: this module intentionally does not own the serialization
// chain. Each caller manages its own chain against its own path so a
// stall in one call site can't back up another. Callers wrap this primitive
// in a promise chain when concurrent saves against the same path are
// possible (currently: hyperdrive-engine.mjs and manifest-recovery.mjs
// both wrap it; they write to the same manifest file but recovery only
// runs during engineInit before engine-driven saves can start, so they
// don't race in practice — but the wrapping is symmetric and cheap).

import fs from "bare-fs/promises";

import { wrapError } from "./engine-errors.mjs";

export async function atomicWriteJson(path, data) {
  const tmpPath = `${path}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, path);
  } catch (err) {
    // Best-effort tmp cleanup on error so a failed save doesn't leave
    // orphan .tmp files accumulating alongside the manifest.
    try {
      await fs.unlink(tmpPath);
    } catch {}
    // rethrow with typed shape so callers (both engine save
    // sites and the recovery module) surface a manifest.write-fail
    // instead of a raw fs error. Preserves EACCES/ENOSPC via detail.code.
    throw wrapError(err, {
      category: "manifest.write-fail",
      cause: "manifest-write-fail",
      message: `Manifest save failed: ${err?.message || err}`,
    });
  }
}
