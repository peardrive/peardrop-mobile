// Manifest load/save for the mobile engine. The module name is historical;
// it loads and saves, it does not recover.
//
// The loader is deliberately non-destructive:
//   - Parses, or starts empty. drives-manifest.json is used only if it parses
//     as JSON with the expected top-level shape; anything else yields an empty
//     manifest rather than a partial salvage.
//   - Never prunes entries. It does not compare the manifest against the
//     on-disk drives folder — a pruning step that deletes every entry when
//     the drives folder is transiently unreadable is a data-loss bug.
//     Missing storage is handled per-drive by engineHydrateDrives at open time.
//   - Never touches drive folders. Corestore folders are the engine's
//     concern, never this module's.
//   - Backs up before discarding. A corrupt or mis-shaped manifest is copied
//     to <path>.corrupted.<epoch-ms> before an empty manifest is returned.
//     Backups may accumulate across boots; they're small and preserve state.

import fs from "bare-fs/promises";

import { atomicWriteJson } from "./atomic-save.mjs";

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

// Backup errors are swallowed rather than allowed to break the boot.
// The original file is left in place; a subsequent engine save overwrites it.
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

// Returns the parsed manifest, or an empty one if the file is absent,
// unreadable, or mis-shaped (the latter two also leave a .corrupted.<ts>
// backup). Does not itself write the empty manifest to disk.
export async function loadManifest(manifestPath) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return defaultManifest();
    }
    // Permission / i/o error — start empty. No backup attempt; the read
    // already failed.
    console.warn(
      "[manifest] read failed (starting empty):",
      err?.message || err,
    );
    return defaultManifest();
  }

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

  // Merge stats defaults so an older or hand-edited manifest missing fields
  // still loads; parsed fields win.
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

// Serialization chain kept separate from the engine's own saveManifest so
// neither can stall the other.
let _saveChain = Promise.resolve();

export async function saveManifest(manifestPath, manifest) {
  // .catch(() => {}) before .then: without it a single rejection poisons the
  // chain and every later save short-circuits.
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
