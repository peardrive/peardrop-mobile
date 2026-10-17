/** Which stored drive a resolve reuses for a share key, and the duplicates behind it. */
// Pure and import-free, so engine and tests read one definition of "the same share".

/** In-flight markers, not finished drives: the boot cleanup deletes a seeking
 * folder, so reusing one adopts storage another call is about to remove. */
export const UNUSABLE_STATES = Object.freeze(["creating", "seeking", "purged"]);

/** `stopped` is the legacy spelling of `inactive`; both are reusable. */
function usableState(state) {
  return !UNUSABLE_STATES.includes(String(state || "").toLowerCase());
}

function localFileCount(entry) {
  return Array.isArray(entry?.localFiles) ? entry.localFiles.length : 0;
}

function createdAt(entry) {
  const n = Number(entry?.createdAt);
  return Number.isFinite(n) ? n : 0;
}

/** Every received entry for this key: most `localFiles` wins, newest breaks a tie, a stable `driveId` breaks that. */
// Most-held first so a resume lands on the copy holding the most blocks.
export function rankReceivedEntries(drives, keyHex) {
  const key = String(keyHex || "").toLowerCase();
  if (!key) return [];
  const all = Object.values(drives || {}).filter(
    (d) =>
      d &&
      (d.origin || "hosted") === "received" &&
      String(d.key || "").toLowerCase() === key,
  );
  return all.sort((a, b) => {
    const byFiles = localFileCount(b) - localFileCount(a);
    if (byFiles !== 0) return byFiles;
    const byAge = createdAt(b) - createdAt(a);
    if (byAge !== 0) return byAge;
    return String(a.driveId || "") < String(b.driveId || "") ? -1 : 1;
  });
}

/** The entry a resolve reuses, or `null` to mint one. An entry with no
 * `storagePath` is skipped, so a damaged record cannot block a good sibling. */
export function pickDriveToReuse(drives, keyHex) {
  for (const entry of rankReceivedEntries(drives, keyHex)) {
    if (!usableState(entry.state)) continue;
    if (!entry.storagePath) continue;
    return entry;
  }
  return null;
}

/** What the duplicates for one key look like, for the boot report. It decides
 * nothing and deletes nothing; it only names the entry the pick rule keeps. */
export function describeDuplicates(drives, keyHex) {
  const ranked = rankReceivedEntries(drives, keyHex);
  const keep = pickDriveToReuse(drives, keyHex);
  return {
    key: String(keyHex || "").toLowerCase(),
    total: ranked.length,
    keepDriveId: keep ? keep.driveId : null,
    entries: ranked.map((e) => ({
      driveId: e.driveId,
      state: e.state,
      localFiles: localFileCount(e),
      files: Array.isArray(e.files) ? e.files.length : 0,
      storagePath: e.storagePath || null,
      createdAt: createdAt(e),
      reusable: usableState(e.state) && !!e.storagePath,
      wouldKeep: !!keep && e.driveId === keep.driveId,
    })),
  };
}

/** Every received key with more than one entry, worst offender first, so the
 * boot line does not lead with whatever key hashed first. */
export function findDuplicateKeys(drives) {
  const byKey = new Map();
  for (const d of Object.values(drives || {})) {
    if (!d || (d.origin || "hosted") !== "received") continue;
    const key = String(d.key || "").toLowerCase();
    if (!key) continue;
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  return Array.from(byKey.entries())
    .filter(([, n]) => n > 1)
    .map(([key]) => key)
    .sort((a, b) => (byKey.get(b) ?? 0) - (byKey.get(a) ?? 0) || (a < b ? -1 : 1));
}

/** States an orphan may be removed from, narrower than `usableState`. */
// The legacy `stopped` spelling can be the keeper but is never removed: a rule that is slightly wrong deletes files.
export const REMOVABLE_STATES = Object.freeze(["active", "inactive"]);

/** The entries a removal pass may delete, one clause per guard below. */
// Probes are injected so this stays filesystem-free, and every default refuses.
export function selectRemovableOrphans(drives, probes = {}) {
  const hasSession = probes.hasSession || (() => false);
  const downloadRunning = probes.downloadRunning || (() => false);
  const withinDrivesDir = probes.withinDrivesDir || (() => false);
  const out = [];
  // 1: received, and sharing its key with an entry the pick rule keeps.
  for (const key of findDuplicateKeys(drives)) {
    const group = describeDuplicates(drives, key);
    if (!group.keepDriveId) continue;
    // 7: group-wide, so one running download protects every sibling of the key.
    if (downloadRunning(group.keepDriveId)) continue;
    for (const e of group.entries) {
      if (e.wouldKeep) continue; // 2
      // 3: never a marker another call owns.
      if (!REMOVABLE_STATES.includes(String(e.state || "").toLowerCase())) continue;
      // 4, the load-bearing one: nothing on the record claims a file on disk
      // came from it, which is what stops a removal orphaning the user's files.
      if (e.localFiles > 0) continue;
      if (hasSession(e.driveId)) continue; // 5
      // 6: a damaged path cannot aim the delete outside the drives folder.
      if (!e.storagePath || !withinDrivesDir(e.storagePath)) continue;
      out.push({
        driveId: e.driveId,
        key,
        state: e.state,
        storagePath: e.storagePath,
        keepDriveId: group.keepDriveId,
      });
    }
  }
  return out;
}

/** One line per duplicated key, plus a total. Sizes are injected so this module
 * stays filesystem-free and testable. */
export function summarizeOrphans(drives, sizeOf = (_storagePath) => null) {
  const keys = findDuplicateKeys(drives);
  const groups = keys.map((k) => describeDuplicates(drives, k));
  let orphanCount = 0;
  let orphanBytes = 0;
  const lines = [];
  for (const g of groups) {
    const parts = g.entries.map((e) => {
      const bytes = sizeOf(e.storagePath);
      if (!e.wouldKeep) {
        orphanCount++;
        if (typeof bytes === "number" && Number.isFinite(bytes)) orphanBytes += bytes;
      }
      return (
        `${e.driveId}[state=${e.state} local=${e.localFiles}/${e.files}` +
        `${typeof bytes === "number" ? ` bytes=${bytes}` : ""}` +
        `${e.wouldKeep ? " KEEP" : ""}]`
      );
    });
    lines.push(`key=${g.key.slice(0, 12)}… n=${g.total} ${parts.join(" ")}`);
  }
  return { duplicateKeys: keys.length, orphanCount, orphanBytes, lines };
}
