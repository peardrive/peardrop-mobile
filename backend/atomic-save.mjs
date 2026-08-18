// Atomic manifest write: write to <path>.tmp, then rename onto <path>.
// A same-filesystem rename(2) is atomic, so a process kill can never leave
// a torn manifest.
//
// Caveat: bare-fs exposes no fsync, so there is no durability barrier between
// the tmp write and the rename — power loss (as opposed to process kill) can
// still leave the manifest pointing at data that hasn't reached disk.
//
// Serialization is deliberately left to callers: each owns its own chain per
// path, so a stall at one call site can't back up another.

import fs from "bare-fs/promises";

import { wrapError } from "./engine-errors.mjs";

export async function atomicWriteJson(path, data) {
  const tmpPath = `${path}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup so failed saves don't accumulate orphan .tmp files.
    try {
      await fs.unlink(tmpPath);
    } catch {}
    // Typed rethrow; preserves EACCES/ENOSPC via detail.code.
    throw wrapError(err, {
      category: "manifest.write-fail",
      cause: "manifest-write-fail",
      message: `Manifest save failed: ${err?.message || err}`,
    });
  }
}
