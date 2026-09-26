// Atomic manifest write: write to <path>.tmp, then rename onto <path>. A
// same-filesystem rename is atomic, so a reader sees the old file or the new
// file, never a truncated in-between state.
//
// bare-fs exposes no fsync, so this is atomic against process kill but not
// against power loss between the tmp write and the rename metadata commit.
//
// Serialization is the caller's job, not this module's: each call site chains
// against its own path so a stall in one cannot back up another.

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
    // Rethrow typed so callers see a manifest.write-fail rather than a raw fs
    // error; detail.code preserves EACCES/ENOSPC.
    throw wrapError(err, {
      category: "manifest.write-fail",
      cause: "manifest-write-fail",
      message: `Manifest save failed: ${err?.message || err}`,
    });
  }
}
