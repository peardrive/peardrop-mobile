// Manifest load/save for the mobile engine.
//
// reduced from a full recovery chain to a
// non-destructive four-rule loader that mirrors desktop v0.24.0's
// approach. The filename stayed "manifest-recovery.mjs" so engine
// imports don't churn, but "recovery" is no longer what this module
// does — it just loads and saves.
//
// The four rules:
//   1. Parse or start empty. If drives-manifest.json parses as valid
//      JSON with the expected top-level shape, use it. Otherwise back
//      it up as <path>.corrupted.<epoch-ms> and return an empty
//      manifest to the engine.
//   2. Never prune entries. This loader does not compare manifest
//      entries against the on-disk drives folder. Missing storage is a
//      per-drive concern that engineHydrateDrives handles at open time.
//   3. Never touch drive folders. This loader reads the manifest file
//      only. Corestore folders are inspected by the engine (during
//      hydrate) or removed by the engine (during in-flight cleanup and
//      user-initiated delete), never here.
//   4. Backup on failure. Any corrupt / mis-shaped / unreadable
//      manifest gets backed up with .corrupted.<timestamp> before the
//      empty state is returned. Multiple backups may accumulate across
//      boots; that is fine (they're small; they preserve forensic
//      state; the user can inspect them).
//
// Why the reduction: Sprint 3D landed a four-step recovery chain
// (partial-JSON salvage, rebuild-from-drives-folder, etc.) ported from
// desktop v0.23.1. Desktop v0.24.0 subsequently deleted that same
// chain, citing production data loss — the `validateAndSync` pruning
// step would delete every manifest entry when the drives folder was
// transiently unreadable. Sprint 3P closed the specific "torn write"
// motivator for the recovery chain via atomic manifest writes; the
// rebuild-from-scan path was theoretical (no known real user hit it);
// the partial-JSON salvage covered the same failure mode Sprint 3P
// closed. So the whole chain was replaced with this loader.
//
// See Unify_process/proposal.md §3 (the decision point) and Sprint 3Q
// changelog for the full rationale.

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

// Best-effort backup: read the current file and write it beside the
// original with a .corrupted.<ts> suffix. If the source read fails
// too (rare — usually the caller already failed to parse it), we swallow
// the backup error rather than let it break the boot. The original file
// on disk is left untouched by this function; a subsequent engine save
// will overwrite it.
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

// Load the manifest from disk.
//
// - Returns the parsed manifest if the file exists and has the expected
//   top-level shape.
// - Returns an empty manifest if the file does not exist.
// - Returns an empty manifest AND writes a .corrupted.<ts> backup of
//   the original file if the file exists but doesn't parse or has the
//   wrong shape.
//
// Non-throwing except on unexpected errors from bare-fs itself (which
// the engine's own try/catch catches). The engine's saveManifest is
// what puts the empty manifest on disk if a subsequent state change
// fires.
export async function loadManifest(manifestPath) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return defaultManifest();
    }
    // Anything else (permission, i/o error) — treat as unreadable and
    // start empty. Do not attempt backup (the read already failed).
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

  // Merge stats defaults in case an older/hand-edited manifest is
  // missing some fields. The default's fields are additive; the parsed
  // fields override.
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

// separate serialization chain from the engine's saveManifest.
// This save is only used if a caller of loadManifest wants to persist
// its result immediately (e.g. after a first-boot empty-manifest
// creation). Errors are swallowed — the caller can retry.
let _saveChain = Promise.resolve();

export async function saveManifest(manifestPath, manifest) {
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
