// Manifest load/save for the mobile engine.
//
// Despite the filename this is a non-destructive loader: it parses or starts empty,
// never prunes entries, never touches drive folders, and backs up a corrupted manifest.
//
// A non-ENOENT read failure must never fall through to an empty manifest that the next
// save writes over the intact file, so an unreadable path is retried, then marked unsafe
// to write and reported by `isManifestUnavailable()`.

import fs from "bare-fs/promises";

import { atomicWriteJson } from "./atomic-save.mjs";

// Read-retry schedule, in ms between attempts. Four attempts total: short
// enough that boot is not visibly delayed, long enough to ride out an OS
// scanner holding the file, a permission race after a restore, or a brief
// EBUSY.
const READ_RETRY_BACKOFF_MS = [50, 150, 400];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Manifest paths that exist but could not be read. A path in this set must
// never be written over: the bytes on disk are the user's only copy of their
// shares, and an unread file cannot be shown to be a subset of memory.
//
// Keyed by path so one manifest cannot poison another. Cleared by a
// subsequent successful or ENOENT load of the same path.
const unreadablePaths = new Set();

/**
 * True when `manifestPath` exists but could not be read, so the in-memory
 * manifest is not authoritative and nothing may overwrite the file. Exported
 * rather than inferred so there is exactly one definition of it.
 */
export function isManifestUnavailable(manifestPath) {
  return unreadablePaths.has(String(manifestPath));
}

function defaultManifest() {
  return {
    drives: {},
    stats: { totalCreated: 0, totalPurged: 0, totalBytesShared: 0 },
  };
}

function isWellFormed(parsed) {
  return (
    parsed &&
    typeof parsed === "object" &&
    parsed.drives &&
    typeof parsed.drives === "object"
  );
}

// Best-effort backup: read the current file and write it beside the original
// with a .corrupted.<ts> suffix. A failed backup is swallowed rather than
// allowed to break the boot. The original on disk is left untouched here.
async function backupCorrupted(manifestPath) {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const backupPath = `${manifestPath}.corrupted.${Date.now()}`;
    await fs.writeFile(backupPath, raw, "utf8");
  } catch (err) {
    console.warn(
      "[manifest] backup of corrupt manifest failed (continuing):",
      err?.message || err,
    );
  }
}

// Read the manifest, retrying a non-ENOENT failure a few times with short
// backoff. Returns one of three outcomes and never throws:
//
//   { raw }      the bytes
//   { missing }  ENOENT — there is genuinely no manifest
//   { error }    still unreadable after every attempt
//
// ENOENT short-circuits: a file that is not there will not appear after a
// 50 ms wait, and delaying first boot for nothing is worse than useless.
async function readManifestWithRetry(manifestPath) {
  let lastErr = null;
  const attempts = READ_RETRY_BACKOFF_MS.length + 1;
  for (let i = 0; i < attempts; i++) {
    try {
      return { raw: await fs.readFile(manifestPath, "utf8") };
    } catch (err) {
      if (err?.code === "ENOENT") return { missing: true };
      lastErr = err;
      const wait = READ_RETRY_BACKOFF_MS[i];
      if (wait === undefined) break;
      console.warn(
        `[manifest] read failed (attempt ${i + 1}/${attempts}, retrying in ${wait}ms):`,
        err?.message || err,
      );
      await sleep(wait);
    }
  }
  return { error: lastErr };
}

// Load the manifest from disk. Returns the parsed manifest, or an empty one
// when the file is absent. A file that exists but does not parse or has the
// wrong shape is backed up as .corrupted.<ts> first. A file that exists but
// could not be read after the retry schedule marks the path unavailable: the
// empty manifest is a placeholder so the engine can boot far enough to tell
// the user, it is not authoritative, and every write to the path is refused
// until a later load succeeds.
export async function loadManifest(manifestPath) {
  const key = String(manifestPath);
  const read = await readManifestWithRetry(manifestPath);

  if (read.error) {
    // The destructive branch. The path is marked unsafe to overwrite and
    // stays that way until a load succeeds. No backup is attempted: the read
    // already failed, and the original bytes are untouched where they are,
    // which is the only place a recovery could come from.
    unreadablePaths.add(key);
    console.warn(
      "[manifest] UNREADABLE after retries — refusing to overwrite it; " +
        "the engine will run with an empty in-memory manifest and block " +
        "share creation until it can be read:",
      read.error?.message || read.error,
    );
    return defaultManifest();
  }

  // Any successful outcome clears a previous unavailable mark: the file is
  // readable again, or genuinely absent, so saves may proceed.
  unreadablePaths.delete(key);

  if (read.missing) {
    return defaultManifest();
  }

  const raw = read.raw;

  let parsed;
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

  // Merge stats defaults in case a manifest is missing some fields; the
  // parsed fields override.
  return {
    drives: parsed.drives,
    stats: {
      totalCreated: 0,
      totalPurged: 0,
      totalBytesShared: 0,
      ...(parsed.stats || {}),
    },
  };
}

// A serialization chain separate from the engine's own saveManifest, so a
// stall in one cannot back up the other. Errors are swallowed; callers retry.
let _saveChain = Promise.resolve();

export async function saveManifest(manifestPath, manifest) {
  // Refuse to write over a manifest that could not be read. This is one of
  // the two routes to atomicWriteJson on the manifest path; the other is
  // hyperdrive-engine.mjs's own saveManifest, which carries the same guard.
  if (isManifestUnavailable(manifestPath)) {
    console.warn(
      "[manifest] save REFUSED — the manifest on disk could not be read, " +
        "so overwriting it would destroy the only copy of the user's shares",
    );
    return;
  }
  const next = _saveChain
    .catch(() => {})
    .then(() => atomicWriteJson(manifestPath, manifest));
  _saveChain = next;
  try {
    await next;
  } catch {
    // Best-effort. Engine keeps the in-memory copy either way.
  }
}
