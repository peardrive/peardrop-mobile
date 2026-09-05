import fs from "bare-fs/promises";
import { createReadStream, createWriteStream } from "bare-fs";
import path from "bare-path";

import b4a from "b4a";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";

import { loadManifest as readManifestFromDisk } from "./manifest-recovery.mjs";
import { atomicWriteJson } from "./atomic-save.mjs";
import { safePathWithin, PathTraversalError } from "./path-safe.mjs";
import { EngineError, wrapError, failure } from "./engine-errors.mjs";
import {
  bdebug,
  binfo,
  bwarn,
  berror,
  describeError,
  swallowed,
} from "./debug-log.mjs";

const DRIVE_MANIFEST_PATH = "/.peardrop.json";
const DRIVE_MANIFEST_VERSION = 1;
const DRIVE_MANIFEST_MAX_SIZE = 64 * 1024;
const DRIVE_MANIFEST_MAX_FILES = 1000;
const MANIFEST_DOWNLOAD_SKIP = "/.peardrop.json";

// Per-file stall watchdog on receive. If a peer
// drops mid-file, hyperdrive's read stream waits forever for blocks
// that never arrive. This value (matched to desktop v0.24.0's
// downloader.js:36 STALL_TIMEOUT_MS) fails the file after 60 s of no
// data on the stream, so the download loop can move on to the next
// file instead of hanging the whole session.
const STALL_TIMEOUT_MS = 60000;

const DriveState = {
  CREATING: "creating",
  ACTIVE: "active",
  SEEDING: "seeding",
  // In-flight receiver-open. Persisted so the corestore folder is cleaned
  // up on next boot if the open didn't complete.
  SEEKING: "seeking",
  // Data preserved locally, NOT announcing on the swarm. Both
  // hosted (user stopped) and received (download finished) drives can land
  // here. Activate transitions them back to ACTIVE; Delete (engineStopDrive
  // with purge) is the only destructive path.
  INACTIVE: "inactive",
  // Legacy alias kept for backward-compat in existing manifests. Loaded as
  // inactive at hydration time.
  STOPPED: "stopped",
  PURGED: "purged",
};

function normalizeState(s) {
  if (s === DriveState.STOPPED) return DriveState.INACTIVE;
  return s;
}

/**
 * Every drive-state transition goes through here.
 *
 * Before this, `meta.state = DriveState.X` was assigned in nine places
 * with no record anywhere — a drive could go active → inactive → purged
 * across a session and the log would show nothing. `why` carries the
 * trigger (which call, which branch) because the transition alone rarely
 * explains itself.
 */
function setDriveState(meta, next, why) {
  if (!meta) return;
  const prev = meta.state;
  meta.state = next;
  binfo(
    "engine.state",
    `drive=${meta.driveId || "?"} ${prev || "none"} → ${next} (${why})`,
  );
}

let emitEvent = () => {};

export function engineSetEmit(handler) {
  emitEvent = typeof handler === "function" ? handler : () => {};
}

let drivesDir = null;
let downloadsDir = null;
let manifestPath = null;
let initialized = false;

const activeDrives = new Map();
const pendingConnections = new Map();
const uploadTrackers = new Map();
const fakeSessions = new Map();

// Transient hydrate failures are tracked in memory,
// not persisted to the manifest. A drive whose corestore folder is
// briefly unreadable at boot (permission blip, race with an OS scan)
// used to get `state: "failed"` written to disk, which permanently
// demoted the drive on every subsequent boot. Now: keep the failure
// off disk, retry on next boot, expose the failure map to the RN side
// for optional UI surfacing. Mirrors desktop v0.24.0's resumeErrors
// pattern (hyperdrive-manager.js:1459-1468). Cleared per-drive on
// successful hydrate.
const resumeErrors = new Map();

export function engineGetResumeErrors() {
  const out = {};
  for (const [driveId, info] of resumeErrors.entries()) {
    out[driveId] = { error: info.error, at: info.at };
  }
  return out;
}

let manifest = {
  drives: {},
  stats: { totalCreated: 0, totalPurged: 0, totalBytesShared: 0 },
};

function peardropLayout(root) {
  const peardrop = path.join(root, "peardrop");
  return {
    peardrop,
    drives: path.join(peardrop, "drives"),
    downloads: path.join(peardrop, "downloads"),
    manifestFile: path.join(peardrop, "drives-manifest.json"),
  };
}

async function loadManifest() {
  // The load path is non-destructive. The reader parses
  // the manifest and returns it (or an empty manifest with a .corrupted
  // backup if the file was unreadable). It does not read the drives
  // folder; it does not prune entries. Per-drive missing-storage is
  // handled at hydrate time; wide "manifest vs folders" sync is gone
  // deliberately (see manifest-recovery.mjs header for the rationale).
  try {
    manifest = await readManifestFromDisk(manifestPath);
    binfo(
      "engine.boot",
      `manifest loaded: ${Object.keys(manifest.drives || {}).length} drive entries`,
    );
  } catch (err) {
    console.error("[engine] manifest load", err);
    berror("engine.boot", `manifest load failed — ${describeError(err)}`);
  }
  // In-flight cleanup: any entry stuck in CREATING or SEEKING from a
  // crash mid-operation gets dropped, and its storage folder removed if
  // present. This used to live in the recovery module; now it's an
  // engine concern because it touches drive-level state (storagePath)
  // and needs to save the trimmed manifest through the engine's own
  // save chain.
  try {
    await cleanupInFlightManifestEntries();
  } catch (err) {
    console.error("[engine] cleanup in-flight", err);
    berror("engine.boot", `cleanup in-flight failed — ${describeError(err)}`);
  }
}

// Drop any entry stuck
// in CREATING or SEEKING (crash mid-share-create or mid-open) and rm
// its corestore folder if we know where it is. Called once from
// loadManifest during engineInit; not exposed.
async function cleanupInFlightManifestEntries() {
  const stale = new Set([DriveState.CREATING, DriveState.SEEKING]);
  const toRemove = [];
  for (const [driveId, meta] of Object.entries(manifest.drives || {})) {
    if (stale.has(meta?.state)) toRemove.push([driveId, meta]);
  }
  if (toRemove.length === 0) return;
  // This path DELETES user-visible drives and their
  // corestore folders at boot. It was entirely silent — a drive vanishing
  // between sessions had no trace at all. Log each removal individually.
  bwarn(
    "engine.boot",
    `cleanup in-flight: removing ${toRemove.length} stale CREATING/SEEKING entr${
      toRemove.length === 1 ? "y" : "ies"
    }`,
  );
  for (const [driveId, meta] of toRemove) {
    bwarn(
      "engine.boot",
      `cleanup removing drive=${driveId} state=${meta?.state} storage=${meta?.storagePath || "none"}`,
    );
    if (meta?.storagePath) {
      try {
        await fs.rm(meta.storagePath, { recursive: true, force: true });
      } catch (err) {
        // Storage already gone; nothing to clean up.
        swallowed("engine.boot", `rm storage for ${driveId}`, err);
      }
    }
    delete manifest.drives[driveId];
    manifest.stats.totalPurged = (manifest.stats.totalPurged || 0) + 1;
  }
  await saveManifest();
}

// Serialize saves through a chain so a burst of state
// transitions (e.g., a rapid create-share followed by activate) can't
// interleave temp-file writes. Each save awaits the previous one's
// rename; the .catch(() => {}) isolates the next save from a failure
// in the previous one so the chain never becomes permanently rejected.
let _saveChain = Promise.resolve();

function saveManifest() {
  const next = _saveChain
    .catch(() => {})
    .then(() => atomicWriteJson(manifestPath, manifest));
  // Almost every caller wraps this in `try { … } catch {}`
  // — a correct best-effort, and previously a blind spot at each of those
  // sites. Reporting the failure here covers all of them at once without
  // changing anyone's control flow (the returned promise is unchanged;
  // this is a detached observer).
  next.catch((err) => {
    berror("engine.manifest", `saveManifest failed — ${describeError(err)}`);
  });
  _saveChain = next;
  return next;
}

/**
 * Liveness counter. The only thing that can distinguish "backgrounded" from
 * "frozen": wall-clock time passes either way, and RN's own timers stop on
 * background regardless, so neither can tell the two apart. This timer runs
 * in the worklet, which keeps executing while merely backgrounded and stops
 * dead when the OS freezes the process.
 *
 * Cost is deliberately near-zero because this ships in release builds: one
 * timer, one integer increment every 30 s. No logging, no allocation, and no
 * IPC per tick — the count rides out on the existing status reply, which RN
 * already requests, so there is no message traffic attributable to this.
 */
const ALIVE_TICK_MS = 30000;
let aliveTicks = 0;
let aliveTimer = null;

function startAliveTicker() {
  if (aliveTimer) return;
  aliveTimer = setInterval(() => {
    aliveTicks++;
  }, ALIVE_TICK_MS);
}

export async function engineInit(documentRoot) {
  const layout = peardropLayout(documentRoot);
  drivesDir = layout.drives;
  downloadsDir = layout.downloads;
  manifestPath = layout.manifestFile;
  await fs.mkdir(drivesDir, { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  await loadManifest();
  initialized = true;
  startAliveTicker();

  // Kick off rehydration in the background. Don't
  // await — engineInit must return promptly so the RN side can flip to
  // "listening" and accept user input. drive-hydrated events stream out
  // as each drive comes online (sequential with ~500 ms spacing).
  engineHydrateDrives().catch((err) => {
    emitEvent({ type: "error", message: `hydrate: ${String(err?.message || err)}` });
  });
}

export function engineIsReady() {
  return initialized;
}

export function normalizeFilePath(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return null;
  if (raw.startsWith("file://")) {
    let pathPart = raw.slice("file://".length);
    if (pathPart.startsWith("//")) pathPart = pathPart.slice(1);
    try {
      return decodeURI(pathPart);
    } catch {
      return pathPart;
    }
  }
  return raw;
}

function generateDriveId(prefix = "drive") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createShareLink(keyHex) {
  return `peardrop://${keyHex}`;
}

function ensureUploadTracker(driveId, driveSize) {
  let tracker = uploadTrackers.get(driveId);
  if (tracker) {
    tracker.driveSize = Math.max(1, Number(driveSize || tracker.driveSize || 1));
    return tracker;
  }

  tracker = {
    driveId,
    driveSize: Math.max(1, Number(driveSize || 1)),
    peers: new Map(),
    totalSentBytes: 0,
    timer: null,
    hasEverConnected: false,
  };
  uploadTrackers.set(driveId, tracker);
  return tracker;
}

function emitUploadProgressSnapshot(tracker) {
  if (!tracker) return;
  const activePeers = Array.from(tracker.peers.values()).filter((peer) => !peer.completed);
  const activeTransferred = activePeers.reduce((sum, peer) => sum + peer.sentBytes, 0);
  const activeTotal = activePeers.length * tracker.driveSize;
  const percent = activeTotal > 0 ? Math.round((activeTransferred / activeTotal) * 100) : 100;

  emitEvent({
    type: "upload-progress",
    driveId: tracker.driveId,
    peerId: activePeers[0]?.peerId || "peer",
    percent: Math.max(0, Math.min(100, percent)),
    bytesTransferred: Math.round(activeTransferred),
    totalBytes: Math.round(activeTotal),
    driveSize: Math.round(tracker.driveSize),
    totalSentBytes: Math.round(tracker.totalSentBytes),
  });
}

// Upload progress comes from real Hyperdrive bytes-uploaded events, not a
// socket.bytesWritten sampler. Hyperswarm sockets are UDX streams that
// don't expose bytesWritten with Node-net semantics, so a sampler emits
// percent=0 forever. This hooks directly into the
// blobs core's 'upload' event — the same signal Hyperdrive's own Monitor
// class uses — and attribute bytes to peers via remotePublicKey, which
// matches the 12-hex peerId derived from swarm peerInfo.publicKey.
//
// Per-peer attribution lets us emit a single, precise upload-complete the
// moment a specific receiver has replicated everything we have. That
// replaces the RN-side 30 s stall detector as the primary completion
// signal (the stall detector is kept as a fallback safety net).
function bindHyperdriveUploadTracking(session) {
  const { drive, driveId, totalBytes } = session;
  if (!drive || !totalBytes) return () => {};

  const tracker = ensureUploadTracker(driveId, totalBytes);

  const onUpload = (_index, bytes, from) => {
    // Hypercore's Peer class sets both peer.remotePublicKey AND
    // peer.stream.remotePublicKey. Try direct first, fall back to stream.
    const remoteKey = from?.remotePublicKey || from?.stream?.remotePublicKey;
    const remoteHex = remoteKey?.toString?.("hex");
    const peerId = remoteHex ? remoteHex.slice(0, 12) : null;
    if (!peerId) return;
    const peer = tracker.peers.get(peerId);
    if (!peer || peer.completed) return;

    const before = peer.sentBytes;
    peer.sentBytes = Math.min(tracker.driveSize, peer.sentBytes + Number(bytes || 0));
    const delta = peer.sentBytes - before;
    if (delta > 0) tracker.totalSentBytes += delta;

    // Completion threshold: 95% covers the case where Hyperdrive's block
    // accounting doesn't perfectly sum to the raw file totalBytes (block
    // overhead, varying block sizes). The receiver-side engineDownload
    // does its own accurate per-byte progress.
    if (!peer.completed && peer.sentBytes >= tracker.driveSize * 0.95) {
      peer.completed = true;
      // This 95% threshold is a heuristic standing in for
      // an exact byte match, because Hyperdrive's block accounting doesn't
      // sum to raw totalBytes (block overhead, varying block sizes) — the
      // same class of drift that made the old UDX `socket.bytesWritten`
      // sampler report 0% forever. A hosted transfer declaring itself
      // complete on an approximation is exactly the "said Sent but nothing
      // arrived" report, so record the numbers behind the decision.
      binfo(
        "engine.upload",
        `peer complete (95% threshold) drive=${driveId} peer=${peerId} ` +
          `sentBytes=${Math.round(peer.sentBytes)} driveSize=${Math.round(tracker.driveSize)} ` +
          `ratio=${(peer.sentBytes / tracker.driveSize).toFixed(3)}`,
      );
      emitEvent({
        type: "upload-complete",
        driveId,
        peerId,
        totalBytes: tracker.driveSize,
        driveSize: tracker.driveSize,
        totalSentBytes: Math.round(tracker.totalSentBytes),
        duration: Date.now() - (peer.connectedAt || Date.now()),
      });
    }

    emitUploadProgressSnapshot(tracker);
  };

  // Hook both blobs (file content) and db (metadata) cores. Blobs is the
  // big one; db is small but completes first and helps confirm a peer is
  // actively pulling.
  drive.ready().then(() => {
    try {
      drive.getBlobs().then((blobs) => {
        if (!blobs) return;
        blobs.core.on("upload", onUpload);
        session._unhookUpload = () => {
          try { blobs.core.off("upload", onUpload); } catch {}
          try { drive.db?.core?.off?.("upload", onUpload); } catch {}
        };
      }).catch(() => {});
      drive.db?.core?.on?.("upload", onUpload);
    } catch {}
  }).catch(() => {});

  return () => {
    if (typeof session._unhookUpload === "function") {
      try { session._unhookUpload(); } catch {}
    }
  };
}

// Mirror of bindHyperdriveUploadTracking for the
// receive side. `engineDownload` was emitting one progress event per
// file *after* `drive.get(key)` resolved — and drive.get blocks until
// every block of that file has been replicated. For a single big file
// the UI saw 0% → 100% with nothing in between. Same primitive as Phase
// GG: hook the blob core's `download` event, accumulate bytes against
// session.totalBytes, emit `upload-progress` with live totals. The
// per-file post-completion emit in engineDownload stays as a
// reconciliation snap so the percent lines up exactly at file
// boundaries even if Hyperdrive's block accounting drifts from raw
// file-byte totals.
function bindHyperdriveDownloadTracking(session) {
  const { drive, driveId } = session;
  if (!drive) return () => {};

  // We accumulate bytes on the session object so engineDownload can
  // also write to it (after each file's fs.writeFile) and so the
  // tracker survives across multiple drive.get calls.
  session._dlBytes = 0;

  // Throttle: download events fire per-block. Emitting one upload-
  // progress event per block (potentially thousands) would flood the
  // RN side. Coalesce to ~10 Hz.
  const MIN_EMIT_INTERVAL_MS = 100;
  let lastEmitAt = 0;
  let pendingEmit = null;

  // Denominator preference order: the current download call's selected-file
  // total (set by engineDownload before drive.get), else the whole-drive
  // total from the manifest, else null (no percent — we still emit
  // bytesTransferred so the UI can show byte-counts in dev mode).
  const totalBytesOf = () => {
    if (typeof session._dlExpected === "number" && session._dlExpected > 0)
      return session._dlExpected;
    if (typeof session.totalBytes === "number" && session.totalBytes > 0)
      return session.totalBytes;
    return null;
  };

  const emitProgress = () => {
    pendingEmit = null;
    lastEmitAt = Date.now();
    const total = totalBytesOf();
    const transferred = session._dlBytes;
    const percent =
      total != null
        ? Math.max(0, Math.min(100, Math.round((transferred / total) * 100)))
        : null;
    emitEvent({
      type: "upload-progress",
      driveId,
      percent: percent ?? 0,
      bytesTransferred: transferred,
      totalBytes: total ?? transferred,
    });
  };

  const onDownload = (_index, bytes, _from) => {
    const delta = Number(bytes || 0);
    if (delta <= 0) return;
    session._dlBytes += delta;

    const now = Date.now();
    if (now - lastEmitAt >= MIN_EMIT_INTERVAL_MS) {
      emitProgress();
    } else if (!pendingEmit) {
      pendingEmit = setTimeout(emitProgress, MIN_EMIT_INTERVAL_MS);
    }
  };

  drive.ready().then(() => {
    try {
      drive.getBlobs().then((blobs) => {
        if (!blobs) return;
        blobs.core.on("download", onDownload);
        session._unhookDownload = () => {
          if (pendingEmit) { clearTimeout(pendingEmit); pendingEmit = null; }
          try { blobs.core.off("download", onDownload); } catch {}
          try { drive.db?.core?.off?.("download", onDownload); } catch {}
        };
      }).catch(() => {});
      drive.db?.core?.on?.("download", onDownload);
    } catch {}
  }).catch(() => {});

  return () => {
    if (typeof session._unhookDownload === "function") {
      try { session._unhookDownload(); } catch {}
    }
  };
}

// Coarse "still alive" tick: keeps tracker totals fresh even when the
// upload-event burst is delivered between snapshots. The old per-second
// timer is retained but it no longer reads bytesWritten — it just emits
// the current snapshot so the UI keeps seeing fresh `lastEventAt` and
// progressEverReceived stays sticky.
function startUploadTrackerTimer(tracker) {
  if (!tracker || tracker.timer) return;
  tracker.timer = setInterval(() => {
    if (!tracker.peers.size) return;
    emitUploadProgressSnapshot(tracker);
  }, 1000);
}

function stopUploadTracker(driveId) {
  const tracker = uploadTrackers.get(driveId);
  if (!tracker) return;
  if (tracker.timer) clearInterval(tracker.timer);
  uploadTrackers.delete(driveId);
}

export function parseShareLink(link) {
  if (!link || typeof link !== "string") return null;
  const trimmed = link.trim();
  if (/^peardrop:\/\//i.test(trimmed)) {
    const rest = trimmed.replace(/^peardrop:\/\//i, "").split(/[?#]/)[0];
    if (/^[a-fA-F0-9]{64}$/.test(rest)) return rest.toLowerCase();
    return null;
  }
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

// Attach a fresh Hyperswarm session to a hosted (or rehydrated) drive.
// Hooks the same upload event + peer lifecycle that `engineShareFromPaths`
// installs, so hydrated drives behave identically to freshly-created ones.
function attachHostSwarm(session) {
  const { driveId, drive, store, totalBytes } = session;
  const swarm = new Hyperswarm();

  swarm.on("connection", (socket, peerInfo) => {
    const hex = peerInfo?.publicKey?.toString?.("hex");
    const peerId = hex ? hex.slice(0, 12) : "peer";
    emitEvent({ type: "peer-connected", driveId, peerId });

    const tracker = ensureUploadTracker(driveId, totalBytes);
    tracker.hasEverConnected = true;
    tracker.peers.set(peerId, {
      peerId,
      socket,
      sentBytes: 0,
      connectedAt: Date.now(),
      completed: false,
    });
    // Peer lines carry driveId + peerId + the live
    // peer count. "Peer connected" on its own never told us which drive
    // or how many were already attached.
    binfo(
      "engine.peer",
      `host peer-connected drive=${driveId} peer=${peerId} peers=${tracker.peers.size}`,
    );
    emitUploadProgressSnapshot(tracker);
    startUploadTrackerTimer(tracker);

    store.replicate(socket);
    socket.on("close", () => {
      emitEvent({ type: "peer-disconnected", driveId, peerId });
      const liveTracker = uploadTrackers.get(driveId);
      if (!liveTracker) {
        binfo(
          "engine.peer",
          `host peer-disconnected drive=${driveId} peer=${peerId} (tracker already gone)`,
        );
        return;
      }
      const peer = liveTracker.peers.get(peerId);
      liveTracker.peers.delete(peerId);
      binfo(
        "engine.peer",
        `host peer-disconnected drive=${driveId} peer=${peerId} peers=${liveTracker.peers.size} ` +
          `sentBytes=${Math.round(peer?.sentBytes || 0)} completed=${!!peer?.completed}`,
      );
      emitUploadProgressSnapshot(liveTracker);
    });
  });

  bindHyperdriveUploadTracking(session);

  const done = drive.findingPeers();
  // Announce must stay traced — without it, "peers stopped finding me"
  // has no evidence at all. Log the join and the flush result.
  binfo("engine.swarm", `join drive=${driveId} announcing discoveryKey`);
  swarm.join(drive.discoveryKey);
  swarm.flush().then(
    () => {
      binfo("engine.swarm", `flush ok drive=${driveId} (announce propagated)`);
      done();
    },
    (err) => {
      bwarn("engine.swarm", `flush failed drive=${driveId} — ${describeError(err)}`);
      done();
    },
  );

  return swarm;
}

// Rehydrate previously-active drives from disk on
// engine boot. Approach A — corestore rehydration. The corestore under
// `peardrop/drives/<driveId>/` already contains every block ever written,
// so we just reopen it, recreate the Hyperdrive with the recorded key,
// re-attach a swarm, and the drive is announceable again. No need to
// re-read original files (which may have moved or been deleted).
//
// Rehydrates ONLY entries with `state === "active"`. Entries the user
// explicitly stopped (`stopped`, `purged`) or that failed mid-creation
// (`creating`, `error` set) are skipped — those represent the user's
// "I don't want this anymore" signal.
//
// Hydration is sequential with a small inter-drive delay to avoid swarm
// strain on boot. Failure on a single drive is non-fatal: the manifest
// entry is left untouched and the failure lands
// in the in-memory `resumeErrors` map instead, so the next boot
// re-attempts. A drive that succeeded on this boot has any stale
// resumeError cleared.
function recordHydrateFailure(driveId, message, detail) {
  resumeErrors.set(driveId, { error: message, at: Date.now() });
  // resumeErrors must carry more than a bare message string: give the
  // trace the typed category/cause shape the rest of the taxonomy uses.
  berror(
    "engine.hydrate",
    `hydrate failed drive=${driveId} category=drive.hydrate-fail cause=hydrate-fail ` +
      `message=${JSON.stringify(String(message))}` +
      (detail !== undefined ? ` detail=${describeError(detail)}` : ""),
  );
  emitEvent({
    type: "drive-hydration-failed",
    driveId,
    error: message,
  });
}

export async function engineHydrateDrives() {
  if (!initialized) {
    return {
      ...failure("engine.not-initialized", "not-initialized", "Engine not initialized"),
      hydrated: 0,
    };
  }

  // Hydrate both ACTIVE (full hydration — open store, attach swarm)
  // AND INACTIVE entries (light hydration — RN learns the drive exists, no
  // swarm contact). The legacy STOPPED state is mapped to INACTIVE so older
  // manifests behave correctly.
  // The filter must not drop drives silently — a bad key or a missing
  // storagePath would mean the drive simply never appears, with nothing
  // anywhere saying why. Each rejection names its reason.
  const all = Object.values(manifest.drives || {});
  const entries = all.filter((d) => {
    if (!d || typeof d !== "object") {
      bwarn("engine.hydrate", "skip: malformed manifest entry");
      return false;
    }
    const s = normalizeState(d.state);
    if (s !== DriveState.ACTIVE && s !== DriveState.INACTIVE) {
      bdebug("engine.hydrate", `skip drive=${d.driveId} reason=state-not-hydratable state=${d.state}`);
      return false;
    }
    if (!d.key || !/^[a-fA-F0-9]{64}$/.test(String(d.key))) {
      bwarn("engine.hydrate", `skip drive=${d.driveId} reason=key-missing-or-invalid`);
      return false;
    }
    if (!d.storagePath) {
      bwarn("engine.hydrate", `skip drive=${d.driveId} reason=storagepath-missing`);
      return false;
    }
    if (activeDrives.has(d.driveId)) {
      bdebug("engine.hydrate", `skip drive=${d.driveId} reason=already-active`);
      return false;
    }
    return true;
  });

  binfo(
    "engine.hydrate",
    `hydrate start: ${entries.length} of ${all.length} manifest entries eligible`,
  );

  let hydrated = 0;
  let failed = 0;
  for (const entry of entries) {
    const targetState = normalizeState(entry.state);
    try {
      try {
        await fs.access(entry.storagePath);
      } catch {
        // Non-destructive. Do not mark the entry as
        // "failed" in the manifest — a transient error (permission blip,
        // race with an OS scan) used to permanently demote the drive.
        // Track the failure in memory only; emit the standard event so
        // RN can surface it if desired; next boot re-attempts.
        recordHydrateFailure(entry.driveId, "Storage directory missing");
        failed++;
        continue;
      }

      if (targetState === DriveState.INACTIVE) {
        bdebug(
          "engine.hydrate",
          `drive=${entry.driveId} light-hydrate (inactive, no swarm, no corestore)`,
        );
        // Light hydration: announce the entry to RN without joining the
        // swarm or opening the corestore. The corestore is only touched
        // again when the user activates the drive.
        // Also clear any stale resumeError — the
        // drive light-hydrated cleanly this boot.
        resumeErrors.delete(entry.driveId);
        emitEvent({
          type: "drive-hydrated",
          driveId: entry.driveId,
          shareLink: createShareLink(entry.key),
          key: entry.key,
          state: DriveState.INACTIVE,
          origin: entry.origin || "hosted",
        });
        hydrated++;
        continue;
      }

      // Full hydration path (ACTIVE).
      bdebug("engine.hydrate", `drive=${entry.driveId} full-hydrate: opening corestore`);
      const store = new Corestore(entry.storagePath);
      await store.ready();
      const drive = new Hyperdrive(store, b4a.from(entry.key, "hex"));
      await drive.ready();
      bdebug(
        "engine.hydrate",
        `drive=${entry.driveId} corestore+hyperdrive ready, bytes=${entry.totalBytes || 0}`,
      );

      const totalBytes = Number(entry.totalBytes || 0);
      const session = {
        driveId: entry.driveId,
        drive,
        store,
        swarm: null,
        metadata: entry,
        totalBytes,
        isReceiving: (entry.origin || "hosted") === "received",
        shareLink: createShareLink(entry.key),
      };
      const swarm = attachHostSwarm(session);
      session.swarm = swarm;

      activeDrives.set(entry.driveId, session);
      // A successful hydrate clears any stale
      // resumeError left over from a prior boot's transient failure.
      resumeErrors.delete(entry.driveId);
      emitEvent({
        type: "drive-hydrated",
        driveId: entry.driveId,
        shareLink: session.shareLink,
        key: entry.key,
        state: DriveState.ACTIVE,
        origin: entry.origin || "hosted",
      });
      hydrated++;
    } catch (err) {
      // Non-destructive. Do not persist "failed".
      recordHydrateFailure(entry.driveId, String(err?.message || err), err);
      failed++;
    }

    if (targetState === DriveState.ACTIVE) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  binfo(
    "engine.hydrate",
    `hydrate done: hydrated=${hydrated} failed=${failed} considered=${entries.length}`,
  );
  return { ok: true, hydrated, failed, considered: entries.length };
}

// Nudge every active drive's swarm to re-announce.
// Called by RN on AppState background→active transitions and on a 90 s
// foreground interval. Cheap: swarm.flush() pushes any pending announces
// and refreshes the DHT presence.
//
// Hyperswarm 4.17.0 already runs its own peer discovery + reconnection
// internally with sensible defaults (DHT-driven). We don't reinvent retry
// on top of it — this function just nudges every active drive to push out
// a fresh announce after a network change (Wi-Fi roam, return from
// background). For drives that have never connected since creation OR
// have had no peers for a while, we additionally leave + rejoin the
// topic, which fully resets the DHT record. Cheap enough to do on every
// refresh tick when the condition holds.
export async function engineRefreshSwarm() {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }

  const flushes = [];
  let rejoined = 0;

  // This runs on a 90 s foreground interval and on every
  // background→active transition, and it was entirely silent. When a
  // tester reports "it worked, then peers stopped finding me", this is
  // the loop whose behaviour we need to see.
  bdebug("engine.swarm", `refresh start: ${activeDrives.size} active drive(s)`);

  for (const session of activeDrives.values()) {
    if (!session.swarm) {
      bdebug("engine.swarm", `refresh skip drive=${session.driveId} reason=no-swarm`);
      continue;
    }
    if (session.isReceiving) {
      // Receivers don't need re-announce; their swarm join is driven by
      // the host they're connecting to. Just flush to be safe.
      bdebug("engine.swarm", `refresh flush-only drive=${session.driveId} reason=receiver`);
      flushes.push(session.swarm.flush().catch((err) => {
        swallowed("engine.swarm", `receiver flush ${session.driveId}`, err);
      }));
      continue;
    }

    const tracker = uploadTrackers.get(session.driveId);
    const noPeersRightNow = !tracker || tracker.peers.size === 0;

    try {
      if (noPeersRightNow && session.drive?.discoveryKey) {
        // Full DHT record reset: leave then rejoin.
        binfo(
          "engine.swarm",
          `refresh rejoin drive=${session.driveId} reason=no-peers (leave+join, DHT record reset)`,
        );
        try {
          await session.swarm.leave(session.drive.discoveryKey);
        } catch (err) {
          swallowed("engine.swarm", `leave ${session.driveId}`, err);
        }
        session.swarm.join(session.drive.discoveryKey);
        rejoined++;
      } else {
        bdebug(
          "engine.swarm",
          `refresh flush drive=${session.driveId} peers=${tracker?.peers.size ?? 0}`,
        );
      }
      flushes.push(session.swarm.flush().catch((err) => {
        swallowed("engine.swarm", `flush ${session.driveId}`, err);
      }));
    } catch (err) {
      bwarn("engine.swarm", `refresh failed drive=${session.driveId} — ${describeError(err)}`);
    }
  }

  await Promise.all(flushes);
  binfo("engine.swarm", `refresh done: refreshed=${flushes.length} rejoined=${rejoined}`);
  return { ok: true, refreshed: flushes.length, rejoined };
}

// `relPaths` (optional) is a parallel array of subdirectory paths inside a
// shared folder. When set, relPaths[i] becomes the storage path for the
// matching file, preserving folder structure on the receiver. When unset
// (or empty), each file flattens to its basename — the file-share behavior.
export async function engineShareFromPaths(paths, relPaths) {
  if (!initialized) {
    throw new EngineError({
      category: "engine.not-initialized",
      cause: "not-initialized",
      message: "Engine not initialized",
    });
  }

  const sanitizeRel = (raw) => {
    if (!raw) return null;
    const cleaned = String(raw)
      .replace(/\\/g, "/")
      .replace(/\.\./g, "")
      .replace(/^\/+/, "")
      .trim();
    return cleaned || null;
  };

  // Stat the files up-front instead of reading their bytes.
  // Stat validates readability and captures the authoritative size for
  // the manifest — keeping the pre-existing "fail fast if anything is
  // unreadable" semantic without holding any file content in memory.
  binfo(
    "engine.share",
    `share requested: ${paths.length} path(s), relPaths=${relPaths ? "yes" : "no"}`,
  );

  const fileList = [];
  for (let i = 0; i < paths.length; i++) {
    const uri = paths[i];
    const fp = normalizeFilePath(uri);
    if (!fp) {
      bwarn("engine.share", `skip path[${i}] reason=unnormalizable input=${JSON.stringify(String(uri))}`);
      continue;
    }
    try {
      const stats = await fs.stat(fp);
      const name = path.basename(fp);
      const rel = relPaths ? sanitizeRel(relPaths[i]) : null;
      bdebug("engine.share", `stat ok ${name} size=${stats.size} rel=${rel || "-"}`);
      fileList.push({ path: fp, name, size: stats.size, relPath: rel });
    } catch (err) {
      return failure(
        "share.file-read-fail",
        "share-file-unreadable",
        `Cannot read file (${fp}): ${err.message || err}`,
        { path: fp, code: err?.code },
      );
    }
  }

  if (!fileList.length) {
    return failure(
      "share.no-readable-files",
      "no-readable-files",
      "No readable files. Pick files with “copy to cache” so paths are readable file:// paths.",
    );
  }

  const driveId = generateDriveId("drive");
  const drivePath = path.join(drivesDir, driveId);

  let store;
  let drive;
  try {
    store = new Corestore(drivePath);
    await store.ready();

    drive = new Hyperdrive(store);
    await drive.ready();
  } catch (err) {
    return failure(
      "share.drive-create-fail",
      "hyperdrive-create-fail",
      `Failed to create drive: ${err.message || err}`,
      { code: err?.code },
    );
  }

  const key = b4a.toString(drive.key, "hex");

  const metadata = {
    driveId,
    key,
    state: DriveState.CREATING,
    origin: "hosted",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ttlMs: 0,
    expiresAt: null,
    name: fileList.length === 1 ? fileList[0].name : `${fileList.length} files`,
    files: [],
    totalBytes: 0,
    storagePath: drivePath,
  };

  manifest.drives[driveId] = metadata;
  manifest.stats.totalCreated++;
  binfo(
    "engine.share",
    `drive created drive=${driveId} key=${key.slice(0, 12)}… files=${fileList.length} name=${JSON.stringify(metadata.name)}`,
  );
  setDriveState(metadata, DriveState.CREATING, "engineShareFromPaths: begin");
  await saveManifest();

  // The wire caps a drive manifest at 1000 entries. Over
  // that, the receiver silently sees a truncated list — worth a loud line
  // on the sending side too, not just the receiver's truncation hint.
  if (fileList.length > DRIVE_MANIFEST_MAX_FILES) {
    bwarn(
      "engine.share",
      `file count ${fileList.length} exceeds DRIVE_MANIFEST_MAX_FILES=${DRIVE_MANIFEST_MAX_FILES} — receiver will see a truncated list`,
    );
  }

  try {
    let totalBytes = 0;
    const fileEntries = [];

    // Stream each file in sequentially. The size already came
    // from fs.stat above so the manifest entry doesn't depend on byte
    // counters flowing through the pipe. Sequential by design — parallel
    // transfers were explicitly descoped from this sprint.
    let piped = 0;
    for (const f of fileList) {
      const storagePath = f.relPath || f.name;
      const pipeStart = Date.now();
      await pipeFileToDrive(f.path, drive, `/${storagePath}`);
      piped++;
      bdebug(
        "engine.share",
        `piped ${piped}/${fileList.length} → /${storagePath} size=${f.size} in ${Date.now() - pipeStart}ms`,
      );
      totalBytes += f.size;
      fileEntries.push({
        name: f.name,
        storagePath,
        size: f.size,
        addedAt: Date.now(),
      });
    }

    const peardropManifest = {
      version: DRIVE_MANIFEST_VERSION,
      name: metadata.name,
      created: Date.now(),
      files: fileEntries.map((f) => ({
        path: `/${f.storagePath}`,
        name: f.name,
        size: f.size,
      })),
      totalBytes,
      totalFiles: fileEntries.length,
    };

    const manifestBlob = b4a.from(JSON.stringify(peardropManifest), "utf8");
    await drive.put(DRIVE_MANIFEST_PATH, manifestBlob);
    binfo(
      "engine.share",
      `manifest blob written drive=${driveId} path=${DRIVE_MANIFEST_PATH} ` +
        `bytes=${manifestBlob.byteLength} files=${fileEntries.length} totalBytes=${totalBytes}`,
    );

    metadata.files = fileEntries;
    metadata.totalBytes = totalBytes;
    setDriveState(metadata, DriveState.ACTIVE, "engineShareFromPaths: files piped + manifest written");
    metadata.lastActivityAt = Date.now();
    manifest.stats.totalBytesShared += totalBytes;
    await saveManifest();

    const session = {
      driveId,
      drive,
      store,
      swarm: null,
      metadata,
      totalBytes,
      isReceiving: false,
      shareLink: createShareLink(key),
    };

    const swarm = attachHostSwarm(session);
    session.swarm = swarm;

    activeDrives.set(driveId, session);

    const shareLink = createShareLink(key);
    emitEvent({ type: "drive-created", driveId, shareLink });

    return { ok: true, driveId, shareLink, key };
  } catch (err) {
    berror("engine.share", `share create failed drive=${driveId} — ${describeError(err)}`);
    setDriveState(metadata, DriveState.STOPPED, "engineShareFromPaths: create failed");
    metadata.error = String(err?.message || err);
    await saveManifest();
    try {
      await drive?.close?.();
    } catch (e) {
      swallowed("engine.share", "drive.close on create-fail", e);
    }
    try {
      await store?.close?.();
    } catch (e) {
      swallowed("engine.share", "store.close on create-fail", e);
    }
    try {
      await fs.rm(drivePath, { recursive: true, force: true });
    } catch (e) {
      swallowed("engine.share", "rm drivePath on create-fail", e);
    }
    // Normalize the rethrow so uncaught bubbles have typed
    // shape too. Preserves the underlying err via detail.code.
    throw wrapError(err, {
      category: "share.drive-create-fail",
      cause: "share-add-files-fail",
    });
  }
}

export async function engineOpenDrive(shareLink) {
  if (!initialized) {
    throw new EngineError({
      category: "engine.not-initialized",
      cause: "not-initialized",
      message: "Engine not initialized",
    });
  }

  const keyHex = parseShareLink(shareLink);
  if (!keyHex) {
    // The EngineError constructor logs the typed failure; add the input
    // shape (never the raw link — see the privacy note) for context.
    bwarn(
      "engine.open",
      `link rejected: length=${String(shareLink || "").trim().length} hasScheme=${/^peardrop:\/\//i.test(String(shareLink || "").trim())}`,
    );
    return failure(
      "receive.invalid-link",
      "invalid-link",
      "Invalid peardrop link (expect peardrop:// + 64 hex chars).",
    );
  }

  const driveId = generateDriveId("recv");
  const drivePath = path.join(drivesDir, driveId);
  binfo("engine.open", `link parsed ok drive=${driveId} key=${keyHex.slice(0, 12)}…`);

  const store = new Corestore(drivePath);
  await store.ready();

  const drive = new Hyperdrive(store, b4a.from(keyHex, "hex"));
  await drive.ready();
  bdebug("engine.open", `corestore+hyperdrive opened drive=${driveId} at ${drivePath}`);

  // D3.4: persist a SEEKING entry so the corestore folder isn't an orphan
  // if the user kills the app before the open resolves. The cleanup pass
  // on next boot removes any SEEKING entries with their storagePath.
  manifest.drives[driveId] = {
    driveId,
    key: keyHex,
    state: DriveState.SEEKING,
    origin: "received",
    shareLink: shareLink.trim(),
    storagePath: drivePath,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    name: "Connecting…",
    files: [],
    totalBytes: 0,
  };
  // D3.4's SEEKING entry is what the boot-time cleanup later deletes if we
  // never finish — worth a line so an orphan removal has a matching origin.
  binfo("engine.open", `SEEKING entry persisted drive=${driveId} storage=${drivePath}`);
  await saveManifest();

  const swarm = new Hyperswarm();
  // Receive-side peer count, so the log can distinguish
  // "no peer ever arrived" from "a peer arrived and then dropped".
  const connectedPeerIds = new Set();

  swarm.on("connection", (socket, peerInfo) => {
    // Derive a stable 12-char peerId from the remote public key so multiple
    // senders on the same received drive don't collapse into one entry in
    // the RN-side peerIds set (which dedupes by string).
    const hex = peerInfo?.publicKey?.toString?.("hex");
    const peerId = hex ? hex.slice(0, 12) : "peer";
    connectedPeerIds.add(peerId);
    binfo(
      "engine.peer",
      `recv peer-connected drive=${driveId} peer=${peerId} peers=${connectedPeerIds.size}`,
    );
    emitEvent({ type: "peer-connected", driveId, peerId });
    store.replicate(socket);
    socket.on("close", () => {
      connectedPeerIds.delete(peerId);
      binfo(
        "engine.peer",
        `recv peer-disconnected drive=${driveId} peer=${peerId} peers=${connectedPeerIds.size} (sender dropped)`,
      );
      emitEvent({ type: "peer-disconnected", driveId, peerId });
      emitEvent({ type: "download-peer-disconnected", driveId });
    });
  });

  const done = drive.findingPeers();
  binfo("engine.open", `joining swarm drive=${driveId}, seeking peers`);
  swarm.join(drive.discoveryKey);
  const flushStart = Date.now();
  await swarm.flush();
  binfo(
    "engine.open",
    `swarm.flush returned drive=${driveId} in ${Date.now() - flushStart}ms peers=${connectedPeerIds.size}`,
  );
  done();

  const pendingConnection = {
    driveId,
    aborted: false,
    cleanup: async () => {
      // Four best-effort teardown steps, each otherwise a
      // bare `catch {}`. Behaviour unchanged; the failures are now visible.
      bdebug("engine.open", `cleanup start drive=${driveId}`);
      try {
        await swarm.destroy();
      } catch (e) {
        swallowed("engine.open", `swarm.destroy ${driveId}`, e);
      }
      try {
        await drive.close();
      } catch (e) {
        swallowed("engine.open", `drive.close ${driveId}`, e);
      }
      try {
        await store.close();
      } catch (e) {
        swallowed("engine.open", `store.close ${driveId}`, e);
      }
      try {
        await fs.rm(drivePath, { recursive: true, force: true });
      } catch (e) {
        swallowed("engine.open", `rm ${drivePath}`, e);
      }
      // D3.4: drop the SEEKING manifest entry so we don't leak a stale
      // record pointing at a folder we just removed.
      if (manifest.drives[driveId]) {
        delete manifest.drives[driveId];
        try {
          await saveManifest();
        } catch (e) {
          swallowed("engine.open", `saveManifest after cleanup ${driveId}`, e);
        }
      }
      bdebug("engine.open", `cleanup done drive=${driveId}`);
    },
  };
  pendingConnections.set(driveId, pendingConnection);

  const updatePromise = drive.update({ wait: true });
  const abortPromise = new Promise((_, reject) => {
    const intervalId = setInterval(() => {
      if (pendingConnection.aborted) {
        clearInterval(intervalId);
        reject(new Error("Connection cancelled by user"));
      }
    }, 100);
    pendingConnection.abortCheck = intervalId;
  });

  const updateStart = Date.now();
  bdebug("engine.open", `awaiting drive.update({wait:true}) drive=${driveId} (racing user abort)`);
  try {
    await Promise.race([updatePromise, abortPromise]);
    binfo(
      "engine.open",
      `drive.update resolved drive=${driveId} in ${Date.now() - updateStart}ms (head metadata received)`,
    );
    if (pendingConnection.abortCheck) {
      clearInterval(pendingConnection.abortCheck);
    }
  } catch (err) {
    // Either the user aborted or the update genuinely failed. Which one it
    // was matters a lot when reading back a "nothing happened" report.
    const cancelled = /cancell?ed/i.test(String(err?.message || ""));
    bwarn(
      "engine.open",
      `open ${cancelled ? "aborted by user" : "failed"} drive=${driveId} after ` +
        `${Date.now() - updateStart}ms peers=${connectedPeerIds.size} — ${describeError(err)}`,
    );
    if (pendingConnection.abortCheck) {
      clearInterval(pendingConnection.abortCheck);
    }
    pendingConnections.delete(driveId);
    await pendingConnection.cleanup();
    // Distinguish user-cancellation from other open failures.
    // The abort race throws with "Connection cancelled by user" — the
    // cause label makes it easy for RN to hide the toast on cancel.
    const isCancel = /cancell?ed/i.test(String(err?.message || ""));
    return {
      ok: false,
      error: wrapError(err, {
        category: isCancel ? "receive.cancelled" : "receive.open-fail",
        cause: isCancel ? "open-cancelled" : "receive-open-fail",
      }),
    };
  }

  pendingConnections.delete(driveId);

  let files = [];
  let manifestData = null;
  let totalBytes = 0;
  let shareName = null;
  let truncated = null;

  try {
    const raw = await drive.get(DRIVE_MANIFEST_PATH);
    if (!raw) {
      // THE empty-manifest bug origin. drive.update()
      // resolves on head metadata, not on blob replication — so the
      // manifest blob may not have streamed yet. This catch used to be a
      // bare `catch {}` and a null `raw` produced no signal at all; the
      // receiver then fell through to drive.list("/") (which only sees
      // locally-replicated entries), got zero files, and the user saw
      // "0 files in here". This line is the difference between diagnosing
      // that in a minute and never seeing it.
      bwarn(
        "engine.open",
        `manifest blob ${DRIVE_MANIFEST_PATH} not yet replicated drive=${driveId} — will fall back to drive.list()`,
      );
    } else if (raw.byteLength > DRIVE_MANIFEST_MAX_SIZE) {
      bwarn(
        "engine.open",
        `manifest blob oversized drive=${driveId} bytes=${raw.byteLength} max=${DRIVE_MANIFEST_MAX_SIZE} — ignoring`,
      );
    }
    if (raw && raw.byteLength <= DRIVE_MANIFEST_MAX_SIZE) {
      manifestData = JSON.parse(b4a.toString(raw, "utf8"));
      binfo(
        "engine.open",
        `manifest blob parsed drive=${driveId} version=${manifestData?.version} ` +
          `files=${Array.isArray(manifestData?.files) ? manifestData.files.length : "n/a"} ` +
          `totalBytes=${manifestData?.totalBytes ?? "n/a"}`,
      );
      if (
        manifestData.version === DRIVE_MANIFEST_VERSION &&
        Array.isArray(manifestData.files)
      ) {
        shareName = manifestData.name;
        totalBytes = manifestData.totalBytes || 0;
        // D5.1: surface a truncation hint when the manifest declares more
        // files than the 1000-entry cap allows. The cap is wire-level
        // (DRIVE_MANIFEST_MAX_FILES) and applies equally to both sides;
        // before this hint, mobile silently dropped the overflow.
        if (manifestData.files.length > DRIVE_MANIFEST_MAX_FILES) {
          truncated = {
            available: manifestData.files.length,
            shown: DRIVE_MANIFEST_MAX_FILES,
          };
          bwarn(
            "engine.open",
            `manifest truncated drive=${driveId} available=${manifestData.files.length} shown=${DRIVE_MANIFEST_MAX_FILES}`,
          );
        }
        files = manifestData.files.slice(0, DRIVE_MANIFEST_MAX_FILES).map((f) => {
          // D1.1: when `path` is missing from the manifest entry, fall back
          // to the basename. Previous behavior produced `name: "/"` which
          // the receiver can't `drive.get`. Matches desktop's fallback.
          const rawPath = f.path || f.name || "";
          const safePath = String(rawPath)
            .replace(/\.\./g, "")
            .replace(/^\/+/, "/");
          const finalName = safePath
            ? safePath.startsWith("/") ? safePath : `/${safePath}`
            : "";
          return {
            name: finalName,
            displayName: f.name,
            size: f.size || 0,
          };
        });
      }
    }
  } catch (err) {
    bwarn("engine.open", `manifest read/parse failed drive=${driveId} — ${describeError(err)}`);
  }

  if (files.length === 0) {
    // Fallback: enumerate whatever has replicated locally. This is the
    // path that silently yields zero files in the pre-replication window.
    bwarn("engine.open", `falling back to drive.list("/") drive=${driveId} (no usable manifest)`);
    for await (const entry of drive.list("/")) {
      if (entry.key === MANIFEST_DOWNLOAD_SKIP) continue;
      files.push({
        name: entry.key,
        displayName: path.basename(entry.key),
        size: entry.value?.blob?.byteLength || 0,
      });
    }
    totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length === 0) {
      berror(
        "engine.open",
        `EMPTY RESOLVE drive=${driveId} — manifest unavailable AND drive.list() returned nothing; ` +
          `peers=${connectedPeerIds.size}. This is the "0 files in here" state; blobs likely not replicated yet.`,
      );
    } else {
      binfo("engine.open", `drive.list() fallback found ${files.length} file(s) totalBytes=${totalBytes}`);
    }
  }

  // Transition the SEEKING entry to ACTIVE rather than deleting
  // it. The receiver drive is now a first-class manifest entry — preserved
  // across restarts, eligible for explicit activate/deactivate. After
  // engineDownload completes the entry settles into INACTIVE.
  const meta = manifest.drives[driveId] || {};
  meta.driveId = driveId;
  meta.key = keyHex;
  setDriveState(meta, DriveState.ACTIVE, "engineOpenDrive: resolve complete");
  meta.origin = "received";
  meta.shareLink = shareLink.trim();
  meta.storagePath = drivePath;
  meta.lastActivityAt = Date.now();
  meta.name = shareName || meta.name || "Received";
  meta.totalBytes = totalBytes;
  meta.files = files.map((f) => ({
    name: f.displayName || f.name,
    storagePath: f.name?.replace?.(/^\//, "") || f.name,
    size: f.size || 0,
  }));
  manifest.drives[driveId] = meta;
  try { await saveManifest(); } catch {}

  const session = {
    driveId,
    drive,
    store,
    swarm,
    isReceiving: true,
    manifest: manifestData,
    totalBytes,
    shareName,
    shareLink: shareLink.trim(),
    metadata: meta,
    files,
  };
  activeDrives.set(driveId, session);

  // Stream live progress events as blocks land,
  // not just one event per file-completion. Hooks blobs.core / db.core
  // 'download' so the receiver UI shows real movement on big files.
  bindHyperdriveDownloadTracking(session);

  binfo(
    "engine.open",
    `open complete drive=${driveId} files=${files.length} totalBytes=${totalBytes} ` +
      `hasManifest=${!!manifestData} shareName=${JSON.stringify(shareName || "")} truncated=${!!truncated}`,
  );

  return {
    ok: true,
    driveId,
    files,
    shareName,
    totalBytes,
    hasManifest: !!manifestData,
    truncated,
  };
}

export function engineAbortOpen(driveId) {
  let abortedCount = 0;
  if (driveId) {
    const pending = pendingConnections.get(driveId);
    if (pending) {
      pending.aborted = true;
      abortedCount = 1;
    }
    binfo(
      "engine.open",
      `abort requested drive=${driveId} matched=${abortedCount} pending=${pendingConnections.size}`,
    );
    return { ok: true, aborted: abortedCount };
  }
  for (const pending of pendingConnections.values()) {
    pending.aborted = true;
    abortedCount++;
  }
  binfo("engine.open", `abort-all requested, aborted=${abortedCount}`);
  return { ok: true, aborted: abortedCount };
}

export async function engineStopDrive(driveId, opts = { purge: true }) {
  const fakeSession = fakeSessions.get(driveId);
  if (fakeSession) {
    if (fakeSession.state) fakeSession.state.completed = true;
    if (fakeSession.intervalId) clearInterval(fakeSession.intervalId);
    for (const timer of fakeSession.timers || []) {
      try {
        clearTimeout(timer);
      } catch {}
      try {
        clearInterval(timer);
      } catch {}
    }
    fakeSessions.delete(driveId);
    emitEvent({ type: "drive-stopped", driveId, purged: opts.purge !== false });
    return { ok: true };
  }

  const session = activeDrives.get(driveId);
  if (!session) {
    return failure("drive.not-active", "drive-not-active", "Drive not active");
  }

  const purge = opts.purge !== false;
  binfo("engine.stop", `stop drive=${driveId} purge=${purge} (purge deletes local storage)`);

  // Detach the download-event listener (if any) before closing
  // the drive so blobs.core doesn't keep firing into a stale closure.
  if (typeof session._unhookDownload === "function") {
    try {
      session._unhookDownload();
    } catch (e) {
      swallowed("engine.stop", `unhook download ${driveId}`, e);
    }
  }

  if (session.swarm) {
    try {
      await session.swarm.destroy();
    } catch (e) {
      swallowed("engine.stop", `swarm.destroy ${driveId}`, e);
    }
  }
  if (session.drive) {
    try {
      await session.drive.close();
    } catch (e) {
      swallowed("engine.stop", `drive.close ${driveId}`, e);
    }
  }
  if (session.store) {
    try {
      await session.store.close();
    } catch (e) {
      swallowed("engine.stop", `store.close ${driveId}`, e);
    }
  }

  const storagePath = session.metadata?.storagePath;
  if (purge && storagePath) {
    bwarn("engine.stop", `purging local storage drive=${driveId} path=${storagePath}`);
    try {
      await fs.rm(storagePath, { recursive: true, force: true });
    } catch (e) {
      swallowed("engine.stop", `rm storage ${driveId}`, e);
    }
  }

  const meta = manifest.drives[driveId];
  if (meta) {
    setDriveState(
      meta,
      purge ? DriveState.PURGED : DriveState.STOPPED,
      `engineStopDrive: purge=${purge}`,
    );
    meta.stoppedAt = Date.now();
    if (purge) manifest.stats.totalPurged++;
    await saveManifest();
  }

  activeDrives.delete(driveId);
  stopUploadTracker(driveId);
  emitEvent({ type: "drive-stopped", driveId, purged: purge });

  return { ok: true };
}

async function uniquePath(destPath) {
  try {
    await fs.access(destPath);
  } catch {
    return destPath;
  }
  const dir = path.dirname(destPath);
  const baseName = path.basename(destPath);
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  for (let i = 1; i < 9999; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return destPath;
}

// D2.4: same disambiguation pattern for folders (no extension splitting).
async function uniqueFolderPath(destPath) {
  try {
    await fs.access(destPath);
  } catch {
    return destPath;
  }
  const dir = path.dirname(destPath);
  const baseName = path.basename(destPath);
  for (let i = 1; i < 9999; i++) {
    const candidate = path.join(dir, `${baseName} (${i})`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return destPath;
}

// Stream a file from disk into the drive. Replaces the
// `fs.readFile(...) → drive.put(name, buf)` pair, which held the whole
// file in memory and OOM'd on media around 200-300 MB.
//
// Production handling lifted from the PoC investigation:
//   - await 'close' not 'finish' — Hyperdrive commits the in-drive bee
//     entry inside `final()`; 'close' fires after that completes.
//   - listen on both ends + once() + settled guard so a read error
//     followed by a write close (or vice versa) doesn't double-settle.
//   - errors propagate; the outer caller's catch handles cleanup.
function pipeFileToDrive(srcPath, drive, driveStoragePath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    let rs;
    let ws;
    try {
      rs = createReadStream(srcPath);
      ws = drive.createWriteStream(driveStoragePath);
    } catch (err) {
      return done(err);
    }
    rs.once("error", done);
    ws.once("error", done);
    ws.once("close", () => done(null));
    rs.pipe(ws);
  });
}

// Stream a file out of the drive to disk. Replaces the
// `drive.get(key) → fs.writeFile(path, buf)` pair on the receiver side.
// On any pipe error the partial output file is unlinked so the user
// doesn't end up with a half-written file in their downloads.
//
// A stall watchdog guards this. If the peer drops
// mid-file, hyperdrive's read stream waits forever for blocks that
// never arrive and this promise would hang the whole engineDownload
// loop. Arm a STALL_TIMEOUT_MS setTimeout on the read stream; re-arm
// on each 'data' chunk; if the timer fires, destroy both ends and
// reject with a file-stall cause so the outer catch can unlink the
// partial file and move on to the next entry. Matched to desktop
// v0.24.0's downloader.js:155-184.
// FileStallError is an EngineError subclass. The name
// stays for stack-trace clarity and test-tripwire stability; category /
// cause / toJSON come from the base class.
class FileStallError extends EngineError {
  constructor(destPath) {
    super({
      category: "receive.stall",
      cause: "file-stall",
      message: `stalled: no data for ${STALL_TIMEOUT_MS / 1000}s (peer may have disconnected)`,
      detail: { destPath },
    });
    this.name = "FileStallError";
  }
}

function pipeDriveToFile(drive, driveKey, destPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stallTimer = null;
    const clearStall = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearStall();
      if (err) {
        // Best-effort destroy so a stalled read stream doesn't keep
        // eating memory after we've moved on to the next file.
        try { rs?.destroy(); } catch {}
        try { ws?.destroy(); } catch {}
        reject(err);
      } else {
        resolve();
      }
    };
    const armStall = () => {
      clearStall();
      stallTimer = setTimeout(
        () => done(new FileStallError(destPath)),
        STALL_TIMEOUT_MS,
      );
    };
    let rs;
    let ws;
    try {
      rs = drive.createReadStream(driveKey);
      ws = createWriteStream(destPath);
    } catch (err) {
      return done(err);
    }
    rs.once("error", done);
    ws.once("error", done);
    ws.once("close", () => done(null));
    // Passive listener alongside pipe: does not consume chunks, just
    // re-arms the watchdog whenever any data flows. `pipe` already puts
    // rs into flowing mode; adding an 'on' listener is safe here.
    rs.on("data", armStall);
    rs.pipe(ws);
    // Arm immediately in case no data ever arrives (peer already gone
    // before the first block).
    armStall();
  });
}

// D2.3: sender controls the share name. Strip anything that could traverse
// out of the destination directory or break the host filesystem before
// using it as a folder name.
function sanitizeFolderName(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\\/g, "/")
    .replace(/\.\./g, "")
    .replace(/[/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function normalizeKey(k) {
  return String(k || "").replace(/^\//, "");
}

export async function engineDownload(driveId, destDir, fileName, fileNames) {
  binfo(
    "engine.download",
    `download requested drive=${driveId} destDir=${destDir || "(default)"} ` +
      `fileName=${fileName || "-"} fileNames=${Array.isArray(fileNames) ? fileNames.length : 0}`,
  );
  const session = activeDrives.get(driveId);
  if (!session || !session.drive) {
    bwarn(
      "engine.download",
      `no session drive=${driveId} activeDrives=[${Array.from(activeDrives.keys()).join(",")}]`,
    );
    return failure(
      "receive.no-session",
      "session-not-found",
      "Session not found — open the link first.",
    );
  }

  const { drive } = session;
  const outDir = destDir || downloadsDir;
  await fs.mkdir(outDir, { recursive: true });

  const downloadedFiles = [];
  const failedFiles = [];
  const start = Date.now();
  let bytesDownloaded = 0;

  const filesToDownload = [];
  for await (const entry of drive.list("/")) {
    if (entry.key === MANIFEST_DOWNLOAD_SKIP) continue;
    filesToDownload.push({ key: entry.key });
  }

  // D2.3 + D2.4 + D2.5: match desktop's folder-share UX. When the share
  // represents a folder (multi-file, or a single-entry share with a
  // folder-style name), wrap downloads under <outDir>/<shareName>/ and
  // disambiguate against existing folders. Cached on the session so a
  // subsequent per-file selection from the same opened drive reuses the
  // same root (avoids "MyProject (1)/x.txt" sitting next to the original).
  const shareName = sanitizeFolderName(session.shareName);
  const isFolderShare =
    (filesToDownload.length > 1 || (shareName && !shareName.includes("."))) && !!shareName;
  let downloadRoot = session._downloadRoot;
  if (!downloadRoot) {
    downloadRoot = isFolderShare
      ? await uniqueFolderPath(path.join(outDir, shareName))
      : outDir;
    session._downloadRoot = downloadRoot;
  }
  if (downloadRoot !== outDir) {
    await fs.mkdir(downloadRoot, { recursive: true });
  }

  // Per-file selection takes precedence over the older single-file `fileName`
  // parameter so both callers (RN + test bed) keep working without churn.
  const wantedSet = Array.isArray(fileNames) && fileNames.length
    ? new Set(fileNames.map(normalizeKey))
    : null;

  const selected = wantedSet
    ? filesToDownload.filter((f) => wantedSet.has(normalizeKey(f.key)))
    : !fileName
      ? filesToDownload
      : filesToDownload.filter((f) => normalizeKey(f.key) === normalizeKey(fileName));

  if (!selected.length) {
    bwarn(
      "engine.download",
      `nothing selected drive=${driveId} driveEntries=${filesToDownload.length} ` +
        `wanted=${wantedSet ? Array.from(wantedSet).join(",") : "(all)"}`,
    );
    return failure("receive.empty-drive", "no-files-selected", "No files in drive.");
  }

  binfo(
    "engine.download",
    `download start drive=${driveId} selected=${selected.length}/${filesToDownload.length} ` +
      `root=${downloadRoot} folderShare=${isFolderShare}`,
  );

  // NOTE: no synthetic "peer-connected { peerId: 'self' }" here anymore.
  // The RN side now classifies transfers by drive origin (hosted vs
  // received), so emitting a fake self-peer only confused the UI.

  // Compute the selected-file total so the live download
  // tracker (bindHyperdriveDownloadTracking) emits percent against the
  // *current download call's* expected bytes, not the whole-drive total.
  // Otherwise downloading 1 file out of 3 would cap the percent at ~33%
  // even when the user is "done" from their POV. The session.files list
  // is set by engineOpenDrive from the manifest; fall back to
  // session.totalBytes if file metadata is missing.
  let selectedExpected = 0;
  if (Array.isArray(session.files) && session.files.length) {
    const sizeByKey = new Map();
    for (const f of session.files) {
      sizeByKey.set(normalizeKey(f.name || ""), Number(f.size || 0));
    }
    for (const f of selected) {
      selectedExpected += sizeByKey.get(normalizeKey(f.key)) || 0;
    }
  }
  if (selectedExpected <= 0 && typeof session.totalBytes === "number") {
    selectedExpected = session.totalBytes;
  }
  session._dlExpected = selectedExpected;
  session._dlBytes = 0;

  // Prefer session.totalBytes (from the manifest) for the denominator so
  // the percent tracks bytes actually pulled over the wire instead of the
  // coarser "files completed" ratio. Fall back to a file-count ratio for
  // drives that somehow reached this point without a known total.
  const knownTotal = selectedExpected > 0
    ? selectedExpected
    : (typeof session.totalBytes === "number" && session.totalBytes > 0
        ? session.totalBytes
        : 0);

  let completed = 0;
  for (const file of selected) {
    let filePath = null;
    try {
      // Peer-provided keys are untrusted. safePathWithin
      // rejects `..` traversal, absolute paths, drive-letter escapes, and
      // NUL-byte tricks. On rejection the file is skipped and pushed to
      // failedFiles with a peer-path-traversal cause; the download loop
      // continues with the next entry so a single hostile key doesn't
      // sink the whole download.
      const relativePath = file.key.replace(/^\//, "");
      filePath = safePathWithin(downloadRoot, relativePath);
      const parentDir = path.dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });
      const requestedPath = filePath;
      filePath = await uniquePath(filePath);
      if (filePath !== requestedPath) {
        // Name collision — the user gets "photo (1).jpg" and is often
        // surprised by it. Record the rename so "where did my file go" is
        // answerable.
        binfo(
          "engine.download",
          `name collision drive=${driveId} wanted=${requestedPath} using=${filePath}`,
        );
      }
      const fileStart = Date.now();

      // Stream from the drive into the file. Replaces the
      // `drive.get(key) → fs.writeFile(path, buf)` pair, which OOM'd on
      // media. The pipe completes successfully even for 0-byte entries
      // (hyperdrive's createReadStream pushes null with no data).
      await pipeDriveToFile(drive, file.key, filePath);

      // Authoritative size from disk; we don't trust byte counters that
      // flow through the stream because hyperdrive's block accounting
      // can drift from raw file bytes (the same drift that makes the
      // sender-side 95% completion threshold necessary).
      let fileSize = 0;
      try {
        const stats = await fs.stat(filePath);
        fileSize = stats.size;
      } catch (e) {
        // If stat fails right after a successful pipe, treat the file as
        // 0-byte. Better than failing the whole download.
        swallowed("engine.download", `stat after pipe ${filePath}`, e);
      }
      bdebug(
        "engine.download",
        `file ok drive=${driveId} key=${file.key} size=${fileSize} in ${Date.now() - fileStart}ms`,
      );
      bytesDownloaded += fileSize;
      downloadedFiles.push({
        name: path.basename(filePath),
        path: filePath,
        size: fileSize,
      });
    } catch (fileError) {
      // With streams a torn write can leave a partial file
      // on disk. Unlink best-effort so the user doesn't end up with a
      // half-written file in their downloads.
      if (filePath) {
        try {
          await fs.unlink(filePath);
        } catch (e) {
          swallowed("engine.download", `unlink partial ${filePath}`, e);
        }
      }
      // Carry a typed cause when we have one so RN
      // can distinguish a peer-hostile path from a local disk failure.
      // Emit `peer-rejected` for path-traversal so the UI can surface it
      // separately from ordinary transfer errors. Non-typed failures
      // fall through with the raw message as today.
      const cause = fileError instanceof PathTraversalError
        ? fileError.cause
        : (fileError?.cause || undefined);
      if (cause === "peer-path-traversal") {
        // Security-relevant: a peer handed us a key that tried to escape
        // the download root. Loud, and now actually delivered to RN (the
        // event was previously emitted into the void — absent from the
        // BackendEvent union and handled nowhere).
        berror(
          "engine.security",
          `peer-rejected drive=${driveId} cause=${cause} key=${JSON.stringify(file.key)} ` +
            `root=${downloadRoot} — path traversal attempt, file skipped`,
        );
        emitEvent({
          type: "peer-rejected",
          driveId,
          cause,
          key: file.key,
        });
      } else {
        bwarn(
          "engine.download",
          `file failed drive=${driveId} key=${JSON.stringify(file.key)} cause=${cause || "unknown"} — ${describeError(fileError)}`,
        );
      }
      failedFiles.push({
        key: file.key,
        error: String(fileError?.message || fileError),
        cause,
      });
    }
    completed++;
    // Reconcile the streaming tracker's running total to the
    // authoritative per-file byteLength so any drift (block-overhead in
    // download events vs raw file bytes) doesn't accumulate.
    session._dlBytes = bytesDownloaded;
    const pct = knownTotal > 0
      ? Math.min(100, Math.round((bytesDownloaded / knownTotal) * 100))
      : Math.round((completed / selected.length) * 100);
    emitEvent({
      type: "upload-progress",
      driveId,
      percent: pct,
      bytesTransferred: bytesDownloaded,
      totalBytes: knownTotal || bytesDownloaded,
    });
  }

  // Clear the per-download denominator so a subsequent download (or
  // background download events from continued seeding) doesn't keep
  // computing percent against this call's expected bytes.
  session._dlExpected = 0;

  // Settle the manifest entry into INACTIVE so the drive
  // persists across restarts. The local file paths are saved on the entry
  // so the kebab can offer "Open in another app" later. Tear down the swarm
  // since the user's primary intent (grab the files) is satisfied; they can
  // explicitly re-activate via Share-it to seed again.
  binfo(
    "engine.download",
    `download loop done drive=${driveId} ok=${downloadedFiles.length} failed=${failedFiles.length} ` +
      `bytes=${bytesDownloaded}`,
  );

  const meta = manifest.drives[driveId];
  if (meta) {
    const existingLocal = Array.isArray(meta.localFiles) ? meta.localFiles : [];
    const mergedLocal = [...existingLocal];
    for (const df of downloadedFiles) {
      const idx = mergedLocal.findIndex(
        (x) => x && x.name === df.name && x.path === df.path
      );
      if (idx >= 0) mergedLocal[idx] = df;
      else mergedLocal.push(df);
    }
    meta.localFiles = mergedLocal;
    setDriveState(meta, DriveState.INACTIVE, "engineDownload: download finished");
    meta.lastActivityAt = Date.now();
    try { await saveManifest(); } catch {}
  }

  // Detach swarm so the receiver stops seeding the moment its primary task
  // (grab files) completes. User can re-activate explicitly.
  if (session.swarm) {
    bdebug("engine.download", `tearing down receiver swarm drive=${driveId}`);
    try {
      await session.swarm.destroy();
    } catch (e) {
      swallowed("engine.download", `swarm.destroy ${driveId}`, e);
    }
    session.swarm = null;
  }
  if (typeof session._unhookDownload === "function") {
    try {
      session._unhookDownload();
    } catch (e) {
      swallowed("engine.download", `unhook download tracking ${driveId}`, e);
    }
    session._unhookDownload = undefined;
  }
  activeDrives.delete(driveId);
  emitEvent({ type: "drive-deactivated", driveId });

  const duration = Date.now() - start;
  binfo(
    "engine.download",
    `download complete drive=${driveId} files=${downloadedFiles.length} failed=${failedFiles.length} ` +
      `bytes=${bytesDownloaded} duration=${duration}ms dest=${downloadRoot}`,
  );
  emitEvent({
    type: "upload-complete",
    driveId,
    totalBytes: bytesDownloaded,
    duration,
  });

  return {
    ok: true,
    files: downloadedFiles,
    failed: failedFiles,
    totalBytes: bytesDownloaded,
    duration,
    destDir: downloadRoot,
  };
}

export function engineStatus() {
  return {
    stub: false,
    started: initialized,
    activeCount: activeDrives.size,
    pendingOpen: pendingConnections.size,
    // Liveness counter and its cadence. Carried on the existing status reply
    // rather than a new opcode or a per-tick event, so observing it costs
    // nothing beyond the status call RN already makes.
    aliveTicks,
    aliveTickMs: ALIVE_TICK_MS,
  };
}

export function engineListDrives() {
  // Every drive in the manifest is reported (active + inactive),
  // not just the in-process active sessions. RN's unified list reads from
  // this; per-drive state determines visual treatment.
  const drives = [];
  for (const entry of Object.values(manifest.drives || {})) {
    if (!entry || !entry.driveId) continue;
    const s = normalizeState(entry.state);
    if (s !== DriveState.ACTIVE && s !== DriveState.INACTIVE) continue;
    drives.push({
      id: entry.driveId,
      key: entry.key,
      shareLink:
        entry.shareLink ||
        (entry.key ? createShareLink(entry.key) : ""),
      name: entry.name || entry.driveId,
      state: s,
      origin: entry.origin || "hosted",
      isUpload: (entry.origin || "hosted") === "hosted",
      totalBytes: entry.totalBytes ?? 0,
      files: entry.files || [],
      localFiles: entry.localFiles || [],
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt || entry.createdAt,
    });
  }
  return drives;
}

// Take an inactive (or never-attached) manifest entry and bring
// its drive online — reopen corestore, recreate Hyperdrive against the
// recorded key, attach a swarm. Hosted and received drives are symmetric
// from this entry-point: both end up as a host on the swarm announcing
// against their discoveryKey. Returns the same shape as engineShareFromPaths
// so the UI can transition straight into the active modal.
export async function engineActivateDrive(driveId) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  if (!driveId) {
    return failure("drive.invalid-arg", "drive-id-required", "driveId required");
  }

  if (activeDrives.has(driveId)) {
    const session = activeDrives.get(driveId);
    return {
      ok: true,
      driveId,
      shareLink:
        session?.shareLink ||
        (session?.metadata?.key ? createShareLink(session.metadata.key) : ""),
      already: true,
    };
  }

  const entry = manifest.drives?.[driveId];
  if (!entry) {
    return failure("drive.not-found", "drive-not-found", "Drive not found");
  }
  if (!entry.key || !/^[a-fA-F0-9]{64}$/.test(String(entry.key))) {
    return failure(
      "drive.invalid-state",
      "drive-key-invalid",
      "Drive key missing or invalid",
    );
  }
  if (!entry.storagePath) {
    return failure(
      "drive.invalid-state",
      "drive-storagepath-missing",
      "Storage path missing",
    );
  }

  try {
    await fs.access(entry.storagePath);
  } catch {
    return failure(
      "drive.invalid-state",
      "storage-gone",
      "Local storage is gone — can't activate",
    );
  }

  try {
    const store = new Corestore(entry.storagePath);
    await store.ready();
    const drive = new Hyperdrive(store, b4a.from(entry.key, "hex"));
    await drive.ready();

    const totalBytes = Number(entry.totalBytes || 0);
    const session = {
      driveId,
      drive,
      store,
      swarm: null,
      metadata: entry,
      totalBytes,
      isReceiving: (entry.origin || "hosted") === "received",
      shareLink: createShareLink(entry.key),
      files: entry.files || [],
      shareName: entry.name,
    };
    const swarm = attachHostSwarm(session);
    session.swarm = swarm;

    activeDrives.set(driveId, session);

    setDriveState(entry, DriveState.ACTIVE, "engineActivateDrive: swarm attached");
    entry.lastActivityAt = Date.now();
    try { await saveManifest(); } catch {}

    emitEvent({
      type: "drive-activated",
      driveId,
      shareLink: session.shareLink,
      key: entry.key,
    });

    return { ok: true, driveId, shareLink: session.shareLink, key: entry.key };
  } catch (err) {
    return {
      ok: false,
      error: wrapError(err, {
        category: "drive.activate-fail",
        cause: "activate-fail",
      }),
    };
  }
}

// Tear down the swarm + drive session but keep storage and the
// manifest entry intact. Distinct from engineStopDrive({purge:true}) which
// is the destructive Delete path.
export async function engineDeactivateDrive(driveId) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  if (!driveId) {
    return failure("drive.invalid-arg", "drive-id-required", "driveId required");
  }

  const session = activeDrives.get(driveId);
  if (!session) {
    // Already inactive — make the transition idempotent.
    bdebug("engine.state", `deactivate drive=${driveId} (already inactive, idempotent)`);
    const entry = manifest.drives?.[driveId];
    if (entry) {
      setDriveState(entry, DriveState.INACTIVE, "engineDeactivateDrive: idempotent path");
      entry.lastActivityAt = Date.now();
      try { await saveManifest(); } catch {}
    }
    emitEvent({ type: "drive-deactivated", driveId });
    return { ok: true, alreadyInactive: true };
  }

  binfo("engine.state", `deactivate drive=${driveId}: tearing down session (storage preserved)`);
  if (typeof session._unhookDownload === "function") {
    try {
      session._unhookDownload();
    } catch (e) {
      swallowed("engine.state", `unhook download ${driveId}`, e);
    }
  }
  if (typeof session._unhookUpload === "function") {
    try {
      session._unhookUpload();
    } catch (e) {
      swallowed("engine.state", `unhook upload ${driveId}`, e);
    }
  }
  if (session.swarm) {
    try {
      await session.swarm.destroy();
    } catch (e) {
      swallowed("engine.state", `swarm.destroy ${driveId}`, e);
    }
  }
  if (session.drive) {
    try {
      await session.drive.close();
    } catch (e) {
      swallowed("engine.state", `drive.close ${driveId}`, e);
    }
  }
  if (session.store) {
    try {
      await session.store.close();
    } catch (e) {
      swallowed("engine.state", `store.close ${driveId}`, e);
    }
  }
  activeDrives.delete(driveId);
  stopUploadTracker(driveId);

  const entry = manifest.drives?.[driveId];
  if (entry) {
    setDriveState(entry, DriveState.INACTIVE, "engineDeactivateDrive: session torn down");
    entry.lastActivityAt = Date.now();
    try { await saveManifest(); } catch {}
  }

  emitEvent({ type: "drive-deactivated", driveId });
  return { ok: true };
}

export function enginePauseDrive(driveId) {
  return engineDeactivateDrive(driveId);
}

export function engineResumeDrive(driveId) {
  return engineActivateDrive(driveId);
}

export function engineRemoveDrive(driveId, _opts) {
  return engineStopDrive(driveId, { purge: true });
}

export function engineCheckFiles(_driveId) {
  return { ok: true, files: [] };
}

export function engineFakeUploadTest(opts = {}) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }

  const durationMs = Math.max(4000, Number(opts.durationMs || 18000));
  const tickMs = Math.max(250, Number(opts.tickMs || 700));
  const peers = Math.max(1, Math.min(6, Number(opts.peers || 2)));
  const fileBytes = Math.max(1024 * 1024, Number(opts.totalBytes || 24 * 1024 * 1024));
  // `__driveId` is set only by this function's own deferred
  // re-entry below, never over the wire. Reusing the id means the value
  // handed back to RN at schedule time is the one the eventual
  // `upload-complete` carries — which is what puts it in `hostedIdsRef`
  // and decides the notification wording.
  const driveId = opts.__driveId ? String(opts.__driveId) : generateDriveId("fake");

  // Delayed start, so a tester can background the app before the
  // completion lands. The timer is deliberately worklet-side: RN's
  // `setInterval` was measured frozen for 558-669 s while backgrounded, so an
  // RN-side delay would not fire until the app returned to the foreground
  // and would test nothing. The worklet's own timers kept perfect 2 s
  // cadence across the same windows.
  //
  // Scheduling returns immediately, carrying the driveId, and re-enters
  // with the delay cleared. No new opcode, no second code path: the real
  // simulation, and therefore the real `upload-complete`, is unchanged.
  const startDelayMs = Math.max(0, Number(opts.startDelayMs || 0));
  if (startDelayMs > 0) {
    binfo(
      "engine.simulate",
      `scheduled upload-complete drive=${driveId} in ${startDelayMs}ms ` +
        `(sim duration=${durationMs}ms peers=${peers} bytes=${fileBytes})`,
    );
    const kickoff = setTimeout(() => {
      binfo("engine.simulate", `delay elapsed drive=${driveId} — starting simulation now`);
      engineFakeUploadTest({ ...opts, startDelayMs: 0, __driveId: driveId });
    }, startDelayMs);
    // Registered so an in-flight schedule is still cancellable; the
    // re-entry overwrites this entry with the live session.
    fakeSessions.set(driveId, {
      driveId,
      intervalId: null,
      timers: [kickoff],
      state: { completed: false },
    });
    return { ok: true, driveId, durationMs, tickMs, peers, totalBytes: fileBytes, startDelayMs };
  }

  const forceSelfPeer = !!opts.forceSelfPeer;
  const peerPrefix = String(opts.peerPrefix || "test-peer")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();

  const peerIds = forceSelfPeer
    ? ["self"]
    : Array.from({ length: peers }, (_, i) => `${peerPrefix}-${i + 1}`);
  const connectedPeers = new Set();
  const peerProgress = new Map();
  const timers = [];
  const peerWeights = new Map(
    peerIds.map((peerId, i) => [peerId, 0.75 + ((i * 37) % 50) / 100]) // deterministic-ish 0.75..1.24
  );
  const baselineBytesPerMs = fileBytes / durationMs;
  const startAt = Date.now();
  let totalSentBytes = 0;
  const fakeState = { completed: false };
  let maxConcurrentPeers = 0;
  const flapPeer = !!opts.flapPeer;
  const outOfOrderStart = !!opts.outOfOrderStart;
  const malformedEvent = !!opts.malformedEvent;
  const stallAtMs = Math.max(0, Number(opts.stallAtMs || 0));
  const stallDurationMs = Math.max(0, Number(opts.stallDurationMs || 0));
  // `??`, never `||`. This is the one option here whose clamp is
  // `Math.max(0, …)`, so zero is in range and means "no peer disconnects
  // early"; `|| 1` discards it and shifts completion onto another path.
  // Every other `|| <number>` in this file is clamped above zero by its own
  // Math.max, so zero cannot take effect there.
  const earlyCompletePeers = Math.max(0, Number(opts.earlyCompletePeers ?? 1));

  const emitProgressSnapshot = () => {
    const activePeerIds = Array.from(connectedPeers);
    const activeCount = activePeerIds.length;
    const activeTransferred = activePeerIds.reduce(
      (sum, peerId) => sum + (peerProgress.get(peerId) || 0),
      0
    );
    const activeTotal = activeCount * fileBytes;
    const percent = activeTotal > 0 ? Math.round((activeTransferred / activeTotal) * 100) : 100;
    const progressPeerId = activePeerIds[0] || peerIds[0] || "test-peer-1";

    emitEvent({
      type: "upload-progress",
      driveId,
      peerId: progressPeerId,
      percent: Math.max(0, Math.min(100, percent)),
      bytesTransferred: Math.round(activeTransferred),
      totalBytes: activeTotal,
      driveSize: fileBytes,
      totalSentBytes: Math.round(totalSentBytes),
    });
  };

  const connectPeer = (peerId) => {
    if (fakeState.completed || connectedPeers.has(peerId)) return;
    connectedPeers.add(peerId);
    peerProgress.set(peerId, 0);
    if (connectedPeers.size > maxConcurrentPeers) maxConcurrentPeers = connectedPeers.size;
    emitEvent({ type: "peer-connected", driveId, peerId, totalBytes: connectedPeers.size * fileBytes });
    emitProgressSnapshot();
  };
  const disconnectPeer = (peerId) => {
    if (fakeState.completed || !connectedPeers.has(peerId)) return;
    connectedPeers.delete(peerId);
    peerProgress.delete(peerId);
    emitEvent({ type: "peer-disconnected", driveId, peerId });
    emitProgressSnapshot();
  };

  // Start with one downloader, then simulate others joining later.
  if (outOfOrderStart) {
    emitEvent({
      type: "upload-progress",
      driveId,
      peerId: peerIds[0] || "test-peer-1",
      percent: 1,
      bytesTransferred: 0,
      totalBytes: fileBytes,
      driveSize: fileBytes,
      totalSentBytes: 0,
    });
  }
  if (peerIds[0]) connectPeer(peerIds[0]);
  if (!forceSelfPeer && peerIds[1])
    timers.push(setTimeout(() => connectPeer(peerIds[1]), Math.round(durationMs * 0.25)));
  if (!forceSelfPeer && peerIds[2])
    timers.push(setTimeout(() => connectPeer(peerIds[2]), Math.round(durationMs * 0.5)));
  for (let i = 3; i < peerIds.length; i++) {
    const joinAt = Math.min(0.9, 0.55 + (i - 2) * 0.08);
    timers.push(setTimeout(() => connectPeer(peerIds[i]), Math.round(durationMs * joinAt)));
  }

  // Some peers can finish early and leave before overall completion.
  for (let i = 0; i < Math.min(earlyCompletePeers, peerIds.length); i++) {
    timers.push(setTimeout(() => disconnectPeer(peerIds[i]), Math.round(durationMs * (0.65 + i * 0.05))));
  }

  // Optional temporary global stall (all peers leave, then some rejoin).
  if (stallAtMs > 0 && stallDurationMs > 0) {
    timers.push(
      setTimeout(() => {
        const currentlyConnected = Array.from(connectedPeers);
        for (const peerId of currentlyConnected) disconnectPeer(peerId);
        timers.push(
          setTimeout(() => {
            if (peerIds[0]) connectPeer(peerIds[0]);
            if (peerIds[1]) connectPeer(peerIds[1]);
          }, stallDurationMs)
        );
      }, stallAtMs)
    );
  }

  // Optional flappy peer toggling.
  if (flapPeer && peerIds[1]) {
    let up = true;
    const flapTimer = setInterval(() => {
      if (fakeState.completed) return;
      if (up) disconnectPeer(peerIds[1]);
      else connectPeer(peerIds[1]);
      up = !up;
    }, Math.max(1800, Math.round(tickMs * 3)));
    timers.push(flapTimer);
  }

  if (malformedEvent) {
    timers.push(
      setTimeout(() => {
        emitEvent({ type: "upload-progress", driveId, percent: 42 });
      }, Math.max(1000, Math.round(durationMs * 0.2)))
    );
  }

  const intervalId = setInterval(() => {
    if (fakeState.completed) return;

    const activePeerIds = Array.from(connectedPeers);
    const activeWeight = activePeerIds.reduce((sum, peerId) => sum + (peerWeights.get(peerId) || 1), 0);

    // If no peers are connected, upload stalls instead of progressing.
    if (activeWeight <= 0) {
      if (maxConcurrentPeers >= peers) {
        fakeState.completed = true;
        clearInterval(intervalId);
        for (const timer of timers) clearInterval(timer);
        fakeSessions.delete(driveId);
        binfo(
          "engine.simulate",
          `emitting upload-complete drive=${driveId} bytes=${Math.round(totalSentBytes)} ` +
            `elapsed=${Date.now() - startAt}ms (path=no-peers)`,
        );
        emitEvent({
          type: "upload-complete",
          driveId,
          peerId: peerIds[0] || "test-peer-1",
          totalBytes: totalSentBytes,
          driveSize: fileBytes,
          totalSentBytes: Math.round(totalSentBytes),
          duration: Date.now() - startAt,
        });
      }
      return;
    }

    for (const peerId of activePeerIds) {
      const peerRate = baselineBytesPerMs * (peerWeights.get(peerId) || 1);
      const current = peerProgress.get(peerId) || 0;
      const next = Math.min(fileBytes, current + peerRate * tickMs);
      const delta = next - current;
      peerProgress.set(peerId, next);
      totalSentBytes += delta;
    }

    // Disconnect peers that reached 100% of the file.
    const finishedPeers = activePeerIds.filter((peerId) => (peerProgress.get(peerId) || 0) >= fileBytes);
    for (const peerId of finishedPeers) {
      disconnectPeer(peerId);
    }

    // Emit after updates/disconnects so denominator reflects active peers.
    emitProgressSnapshot();

    const everyoneJoined = maxConcurrentPeers >= peers;
    const nobodyActive = connectedPeers.size === 0;
    if (everyoneJoined && nobodyActive) {
      fakeState.completed = true;
      clearInterval(intervalId);
      for (const timer of timers) clearInterval(timer);
      fakeSessions.delete(driveId);
      binfo(
        "engine.simulate",
        `emitting upload-complete drive=${driveId} bytes=${Math.round(totalSentBytes)} ` +
          `elapsed=${Date.now() - startAt}ms (path=all-peers-done)`,
      );
      emitEvent({
        type: "upload-complete",
        driveId,
        peerId: peerIds[0] || "test-peer-1",
        totalBytes: Math.round(totalSentBytes),
        driveSize: fileBytes,
        totalSentBytes: Math.round(totalSentBytes),
        duration: Date.now() - startAt,
      });
    }
  }, tickMs);
  timers.push(intervalId);
  fakeSessions.set(driveId, { driveId, intervalId, timers, state: fakeState });

  return { ok: true, driveId, durationMs, tickMs, peers, totalBytes: fileBytes };
}
