/** When a received share is shared onward. Pure and filesystem-free, so engine and tests read one rule. */
// The rule, in one place: a finished download is shared onward by default, so a link keeps working
// when the first sender is offline. It stops only when the user says "Stop sharing", and that
// answer is kept for good. A copy that is missing a file is never shared, whoever asks.
//
// `entry.reshared` has three values:
//   undefined  nobody has decided: share (the default)
//   true       the user pressed Share: share
//   false      the user pressed Stop sharing: do not share, on this launch or any later one
// `false` is written by the user's Stop and by nothing else.
import { rankReceivedEntries, UNUSABLE_STATES } from "./drive-reuse.mjs";

function isReceived(entry) {
  return !!entry && (entry.origin || "hosted") === "received";
}

function keyOf(entry) {
  return String(entry?.key || "").toLowerCase();
}

/** `clip (1).mp4` and `clip.mp4` are one file: the second is a re-fetch saved beside the first. */
export function localHeldNameKey(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${stem.replace(/ \(\d+\)$/, "")}${ext}`;
}

/**
 * Does this entry hold EVERY file its manifest lists? Deliberately strict: a false positive
 * shares a copy that cannot serve what it advertises, and the next person stalls on it.
 */
export function receivedDriveIsComplete(entry) {
  const files = Array.isArray(entry?.files) ? entry.files : [];
  if (files.length === 0) return false;

  const held = new Map();
  for (const lf of Array.isArray(entry?.localFiles) ? entry.localFiles : []) {
    // `path` is required, not just `name`: a record without a path is not a file anything can read.
    if (!lf || !lf.path) continue;
    const key = localHeldNameKey(lf.name || lf.path);
    held.set(key, (held.get(key) || 0) + 1);
  }

  for (const f of files) {
    const want = localHeldNameKey(f?.displayName || f?.name || f?.key || "");
    const n = held.get(want) || 0;
    if (n <= 0) return false;
    held.set(want, n - 1);
  }
  return true;
}

/** Every received entry for the share this entry belongs to, itself included. */
export function receivedSiblings(drives, keyHex) {
  const key = String(keyHex || "").toLowerCase();
  if (!key) return [];
  return Object.values(drives || {}).filter((d) => isReceived(d) && keyOf(d) === key);
}

/**
 * Has the user stopped sharing this share? Asked per share, not per entry: an old install can
 * hold two entries for one link, and a Stop pressed on one must not be undone by the other.
 */
export function receivedKeyStopped(drives, keyHex) {
  return receivedSiblings(drives, keyHex).some((d) => d.reshared === false);
}

/**
 * The one entry that shares a link when several hold it: the complete copy the reuse rule ranks
 * first. One per share, so two copies of one link never both announce.
 */
export function pickServingEntry(drives, keyHex) {
  for (const entry of rankReceivedEntries(drives, keyHex)) {
    if (UNUSABLE_STATES.includes(String(entry.state || "").toLowerCase())) continue;
    if (!entry.storagePath) continue;
    if (!receivedDriveIsComplete(entry)) continue;
    return entry;
  }
  return null;
}

/** Why an entry is or is not shared by default. The words go in the log, never on screen. */
export function receivedShareDecision(drives, entry) {
  if (!isReceived(entry)) return { serve: false, reason: "not-received" };
  if (!receivedDriveIsComplete(entry)) return { serve: false, reason: "incomplete" };
  if (receivedKeyStopped(drives, entry.key)) return { serve: false, reason: "stopped-by-user" };
  const serving = pickServingEntry(drives, entry.key);
  if (!serving || serving.driveId !== entry.driveId) {
    return { serve: false, reason: "another-copy-shares-it" };
  }
  return { serve: true, reason: "complete-and-not-stopped" };
}

/** Should this received entry be shared when nobody has said anything? */
export function receivedEntrySharesByDefault(drives, entry) {
  return receivedShareDecision(drives, entry).serve;
}

/**
 * Record the user's answer. `serve === true` is Share, `false` is Stop sharing. Returns whether
 * anything changed, so the caller saves only when it must.
 *
 * Share clears a Stop on every entry of the share, or the old Stop would win at the next launch.
 * Stop is written on the one entry; `receivedKeyStopped` reads it for all of them.
 */
export function recordReshareAnswer(drives, entry, serve) {
  if (!isReceived(entry) || typeof serve !== "boolean") return false;
  let changed = false;
  if (serve) {
    for (const d of receivedSiblings(drives, entry.key)) {
      if (d !== entry && d.reshared === false) {
        delete d.reshared;
        changed = true;
      }
    }
  }
  if (entry.reshared !== serve) {
    entry.reshared = serve;
    changed = true;
  }
  return changed;
}
