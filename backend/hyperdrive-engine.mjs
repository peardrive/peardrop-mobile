import fs from "bare-fs/promises";
import { createReadStream, createWriteStream } from "bare-fs";
import path from "bare-path";

import b4a from "b4a";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";

import {
  loadManifest as readManifestFromDisk,
  isManifestUnavailable,
} from "./manifest-recovery.mjs";
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

// The engine's own ceiling on a resolve; it must sit below RN's 30 s, and nothing
// couples them. Releasing `drive.findingPeers()` when `swarm.flush()` returns is the trap.
const RESOLVE_WAIT_MS = 25000;

// How often the receiver re-queries the DHT inside that budget while no peer
// has answered: the initial `swarm.flush()` lookup happens only once.
const RESOLVE_REQUERY_MS = 3000;

// How often the manifest blob is re-probed inside that budget. `drive.update`
// resolving means head metadata arrived, never that a blob replicated, so the
// manifest can still be a moment behind the head that announced it.
const MANIFEST_POLL_MS = 500;

// Per-file stall watchdog on receive. If a peer drops mid-file, hyperdrive's
// read stream waits forever for blocks that never arrive; failing the file
// after 60 s of no data lets the download loop move on to the next file
// instead of hanging the whole session.
const STALL_TIMEOUT_MS = 60000;

// Receive files are piped to `<dest><PARTIAL_SUFFIX>` and renamed onto
// `<dest>` only after the stream closes cleanly. This stops the unlink on
// failure from being load-bearing, keeps `uniquePath` from probing a
// surviving partial at the final path and manufacturing a second
// "photo (1).jpg" copy on the retry, and leaves anything from a killed
// process identifiable as incomplete by inspection.
//
// Deliberately not a resume marker. Hyperdrive re-reads from block zero on
// every attempt and the engine has no block-range bookkeeping; treating a
// `.peardrop-part` file as resumable would be a lie. It is a tombstone.
const PARTIAL_SUFFIX = ".peardrop-part";

const DriveState = {
  CREATING: "creating",
  ACTIVE: "active",
  SEEDING: "seeding",
  // In-flight receiver-open. Persisted so the corestore folder is cleaned
  // up on next boot if the open didn't complete.
  SEEKING: "seeking",
  // Data preserved locally, not announcing on the swarm. Both hosted and
  // received drives can land here. Activate transitions them back to ACTIVE;
  // Delete (engineStopDrive with purge) is the only destructive path.
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
 * Every drive-state transition goes through here, so the sequence a drive
 * took across a session is recoverable from the log. `why` carries the
 * trigger, because the transition alone rarely explains itself.
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

// Transient hydrate failures are tracked in memory and never persisted to the
// manifest. Writing `state: "failed"` to disk for a drive whose corestore
// folder was briefly unreadable at boot — a permission blip, a race with an
// OS scan — permanently demotes that drive on every subsequent boot. Keep the
// failure off disk, retry next boot, and expose the map to the RN side.
// Cleared per-drive on successful hydrate.
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

// True when the manifest file exists but could not be read, so `manifest` above is
// an empty placeholder: saves, share creation and receive all refuse while it holds.
let manifestUnavailable = false;

// The user-facing sentence, in one place. Deliberately not a raw engine or
// native error string, and deliberately silent about networks and expiry.
const MANIFEST_UNAVAILABLE_MESSAGE =
  "Couldn't load your shares — close and reopen PearDrop.";

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
  // The load path is non-destructive: the reader parses the manifest and
  // returns it, or an empty manifest plus a .corrupted backup. It does not
  // read the drives folder and does not prune entries. Per-drive missing
  // storage is handled at hydrate time; wide "manifest vs folders" sync is
  // deliberately absent.
  try {
    manifest = await readManifestFromDisk(manifestPath);
    // Read the unavailable flag from the loader, the only thing that knows
    // whether the file was readable. A load that succeeds clears it, so this
    // is an assignment, not an |=.
    manifestUnavailable = isManifestUnavailable(manifestPath);
    if (manifestUnavailable) {
      berror(
        "engine.boot",
        "manifest UNAVAILABLE: the file exists but could not be read after " +
          "retries. Running on an empty placeholder; all manifest writes are " +
          "refused and share create/receive is blocked until it clears.",
      );
    } else {
      binfo(
        "engine.boot",
        `manifest loaded: ${Object.keys(manifest.drives || {}).length} drive entries`,
      );
    }
  } catch (err) {
    console.error("[engine] manifest load", err);
    berror("engine.boot", `manifest load failed — ${describeError(err)}`);
  }
  // In-flight cleanup: any entry stuck in CREATING or SEEKING from a crash
  // mid-operation gets dropped, and its storage folder removed if present. It
  // is an engine concern because it touches drive-level state (storagePath)
  // and saves the trimmed manifest through the engine's own save chain.
  try {
    await cleanupInFlightManifestEntries();
  } catch (err) {
    console.error("[engine] cleanup in-flight", err);
    berror("engine.boot", `cleanup in-flight failed — ${describeError(err)}`);
  }
}

// Drop any entry stuck in CREATING or SEEKING (a crash mid-share-create or
// mid-open) and rm its corestore folder when its location is known. Called
// once from loadManifest during engineInit; not exposed.
async function cleanupInFlightManifestEntries() {
  const stale = new Set([DriveState.CREATING, DriveState.SEEKING]);
  const toRemove = [];
  for (const [driveId, meta] of Object.entries(manifest.drives || {})) {
    if (stale.has(meta?.state)) toRemove.push([driveId, meta]);
  }
  if (toRemove.length === 0) return;
  // This path deletes user-visible drives and their corestore folders at
  // boot, so each removal is logged individually: a drive vanishing between
  // sessions must leave a trace.
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

// Saves are serialized through a chain so a burst of state transitions
// cannot interleave temp-file writes. Each save awaits the previous one's
// rename; the .catch(() => {}) isolates the next save from a failure in the
// previous one so the chain never becomes permanently rejected.
let _saveChain = Promise.resolve();

function saveManifest() {
  // The refusal. This is the engine's own route to atomicWriteJson on the
  // manifest path, reached from many call sites, one of which
  // (`cleanupInFlightManifestEntries`) fires during engineInit itself.
  //
  // Refuse rather than throw. Most callers are `try { await saveManifest() }
  // catch {}` but several are bare `await`s on the boot and share paths, and
  // throwing there would turn a survivable condition into a boot crash. The
  // user-visible consequence is carried by the explicit manifest-unavailable
  // state instead; refusing the write silently would only convert lost old
  // shares into lost new ones.
  if (manifestUnavailable) {
    bwarn(
      "engine.manifest",
      "save REFUSED — the manifest on disk could not be read, so the " +
        "in-memory copy is a placeholder and writing it would destroy the " +
        "user's shares",
    );
    return Promise.resolve();
  }
  const next = _saveChain
    .catch(() => {})
    .then(() => atomicWriteJson(manifestPath, manifest));
  // Almost every caller wraps this in `try { … } catch {}` — a correct
  // best-effort, and a blind spot at each of those sites. Reporting the
  // failure here covers all of them without changing anyone's control flow:
  // the returned promise is unchanged and this is a detached observer.
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
 * Cost is near-zero because this ships in release builds: one timer, one
 * integer increment every 30 s, no logging and no IPC per tick — the count
 * rides out on the existing status reply.
 */
const ALIVE_TICK_MS = 30000;
let aliveTicks = 0;
let aliveTimer = null;

/**
 * The worklet measures its own largest gap between ticks, because RN is the realm
 * that stops running in the window being measured and a gap measured by the frozen
 * party is not a measurement. Nothing here is gated on a debug flag. Eviction is
 * oldest-first, so an entry from before a window can never displace one inside it.
 */
const NOTABLE_TICK_GAP_MS = ALIVE_TICK_MS * 2;
const TICK_GAP_HISTORY_MAX = 32;
let lastAliveTickAt = 0;
let maxTickGapMs = 0;
const tickGaps = [];

/**
 * The idle-host grace window expires here, not in RN: RN JS timers do not run while
 * backgrounded, the one state the window is armed in. `host-idle-grace-elapsed` is a
 * wake, not a verdict — RN re-runs its own predicate on receipt. The duration is
 * supplied by RN and never duplicated here, and absent it the sweep stays off.
 */
let idleHostGraceMs = 0;

function configureIdleHostGrace(ms) {
  const next = Number(ms);
  // `> 0` rather than `!== undefined`: it covers NaN, null and a negative, and
  // it does so where the value enters rather than where it is compared.
  idleHostGraceMs = Number.isFinite(next) && next > 0 ? next : 0;
}

/**
 * One pass over the hosted drives, on the alive ticker's cadence.
 *
 * Emits at most once per idle period per drive: `idleGraceEmitted` is cleared by
 * a peer connecting and by the falling edge that stamps `lastPeerLeftAt`, so a
 * drive that sits idle forever costs exactly one event, not one per tick.
 */
function sweepIdleHostGrace(now) {
  if (!(idleHostGraceMs > 0)) return;
  for (const tracker of uploadTrackers.values()) {
    if (!tracker || tracker.idleGraceEmitted) continue;
    // A connected peer is the strongest evidence there is that this share is
    // still in use, and it is checked first here for the same reason
    // `classifyTransfer` checks it before `completed`.
    if (tracker.peers.size > 0) continue;
    // Null means no departure was ever observed — a share nobody has reached
    // yet. There is nothing to expire, and the predicate agrees: its hosted
    // branch returns null for a null stamp rather than "idle-host-grace".
    if (!tracker.lastPeerLeftAt) continue;
    const idleMs = now - tracker.lastPeerLeftAt;
    if (!(idleMs >= idleHostGraceMs)) continue;
    tracker.idleGraceEmitted = true;
    emitEvent({
      type: "host-idle-grace-elapsed",
      driveId: tracker.driveId,
      idleMs,
      at: now,
    });
    binfo(
      "engine.peer",
      `host idle grace elapsed drive=${tracker.driveId} idleMs=${idleMs} graceMs=${idleHostGraceMs}`,
    );
  }
}

function startAliveTicker() {
  if (aliveTimer) return;
  // Seeded here rather than on the first tick, so a freeze beginning just
  // after `engineInit` widens the first measured gap instead of vanishing.
  lastAliveTickAt = Date.now();
  aliveTimer = setInterval(() => {
    const now = Date.now();
    const gapMs = now - lastAliveTickAt;
    lastAliveTickAt = now;
    aliveTicks++;
    // Placed above the gap guard below on purpose: that guard is an early
    // `return` for a backwards clock step, and a clock that moved is a reason
    // to distrust a gap measurement, not a reason to stop asking whether a
    // share has been idle. The sweep fails closed on NaN by itself.
    sweepIdleHostGrace(now);
    // Covers a backwards clock step and NaN both, here rather than at the
    // point of interpretation: a threshold comparison used as a validity
    // check admits NaN.
    if (!(gapMs > 0)) return;
    if (gapMs > maxTickGapMs) maxTickGapMs = gapMs;
    if (gapMs >= NOTABLE_TICK_GAP_MS) {
      // `aliveTicks` is already incremented, so `tick` is the tick that closed
      // the gap. RN keeps entries with `tick > ticksAtBackground`.
      tickGaps.push({ tick: aliveTicks, gapMs });
      if (tickGaps.length > TICK_GAP_HISTORY_MAX) tickGaps.shift();
    }
  }, ALIVE_TICK_MS);
}

/**
 * `options.idleHostGraceMs` is RN's own `IDLE_HOST_GRACE_MS` plus its wake
 * pad, handed down so the worklet can expire the grace window in the realm
 * that keeps running. Optional, and its absence leaves the sweep off — see
 * `configureIdleHostGrace` for why there is no default here.
 */
export async function engineInit(documentRoot, options) {
  // First statement, and synchronous. It must not sit between `initialized =
  // true` and `startAliveTicker()` below: those two have to stay adjacent
  // with no await between them.
  configureIdleHostGrace(options?.idleHostGraceMs);
  const layout = peardropLayout(documentRoot);
  drivesDir = layout.drives;
  downloadsDir = layout.downloads;
  manifestPath = layout.manifestFile;
  await fs.mkdir(drivesDir, { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  await loadManifest();
  initialized = true;
  startAliveTicker();

  // Rehydration runs in the background and is deliberately not awaited:
  // engineInit must return promptly so the RN side can flip to "listening"
  // and accept user input. drive-hydrated events stream out as each drive
  // comes online.
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
    // The durable record of delivery. `peer.completed` is destroyed before the
    // snapshot, so only this separates "everyone finished" from "everyone left".
    deliveredPeers: new Set(),
    // Coalescing state for the upload-event-driven snapshot.
    lastUploadEmitAt: 0,
    pendingUploadEmit: null,
    // When the peer count last fell to zero, by this realm's clock, and
    // whether the grace wake for that idle period has gone out. Null rather
    // than 0: a tracker that has never had a peer has not had one leave, and
    // the sweep must not read "never" as "long ago".
    lastPeerLeftAt: null,
    idleGraceEmitted: false,
  };
  uploadTrackers.set(driveId, tracker);
  return tracker;
}

function emitUploadProgressSnapshot(tracker) {
  if (!tracker) return;
  const activePeers = Array.from(tracker.peers.values()).filter((peer) => !peer.completed);
  const activeTransferred = activePeers.reduce((sum, peer) => sum + peer.sentBytes, 0);
  const activeTotal = activePeers.length * tracker.driveSize;

  // The `: 100` below is the genuine completion percent on the happy path and must
  // not be deleted; `deliveredPeers` is what tells "everyone finished" from "left".
  const deliveredCount = tracker.deliveredPeers ? tracker.deliveredPeers.size : 0;
  if (activeTotal === 0 && deliveredCount === 0) {
    bdebug(
      "engine.upload",
      `snapshot suppressed drive=${tracker.driveId} — active set empty and no peer has ever ` +
        `finished (peers=${tracker.peers.size} delivered=0 totalSentBytes=${Math.round(tracker.totalSentBytes)}). ` +
        `Emitting percent=100 here is D-09.`,
    );
    return;
  }
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

/**
 * The upload-event path, coalesced: `onUpload` fires per replicated block, so an
 * actively sending drive is the fastest writer into a fixed-size log ring. The 1 Hz
 * timer in `startUploadTrackerTimer` is not touched — suppressing it would freeze
 * `lastEventAt` on an idle-but-attached peer, which is indistinguishable from a stall.
 */
const UPLOAD_EMIT_INTERVAL_MS = 100;

function emitUploadProgressCoalesced(tracker) {
  if (!tracker) return;
  const now = Date.now();
  if (now - (tracker.lastUploadEmitAt || 0) >= UPLOAD_EMIT_INTERVAL_MS) {
    if (tracker.pendingUploadEmit) {
      clearTimeout(tracker.pendingUploadEmit);
      tracker.pendingUploadEmit = null;
    }
    tracker.lastUploadEmitAt = now;
    emitUploadProgressSnapshot(tracker);
    return;
  }
  if (!tracker.pendingUploadEmit) {
    tracker.pendingUploadEmit = setTimeout(() => {
      tracker.pendingUploadEmit = null;
      tracker.lastUploadEmitAt = Date.now();
      emitUploadProgressSnapshot(tracker);
    }, UPLOAD_EMIT_INTERVAL_MS);
  }
}

// Real Hyperdrive bytes-uploaded events, not a socket.bytesWritten sampler:
// Hyperswarm sockets are UDX streams that don't expose bytesWritten with
// Node-net semantics, so a sampler reports percent=0 forever. This hooks the
// blobs core's 'upload' event — the same signal Hyperdrive's own Monitor
// class uses — and attributes bytes to peers via remotePublicKey, which
// matches the 12-hex peerId derived from swarm peerInfo.publicKey.
//
// Per-peer attribution allows a single precise upload-complete the moment a
// specific receiver has replicated everything. The RN-side stall detector
// stays as a fallback safety net.
function bindHyperdriveUploadTracking(session) {
  const { drive, driveId, totalBytes } = session;
  if (!drive || !totalBytes) return () => {};

  const tracker = ensureUploadTracker(driveId, totalBytes);

  const onUpload = (_index, bytes, from) => {
    // Hypercore's Peer class sets both peer.remotePublicKey and
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
      // The durable half of the same fact. `peer.completed` dies with the
      // peer entry; this does not. Recorded next to the flag so they cannot
      // diverge.
      if (tracker.deliveredPeers) tracker.deliveredPeers.add(peerId);
      // The 95% threshold is a heuristic standing in for an exact byte
      // match, because Hyperdrive's block accounting doesn't sum to raw
      // totalBytes. A hosted transfer declaring itself complete on an
      // approximation is exactly the "said Sent but nothing arrived"
      // complaint, so record the numbers behind the decision.
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

    // Coalesced to 10 Hz: one emit per replicated block is also one exported
    // log line per replicated block.
    emitUploadProgressCoalesced(tracker);
  };

  // Hook both blobs (file content) and db (metadata) cores. Blobs is the big
  // one; db is small but completes first and confirms a peer is pulling.
  drive.ready().then(() => {
    try {
      drive.getBlobs().then((blobs) => {
        if (!blobs) {
          // The one condition under which the db-core listener registered
          // below is never unhooked: `session._unhookUpload` is assigned
          // inside this `then`, so a falsy `blobs` leaves the teardown with
          // nothing to call. Whether hyperdrive can resolve falsy here is
          // unknown, and this line is how a field export answers it.
          bwarn(
            "engine.upload",
            `getBlobs resolved falsy drive=${driveId} — upload listener on db core will NOT be unhooked`,
          );
          return;
        }
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

// Mirror of bindHyperdriveUploadTracking for the receive side. One progress
// event per file after `drive.get(key)` resolves shows 0% → 100% with nothing
// in between, because drive.get blocks until every block of that file has
// replicated. So hook the blob core's `download` event, accumulate bytes
// against session.totalBytes, and emit `upload-progress` with live totals.
// The per-file post-completion emit in engineDownload stays as a
// reconciliation snap so the percent lines up exactly at file boundaries even
// if Hyperdrive's block accounting drifts from raw file-byte totals.
function bindHyperdriveDownloadTracking(session) {
  const { drive, driveId } = session;
  if (!drive) return () => {};

  // Bytes accumulate on the session object so engineDownload can also write
  // to it, and so the tracker survives across multiple drive.get calls.
  session._dlBytes = 0;

  // Download events fire per-block, and one progress event per block would
  // flood the RN side, so coalesce to ~10 Hz.
  const MIN_EMIT_INTERVAL_MS = 100;
  let lastEmitAt = 0;
  let pendingEmit = null;

  // Denominator preference order: the current download call's selected-file
  // total, else the whole-drive total from the manifest, else null — no
  // percent, but bytesTransferred is still emitted.
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
        if (!blobs) {
          // Receive-side mirror of the upload branch above. Same shape, same
          // consequence: `_unhookDownload` is never assigned, so the db-core
          // listener and the 100 ms coalescing timeout are both left behind.
          bwarn(
            "engine.download",
            `getBlobs resolved falsy drive=${driveId} — download listener on db core will NOT be unhooked`,
          );
          return;
        }
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

// Coarse "still alive" tick: keeps tracker totals fresh when the upload-event
// burst is delivered between snapshots. It emits the current snapshot so the
// UI keeps seeing a fresh `lastEventAt` and progressEverReceived stays sticky.
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
  // The coalescing timeout would otherwise outlive the tracker and emit one
  // snapshot for a drive that is already gone.
  if (tracker.pendingUploadEmit) {
    clearTimeout(tracker.pendingUploadEmit);
    tracker.pendingUploadEmit = null;
  }
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

// The canonical file shape `{ key, displayName, size }`: `key` addresses the drive
// and keeps its leading `/`. Both producers must emit it or every lookup misses.
function toDriveFileRef(f) {
  if (!f || typeof f !== "object") return null;

  // Resolution order matters. `key` first, because this build writes it. Then
  // `storagePath`, which is only ever a key. `name` last, and only as a key
  // when `storagePath` is absent — on the persisted shape `name` is the
  // display name, and `storagePath` being present settles which of the two
  // spellings this is.
  const rawKey = f.key ?? f.storagePath ?? f.name ?? "";
  const stripped = normalizeKey(rawKey);
  if (!stripped) return null;
  const key = `/${stripped}`;

  // Display name, in order of trustworthiness: an explicit `displayName`; the
  // persisted shape's `name`, proven by `storagePath` sitting beside it;
  // otherwise the key's basename.
  const display =
    (typeof f.displayName === "string" && f.displayName) ||
    (f.storagePath !== undefined && typeof f.name === "string" && f.name) ||
    stripped.split("/").pop() ||
    stripped;

  return { key, displayName: String(display), size: Number(f.size || 0) };
}

/** `toDriveFileRef` over a list, dropping entries with no usable key. */
function toDriveFileRefs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    const ref = toDriveFileRef(f);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * The canonical shape written to `manifest.drives[id].files` and handed to RN.
 *
 * Carries the canonical `key`/`displayName` plus the two legacy spellings,
 * which `MainScreen.tsx` and `ShareLinkFlowContext.tsx` still read. Writing
 * both is what lets RN adopt `DriveFileRef` in a separate change.
 */
function driveFileRecord(ref) {
  return {
    key: ref.key,
    displayName: ref.displayName,
    size: ref.size,
    // Legacy: the persisted spelling. `name` is the display name here.
    name: ref.displayName,
    storagePath: normalizeKey(ref.key),
  };
}

/**
 * What this session's swarm is actually doing: `"server"` (announcing),
 * `"client"` (looking up only), or `"none"` (a live session with no swarm).
 *
 * Reads the flag the join site wrote. It does not re-derive the answer from
 * `isReceiving`, and that restraint is the point: two derivations of one fact
 * is how `already: true` came to be returned for a drive with `swarm: null`.
 *
 * The `bwarn` fallback should be unreachable — all three producers set the
 * flag. It is a tripwire for a fourth producer added without it.
 */
/**
 * Does this manifest entry hold every file its own manifest lists? Deliberately
 * strict: a false positive puts a copy that cannot serve its files on the DHT.
 * Matched by name as a multiset, not by count, with `uniquePath`'s `" (n)"` undone
 * before comparing. An empty share is never complete.
 */
function localHeldNameKey(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${stem.replace(/ \(\d+\)$/, "")}${ext}`;
}

function receivedDriveIsComplete(entry) {
  const files = Array.isArray(entry?.files) ? entry.files : [];
  if (files.length === 0) return false;

  const held = new Map();
  for (const lf of Array.isArray(entry?.localFiles) ? entry.localFiles : []) {
    // `path` is required, not just `name`: a record without a path is not a
    // file anything can read, let alone serve.
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

/**
 * May this received session announce? Three independent conditions, all
 * required — any one alone would let a copy that cannot serve reach the DHT:
 *
 *  1. `session.serve === true` — the in-session opt-in. `undefined` is "no
 *     opinion" and is not `true`.
 *  2. `entry.reshared === true` — the persisted intent. A flag that lived only
 *     on the session would be re-derived differently at boot.
 *  3. every file held — `receivedDriveIsComplete` above.
 *
 * A hosted drive never reaches here; callers check `isReceiving` first, and
 * the first line re-checks it rather than trusting them.
 */
function receivedDriveMayServe(session) {
  if (!session || !session.isReceiving) return false;
  if (session.serve !== true) return false;
  const entry = manifest?.drives?.[session.driveId];
  if (!entry || entry.reshared !== true) return false;
  return receivedDriveIsComplete(entry);
}

function currentSwarmMode(session) {
  if (!session || !session.swarm) return "none";
  if (session.swarmMode === "server" || session.swarmMode === "client") {
    return session.swarmMode;
  }
  const derived = session.isReceiving ? "client" : "server";
  bwarn(
    "engine.swarm",
    `swarmMode missing drive=${session.driveId} — derived ${derived} from isReceiving. ` +
      `A swarm was joined without recording its mode; the reply is a guess.`,
  );
  return derived;
}

/**
 * The single entry point for receive-side progress tracking; a session that arrives
 * by hydration has no `_unhookDownload` and would show a frozen bar. Idempotent, and
 * it has to be: `bindHyperdriveDownloadTracking` adds its listener synchronously but
 * assigns `_unhookDownload` later, so a second call would double-count every block.
 */
function ensureDownloadTracking(session) {
  if (!session || !session.drive) return;
  if (session._dlTrackingBound) return;
  session._dlTrackingBound = true;
  bindHyperdriveDownloadTracking(session);
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
    // A peer is attached, so there is no idle period to expire and the next
    // one gets its own wake. Cleared on the rising edge unconditionally: a
    // second peer arriving while the first is still here writes values that
    // are already correct.
    tracker.lastPeerLeftAt = null;
    tracker.idleGraceEmitted = false;
    // Peer lines carry driveId, peerId and the live peer count, because
    // "peer connected" alone names neither the drive nor how many are on it.
    binfo(
      "engine.peer",
      `host peer-connected drive=${driveId} peer=${peerId} peers=${tracker.peers.size}`,
    );
    emitUploadProgressSnapshot(tracker);
    startUploadTrackerTimer(tracker);

    store.replicate(socket);
    socket.on("close", () => {
      const liveTracker = uploadTrackers.get(driveId);
      if (!liveTracker) {
        // No tracker means no record either way, so the honest answer is
        // "not delivered" — RN's finalize gates on `=== true` and so fails
        // closed here rather than finalizing on a missing field.
        emitEvent({ type: "peer-disconnected", driveId, peerId, delivered: false, deliveredPeers: 0 });
        binfo(
          "engine.peer",
          `host peer-disconnected drive=${driveId} peer=${peerId} (tracker already gone)`,
        );
        return;
      }
      const peer = liveTracker.peers.get(peerId);
      liveTracker.peers.delete(peerId);
      // Stamp only on the falling edge to zero, the same rule the RN handler
      // uses. Two peers dropping to one is not the last peer leaving, and
      // restamping there would extend the window on every churn. Read after
      // the delete, so `size === 0` means this peer was the last one.
      if (liveTracker.peers.size === 0) {
        liveTracker.lastPeerLeftAt = Date.now();
        liveTracker.idleGraceEmitted = false;
      }
      // Read after the delete on purpose: `deliveredPeers` is the record that
      // survives it. "Delivered" means at least one peer finished, never that
      // the active set is empty.
      //
      // Emitted after the tracker work rather than before it, because the
      // field cannot be computed before the record is consulted. The order
      // relative to the snapshot below is peer-disconnected first.
      const deliveredCount = liveTracker.deliveredPeers ? liveTracker.deliveredPeers.size : 0;
      emitEvent({
        type: "peer-disconnected",
        driveId,
        peerId,
        delivered: deliveredCount > 0,
        deliveredPeers: deliveredCount,
      });
      binfo(
        "engine.peer",
        `host peer-disconnected drive=${driveId} peer=${peerId} peers=${liveTracker.peers.size} ` +
          `sentBytes=${Math.round(peer?.sentBytes || 0)} completed=${!!peer?.completed} ` +
          `deliveredPeers=${deliveredCount}`,
      );
      emitUploadProgressSnapshot(liveTracker);
    });
  });

  bindHyperdriveUploadTracking(session);

  const done = drive.findingPeers();
  // The join options are always explicit: hyperswarm's default is `server: true`, and
  // a receiver needs `client` only. The returned `PeerDiscoverySession` is kept.
  const announce =
    typeof session.serve === "boolean" ? session.serve : !session.isReceiving;
  binfo(
    "engine.swarm",
    `join drive=${driveId} server=${announce} client=true ` +
      `serveOptIn=${typeof session.serve === "boolean" ? String(session.serve) : "default"} ` +
      `(${announce ? "announcing discoveryKey" : "client-only: does not advertise"})`,
  );
  session.discovery = swarm.join(drive.discoveryKey, { server: announce, client: true });
  // Record what was actually set up. `engineActivateDrive` reports this back
  // over the RPC, and a mode derived at read time from `isReceiving` would be
  // a second guess at the same question — which is how `already: true` came
  // to describe a swarm that did not exist. Written here, at the join, so it
  // cannot disagree with it.
  session.swarmMode = announce ? "server" : "client";
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

// Rehydrate previously-active drives from disk on boot; the corestore already holds
// every block. Re-attaching a swarm is hosted-only, and one drive's failure is not fatal.
function recordHydrateFailure(driveId, message, detail) {
  resumeErrors.set(driveId, { error: message, at: Date.now() });
  // Give the trace the typed shape the rest of the taxonomy uses; a bare
  // message string with no category or cause is not traceable.
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

  // Hydrate both ACTIVE entries (full hydration — open store, attach swarm)
  // and INACTIVE ones (light hydration — RN learns the drive exists, no swarm
  // contact). The legacy STOPPED state maps to INACTIVE so older manifests
  // behave correctly. Each rejection below names its reason: a bad key or a
  // missing storagePath must not make a drive silently never appear.
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
    // A simulated receive writes a real manifest entry so the share-key index
    // can resolve it, but it has no corestore behind it, and hydrating one
    // would surface a permanent "Couldn't restore" row. Skipped, never
    // pruned: the entry stays visible and inert, and deleting it is the
    // user's call.
    if (d.simulated) {
      bwarn("engine.hydrate", `skip drive=${d.driveId} reason=simulated-entry (Sprint 9E instrument)`);
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
        // Non-destructive: never mark the entry "failed" in the manifest. A
        // transient error — a permission blip, a race with an OS scan —
        // would permanently demote the drive. Track it in memory only, emit
        // the standard event, and re-attempt on the next boot.
        recordHydrateFailure(entry.driveId, "Storage directory missing");
        failed++;
        continue;
      }

      if (targetState === DriveState.INACTIVE) {
        bdebug(
          "engine.hydrate",
          `drive=${entry.driveId} light-hydrate (inactive, no swarm, no corestore)`,
        );
        // Light hydration: announce the entry to RN without joining the swarm
        // or opening the corestore, which is only touched again when the user
        // activates the drive. Any stale resumeError is cleared, since the
        // drive light-hydrated cleanly.
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
      const isReceived = (entry.origin || "hosted") === "received";
      const session = {
        driveId: entry.driveId,
        drive,
        store,
        swarm: null,
        // Stated, not left to be inferred from `swarm == null` by a reader
        // that may not check. A received drive leaves this branch with a live
        // Corestore, a live Hyperdrive, a registration in `activeDrives` and
        // no swarm — the exact state `engineActivateDrive` must not answer
        // `already: true` about. `attachHostSwarm` overwrites it on the
        // hosted path.
        swarmMode: "none",
        metadata: entry,
        totalBytes,
        isReceiving: isReceived,
        shareLink: createShareLink(entry.key),
        // The persisted key set, in the canonical shape, so a grab through
        // `engineActivateDrive` does not depend on what has replicated
        // locally.
        files: toDriveFileRefs(entry.files),
        shareName: entry.name,
      };
      // The boot rule: a received drive gets a swarm only if it is `reshared` and
      // complete, and then as a server. Completeness is not consent, and neither half
      // is optional. The corestore is still opened and the session still registered.
      const reshareAtBoot =
        isReceived &&
        entry.reshared === true &&
        receivedDriveIsComplete(entry);
      if (isReceived && !reshareAtBoot) {
        binfo(
          "engine.hydrate",
          `drive=${entry.driveId} hydrated WITHOUT swarm reason=` +
            (entry.reshared === true ? "reshared-but-incomplete" : "received-origin") +
            ` state=${entry.state} localFiles=${Array.isArray(entry.localFiles) ? entry.localFiles.length : 0}` +
            `/${Array.isArray(entry.files) ? entry.files.length : 0} ` +
            `— a received copy does not announce until the user asks it to`,
        );
      } else {
        if (reshareAtBoot) {
          session.serve = true;
          binfo(
            "engine.hydrate",
            `drive=${entry.driveId} hydrating AS A SERVER reason=reshared-and-complete ` +
              `files=${Array.isArray(entry.files) ? entry.files.length : 0} — ADD-2 re-share`,
          );
        }
        session.swarm = attachHostSwarm(session);
      }

      activeDrives.set(entry.driveId, session);
      // A successful hydrate clears any stale resumeError left over from a
      // prior boot's transient failure.
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
      // Non-destructive: never persist "failed".
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

// Nudge every active drive's swarm to re-announce after a network change. It must
// never be `swarm.leave()` + `swarm.join()`: the leave is an active `dht.unannounce`.
export async function engineRefreshSwarm() {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }

  const flushes = [];
  let reannounced = 0;

  // This runs on a foreground interval and on every background→active
  // transition, so it is the loop behind any "it worked, then peers stopped
  // finding me" report. It must not be silent.
  bdebug("engine.swarm", `refresh start: ${activeDrives.size} active drive(s)`);

  for (const session of activeDrives.values()) {
    if (!session.swarm) {
      bdebug("engine.swarm", `refresh skip drive=${session.driveId} reason=no-swarm`);
      continue;
    }
    if (session.isReceiving && !receivedDriveMayServe(session)) {
      // Receivers take the flush-only path unless `receivedDriveMayServe` holds.
      // `PeerDiscoverySession.refresh` promotes, so do not weaken or move this branch.
      const rsEntry = manifest?.drives?.[session.driveId];
      bdebug(
        "engine.swarm",
        `refresh flush-only drive=${session.driveId} reason=receiver ` +
          `serveOptIn=${typeof session.serve === "boolean" ? String(session.serve) : "default"} ` +
          `reshared=${rsEntry?.reshared === true} ` +
          `complete=${receivedDriveIsComplete(rsEntry)}`,
      );
      flushes.push(session.swarm.flush().catch((err) => {
        swallowed("engine.swarm", `receiver flush ${session.driveId}`, err);
      }));
      continue;
    }

    const tracker = uploadTrackers.get(session.driveId);
    const noPeersRightNow = !tracker || tracker.peers.size === 0;

    try {
      if (noPeersRightNow && session.drive?.discoveryKey) {
        // Re-announce without unannouncing: `swarm.leave` is destructive, so
        // `refresh` is the non-destructive push. `server` is DERIVED, never `true`.
        const discovery = session.discovery;
        if (discovery && !discovery.destroyed) {
          const announce =
            typeof session.serve === "boolean" ? session.serve : !session.isReceiving;
          binfo(
            "engine.swarm",
            `refresh reannounce drive=${session.driveId} reason=no-peers ` +
              `server=${announce} client=true (announce refresh, DHT record kept)`,
          );
          discovery.refresh({ server: announce, client: true }).catch((err) => {
            swallowed("engine.swarm", `reannounce ${session.driveId}`, err);
          });
          reannounced++;
        } else {
          // Every hosted swarm in this engine is built by `attachHostSwarm`,
          // which stores the handle, so this is not a reachable state today.
          // It is a warn rather than a silent skip because if it ever does
          // happen the share stops being re-announced on network changes and
          // nothing else would say so.
          bwarn(
            "engine.swarm",
            `refresh reannounce skipped drive=${session.driveId} reason=no-discovery-handle ` +
              `(swarm not built by attachHostSwarm?)`,
          );
        }
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
  binfo(
    "engine.swarm",
    `refresh done: refreshed=${flushes.length} reannounced=${reannounced} rejoined=0`,
  );
  // `rejoined` is kept on the wire and pinned at 0. It is
  // typed at `src/lib/rpc.ts:130`, quoted in `ARCHITECTURE.md:623` and in the
  // engine-contract table, and read by the harness — and it is now literally
  // true, because nothing rejoins any more. `reannounced` is the counter that
  // carries the meaning it used to.
  return { ok: true, refreshed: flushes.length, reannounced, rejoined: 0 };
}

// `relPaths` (optional) is a parallel array of subdirectory paths inside a
// shared folder. When set, relPaths[i] becomes the storage path for the
// matching file, preserving folder structure on the receiver. When unset
// (or empty), each file flattens to its basename — the file-share behavior.
/**
 * `shareName` is the name the user chose, and it goes on the wire. For a single file
 * it becomes the drive entry key, not just the title: the receiver writes what
 * `drive.list("/")` yields, and entry keys go through `safePathWithin` + `uniquePath`.
 * For a bundle it is `metadata.name` only, so children keep their own names.
 */
export async function engineShareFromPaths(paths, relPaths, shareName) {
  if (!initialized) {
    throw new EngineError({
      category: "engine.not-initialized",
      cause: "not-initialized",
      message: "Engine not initialized",
    });
  }

  // Block creating a share while the manifest is unavailable: the new drive could
  // not be persisted, so it would exist only in memory and vanish on the next launch.
  if (manifestUnavailable) {
    return failure(
      "manifest.unavailable",
      "manifest-unavailable",
      MANIFEST_UNAVAILABLE_MESSAGE,
    );
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

  // stat the files up-front instead of reading their bytes.
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

  // apply the user's chosen name.
  //
  // Run through the SAME validators the receive path uses on a peer's title.
  // The sender's dialog has already validated this, but a second caller (the
  // test bed, a future automation) reaches this function directly, and an
  // engine that trusts its caller is one caller away from not being guarded.
  const chosenTitle = sanitizeShareTitle(shareName);

  // Single file → the chosen name becomes the in-drive ENTRY KEY, because the
  // entry key is what the receiver writes. The extension is carried over from
  // the original and is not the user's to change; the dialog renders it as
  // fixed text for the same reason.
  //
  // Skipped when `relPath` is set: that file is part of a folder structure and
  // its key encodes its position in the tree.
  if (chosenTitle && fileList.length === 1 && !fileList[0].relPath) {
    const original = fileList[0].name;
    const dot = original.lastIndexOf(".");
    const ext = dot > 0 ? original.slice(dot) : "";
    // A drive entry key must be a single path component — `sanitizeFolderName`
    // is what folds separators, and reusing it keeps one definition of that.
    const safeBase = sanitizeFolderName(chosenTitle);
    if (safeBase) {
      // same double-extension rule as the dialog's
      // `joinNameAndExt`. The field shows `.jpeg` as fixed text and people
      // type it anyway; without this a chosen "holiday.jpeg" against a
      // ".jpeg" suffix becomes "holiday.jpeg.jpeg" on the receiver's disk.
      //
      // Duplicated rather than imported because this is the Bare realm and
      // `src/lib/shareName.ts` is TypeScript the worklet cannot load — the
      // same split every backend/RN pair in this project lives with. The two
      // must move together; `shareName.test.ts` covers the rule itself.
      const lowerBase = safeBase.toLowerCase();
      const lowerExt = ext.toLowerCase();
      fileList[0].name =
        ext && lowerBase.endsWith(lowerExt)
          ? `${safeBase.slice(0, safeBase.length - ext.length)}${ext}`
          : `${safeBase}${ext}`;
      binfo(
        "engine.share",
        `single-file share renamed in-drive ${JSON.stringify(original)} -> ` +
          `${JSON.stringify(fileList[0].name)} — the source file on disk is untouched`,
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
    // Single file: the (possibly renamed) filename — title and
    // filename converge, which is correct, there is only one thing to name.
    // Bundle: the chosen title, falling back to the old generic default when
    // no name was given, so a share created without one still renders.
    name:
      fileList.length === 1
        ? fileList[0].name
        : chosenTitle || `${fileList.length} files`,
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

  // the wire caps a drive manifest at 1000 entries. Over
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

    // stream each file in sequentially. The size already came
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
        // the canonical spellings, written beside the
        // legacy pair so `engineListDrives` and `engineActivateDrive` read one
        // shape on the hosted side too. See `toDriveFileRef`.
        key: `/${normalizeKey(storagePath)}`,
        displayName: f.name,
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
    // normalize the rethrow so uncaught bubbles have typed
    // shape too. Preserves the underlying err via detail.code.
    throw wrapError(err, {
      category: "share.drive-create-fail",
      cause: "share-add-files-fail",
    });
  }
}

// Read the manifest blob, re-probing until the resolve budget is spent, because
// `drive.update()` resolves on head metadata and not on blob replication.
async function readManifestBlobWithinBudget(drive, driveId, deadline, pendingConnection) {
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    if (pendingConnection?.aborted) {
      bdebug("engine.open", `manifest wait aborted by user drive=${driveId} after ${attempts} probe(s)`);
      return null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      bwarn(
        "engine.open",
        `manifest blob ${DRIVE_MANIFEST_PATH} NEVER replicated drive=${driveId} — ` +
          `gave up after ${Date.now() - started}ms and ${attempts} probe(s)`,
      );
      return null;
    }

    attempts += 1;
    // `drive.get` blocks when the entry is known but its block has not
    // arrived, so the probe itself is raced against what is left of the
    // budget. The losing side stays pending: the detached `.catch` is what
    // stops a later rejection surfacing as an unhandled rejection in the
    // worklet realm (same idiom as the `_saveChain` observer). The race still
    // sees the original rejection, so a genuine read error propagates to the
    // caller's try/catch exactly as before.
    let timer = null;
    const getPromise = drive.get(DRIVE_MANIFEST_PATH);
    getPromise.catch(() => {});
    const budgetExpired = Symbol("manifest-budget-expired");
    let raw;
    try {
      raw = await Promise.race([
        getPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(budgetExpired), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (raw === budgetExpired) {
      bwarn(
        "engine.open",
        `manifest blob ${DRIVE_MANIFEST_PATH} did not arrive drive=${driveId} — ` +
          `budget spent after ${Date.now() - started}ms and ${attempts} probe(s)`,
      );
      return null;
    }
    if (raw) {
      if (attempts > 1) {
        binfo(
          "engine.open",
          `manifest blob arrived drive=${driveId} on probe ${attempts} after ${Date.now() - started}ms ` +
            `— the single-probe read would have missed it`,
        );
      }
      return raw;
    }

    // null: the entry is not in the replicated head yet. Back off and re-probe.
    await new Promise((resolve) => setTimeout(resolve, MANIFEST_POLL_MS));
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

  // Block receiving too: the open path persists a SEEKING entry first and the
  // cleanup pass needs it, so with saves refused the folder would be an orphan.
  if (manifestUnavailable) {
    return failure(
      "manifest.unavailable",
      "manifest-unavailable",
      MANIFEST_UNAVAILABLE_MESSAGE,
    );
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
  // receive-side peer count, so the log can distinguish
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
  // Client-only. With no options hyperswarm defaults to `{ server: true, client: true }`,
  // so resolving a link would announce a device holding no file blocks.
  binfo(
    "engine.open",
    `joining swarm drive=${driveId}, seeking peers (server=false client=true, receiver does not announce)`,
  );
  // the discovery session is CAPTURED now. It used to be
  // discarded, which is the second half of why a late host was never found —
  // see the re-query timer below.
  const discovery = swarm.join(drive.discoveryKey, { server: false, client: true });
  const flushStart = Date.now();
  await swarm.flush();
  binfo(
    "engine.open",
    `swarm.flush returned drive=${driveId} in ${Date.now() - flushStart}ms peers=${connectedPeerIds.size}`,
  );

  // `done()` is released on the deadline, not after the flush: `swarm.flush()` means
  // this client's lookup propagated, not that a peer answered. The helper is idempotent.
  const resolveDeadline = Date.now() + RESOLVE_WAIT_MS;
  let findingPeersReleased = false;
  const releaseFindingPeers = (why) => {
    if (findingPeersReleased) return;
    findingPeersReleased = true;
    bdebug("engine.open", `findingPeers released drive=${driveId} (${why})`);
    try {
      done();
    } catch (e) {
      swallowed("engine.open", `findingPeers done() ${driveId}`, e);
    }
  };
  const findingPeersTimer = setTimeout(
    () => releaseFindingPeers(`no peer answered within ${RESOLVE_WAIT_MS}ms`),
    RESOLVE_WAIT_MS,
  );

  // Re-query the DHT while waiting: `swarm.flush()` runs the lookup ONCE, at t=0.
  // `{ server: false, client: true }` is explicit because `refresh` PROMOTES.
  const rediscoverTimer = setInterval(() => {
    if (findingPeersReleased || connectedPeerIds.size > 0) return;
    bdebug(
      "engine.open",
      `re-querying DHT drive=${driveId} (no peer yet, ${Math.max(0, resolveDeadline - Date.now())}ms of budget left)`,
    );
    // Detached: a refresh that fails is not fatal — the next tick retries, and
    // an unhandled rejection in the worklet realm would be.
    Promise.resolve(discovery.refresh({ server: false, client: true })).catch((e) => {
      swallowed("engine.open", `discovery.refresh ${driveId}`, e);
    });
  }, RESOLVE_REQUERY_MS);

  const pendingConnection = {
    driveId,
    aborted: false,
    cleanup: async () => {
      // four best-effort teardown steps, each previously a
      // bare `catch {}`. Behaviour unchanged; the failures are now visible.
      bdebug("engine.open", `cleanup start drive=${driveId}`);
      // release the deadline timer and `findingPeers`
      // FIRST, before anything below closes the drive this `done()` belongs
      // to. A timer left armed here would fire against a closed Hyperdrive,
      // and the re-query interval against a destroyed swarm.
      clearTimeout(findingPeersTimer);
      clearInterval(rediscoverTimer);
      releaseFindingPeers("cleanup");
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
      `drive.update resolved drive=${driveId} in ${Date.now() - updateStart}ms ` +
        `(head metadata received) peers=${connectedPeerIds.size} ` +
        `budgetLeft=${Math.max(0, resolveDeadline - Date.now())}ms`,
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
    // distinguish user-cancellation from other open failures.
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
  // head metadata is in (or the budget ran out). Either
  // way no further peer discovery is being waited on, so stop holding
  // `findingPeers` open — the remaining budget belongs to the manifest blob,
  // and a peer we already have is the one that will deliver it.
  clearTimeout(findingPeersTimer);
  clearInterval(rediscoverTimer);
  releaseFindingPeers("drive.update returned");

  let files = [];
  let manifestData = null;
  let totalBytes = 0;
  let shareName = null;
  let truncated = null;

  try {
    // was a single `await drive.get(DRIVE_MANIFEST_PATH)`.
    // identified this as THE empty-manifest bug origin and
    // logged it; the read itself stayed a one-shot probe taken at the instant
    // head metadata landed, which is the earliest moment the blob could
    // possibly be missing. It now re-probes until the resolve budget is spent.
    // `readManifestBlobWithinBudget` logs each way it can give up.
    const raw = await readManifestBlobWithinBudget(
      drive,
      driveId,
      resolveDeadline,
      pendingConnection,
    );
    if (raw && raw.byteLength > DRIVE_MANIFEST_MAX_SIZE) {
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
        // validated where it enters, not where it is used.
        // This was `shareName = manifestData.name` — raw, untyped, uncapped,
        // straight from a peer's manifest into a value that later becomes a
        // directory name. See `sanitizeShareTitle`.
        const rawTitle = manifestData.name;
        shareName = sanitizeShareTitle(rawTitle);
        if (rawTitle !== undefined && rawTitle !== null && shareName === null) {
          bwarn(
            "engine.open",
            `share title rejected drive=${driveId} type=${typeof rawTitle} ` +
              `len=${typeof rawTitle === "string" ? rawTitle.length : "n/a"} ` +
              `— unusable after validation, falling back to no title`,
          );
        }
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
            // the canonical spelling of `name`,
            // added alongside it rather than replacing it. `name` here is the
            // KEY, which is the collision `DriveFileRef` exists to end.
            key: finalName,
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
        // canonical spelling, added beside the legacy one.
        key: entry.key,
      });
    }
    totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length === 0) {
      berror(
        "engine.open",
        `EMPTY RESOLVE drive=${driveId} — manifest unavailable AND drive.list() returned nothing; ` +
          `peers=${connectedPeerIds.size} hasManifest=${!!manifestData}. This is the "0 files in here" ` +
          `state; blobs likely not replicated yet.`,
      );
    } else {
      binfo("engine.open", `drive.list() fallback found ${files.length} file(s) totalBytes=${totalBytes}`);
    }
  }

  // The return must agree with the diagnosis, so the gate keys on `manifestData` and
  // never on `files.length`, and lands before the ACTIVE promotion so nothing leaks.
  if (!manifestData) {
    bwarn(
      "engine.open",
      `resolve REJECTED drive=${driveId} — no manifest after ${RESOLVE_WAIT_MS}ms budget; ` +
        `peers=${connectedPeerIds.size} listFallbackFiles=${files.length}. ` +
        `Tearing down rather than reporting success.`,
    );
    pendingConnections.delete(driveId);
    await pendingConnection.cleanup();
    return failure(
      "receive.no-manifest",
      "receive-no-manifest",
      "Couldn't read what's in this share yet. Give it another go in a moment.",
      { driveId, peers: connectedPeerIds.size, waitedMs: RESOLVE_WAIT_MS },
    );
  }

  // transition the SEEKING entry to ACTIVE rather than deleting
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
  // No display fallback is stored: a fallback here reaches `sanitizeFolderName` and
  // becomes a directory name. `null`, not `undefined`, survives the JSON round-trip.
  meta.name = shareName || null;
  meta.totalBytes = totalBytes;
  // one canonical shape, written by both producers.
  const fileRefs = toDriveFileRefs(files);
  meta.files = fileRefs.map(driveFileRecord);
  manifest.drives[driveId] = meta;
  try { await saveManifest(); } catch {}

  const session = {
    driveId,
    drive,
    store,
    swarm,
    // This join is `{ server: false, client: true }`, so the mode is `client`, stated
    // here rather than re-derived. `discovery` is KEPT so a later Share can promote it.
    discovery,
    swarmMode: "client",
    serve: false,
    isReceiving: true,
    manifest: manifestData,
    totalBytes,
    shareName,
    shareLink: shareLink.trim(),
    metadata: meta,
    // the session carries the CANONICAL shape. The wire reply
    // below still carries the legacy one until RN adopts `DriveFileRef`.
    files: fileRefs,
  };
  activeDrives.set(driveId, session);

  // stream live progress events as blocks land,
  // not just one event per file-completion. Hooks blobs.core / db.core
  // 'download' so the receiver UI shows real movement on big files.
  //
  // delta 3: routed through `ensureDownloadTracking`
  // so this and `engineActivateDrive` share ONE binding path. Two call sites
  // that could both bind the same session is how the double-count would arrive.
  ensureDownloadTracking(session);

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

/**
 * Stop a transfer that is happening right now, without destroying anything the user
 * did not ask to destroy: `engineStopDrive({purge:true})` deletes storage out from
 * under a running loop. This sets `_cancelled` and destroys the stream the loop is
 * parked on; the loop then does its own teardown, so exactly one path owns it.
 */
export async function engineCancelTransfer(driveId) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  const id = String(driveId || "");
  if (!id) {
    return failure("drive.invalid-arg", "drive-id-required", "driveId required");
  }

  // Simulated transfers: the existing fake-session teardown in
  // engineStopDrive already clears the timers and removes the simulated
  // manifest entry. `purge:false` because there is no real storage to purge
  // and the flag only decorates the emitted event.
  const fakeSession = fakeSessions.get(id);
  if (fakeSession) {
    const direction = fakeSession.simulated ? "download" : "upload";
    const res = await engineStopDrive(id, { purge: false });
    binfo("engine.cancel", `cancelled simulated transfer drive=${id} direction=${direction}`);
    emitEvent({ type: "transfer-cancelled", driveId: id, direction, filesKept: 0 });
    return res;
  }

  const session = activeDrives.get(id);
  if (!session) {
    // Nothing in flight. Emits NOTHING on purpose: a `transfer-cancelled`
    // here would be a claim that something was stopped, and the most likely
    // way to reach this branch is a cancel that lost a race with a download
    // finishing normally — which must stay reported as finished.
    binfo("engine.cancel", `cancel drive=${id} — no active session, nothing to stop`);
    return { ok: true, alreadyInactive: true };
  }

  session._cancelled = true;

  if (session._dlRunning) {
    const abort = session._abortActivePipe;
    binfo(
      "engine.cancel",
      `cancel drive=${id} — download in flight, ` +
        `${typeof abort === "function" ? "aborting active stream" : "between files"}; ` +
        `loop will unwind and emit transfer-cancelled`,
    );
    if (typeof abort === "function") {
      try {
        abort();
      } catch (e) {
        swallowed("engine.cancel", `abort active pipe ${id}`, e);
      }
    }
    // The loop emits the terminal event. Returning early is the contract.
    return { ok: true, unwinding: true };
  }

  // No download loop: a hosted share serving peers, or a receive session
  // that was opened but never started pulling. Deactivate — swarm and
  // session torn down, storage and manifest entry preserved.
  const direction = session.isReceiving ? "download" : "upload";
  const res = await engineDeactivateDrive(id);
  binfo("engine.cancel", `cancelled drive=${id} direction=${direction} (deactivated, not purged)`);
  emitEvent({ type: "transfer-cancelled", driveId: id, direction, filesKept: 0 });
  return res;
}

/**
 * Wait for a cancelled `engineDownload` loop to finish unwinding. Bounded, so a stuck
 * stream cannot turn Delete into a hang; timing out is no worse than not waiting.
 * Polling rather than a promise handshake, because `_dlRunning` is already the flag
 * `engineCancelTransfer` reads and a second channel for one fact would drift.
 */
const LOOP_SETTLE_TIMEOUT_MS = 3000;
const LOOP_SETTLE_POLL_MS = 25;

async function waitForDownloadLoopToSettle(session, driveId) {
  const startedAt = Date.now();
  while (session._dlRunning) {
    if (Date.now() - startedAt >= LOOP_SETTLE_TIMEOUT_MS) {
      bwarn(
        "engine.stop",
        `download loop did not settle within ${LOOP_SETTLE_TIMEOUT_MS}ms drive=${driveId} ` +
          `— proceeding with teardown anyway (purge may race an in-flight write)`,
      );
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, LOOP_SETTLE_POLL_MS));
  }
  bdebug(
    "engine.stop",
    `download loop settled drive=${driveId} in ${Date.now() - startedAt}ms`,
  );
  return true;
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
    // the download simulation is the only fake session that owns
    // a manifest entry. Cancelling it must take the entry with it, or the
    // row outlives the simulation that created it.
    if (fakeSession.simulated && manifest.drives[driveId]?.simulated) {
      delete manifest.drives[driveId];
      try { saveManifest(); } catch {}
      binfo("engine.simulate", `removed simulated manifest entry drive=${driveId} (cancelled)`);
    }
    emitEvent({ type: "drive-stopped", driveId, purged: opts.purge !== false });
    return { ok: true };
  }

  // A drive with no live session is still deletable: every INACTIVE drive is
  // light-hydrated without one. Only an id with no manifest entry is a failure.
  const session = activeDrives.get(driveId);
  const entry = manifest.drives[driveId];
  if (!session && !entry) {
    return failure("drive.not-active", "drive-not-active", "Drive not active");
  }

  const purge = opts.purge !== false;
  binfo(
    "engine.stop",
    `stop drive=${driveId} purge=${purge} session=${session ? "live" : "none"} ` +
      `(purge deletes local storage)`,
  );

  // Stop the download loop FIRST and wait for it to unwind, before closing or
  // deleting anything it reads. The order is flag, abort, settle, THEN destroy.
  if (session) {
    if (session._dlRunning) {
      session._cancelled = true;
      const abort = session._abortActivePipe;
      if (typeof abort === "function") {
        try {
          abort();
        } catch (e) {
          swallowed("engine.stop", `abort active pipe ${driveId}`, e);
        }
      }
      await waitForDownloadLoopToSettle(session, driveId);
    }

    // detach the download-event listener (if any) before closing
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
  }

  // fall back to the manifest entry's storagePath. A light-hydrated
  // drive has no session to carry it, and that is the case this whole change
  // exists for.
  const storagePath = session?.metadata?.storagePath ?? entry?.storagePath;

  // Whether the bytes are genuinely gone, which decides whether the manifest entry
  // may be removed. `force: true` does not throw, so "already absent" counts as gone.
  let storageGone = false;
  if (purge) {
    if (!storagePath) {
      storageGone = true;
    } else {
      bwarn("engine.stop", `purging local storage drive=${driveId} path=${storagePath}`);
      try {
        await fs.rm(storagePath, { recursive: true, force: true });
        storageGone = true;
      } catch (e) {
        // NOT `swallowed()`. This failure now changes what happens to the
        // manifest entry, so it has to be loud rather than a debug breadcrumb.
        berror(
          "engine.stop",
          `purge FAILED drive=${driveId} path=${storagePath} — ${describeError(e)}; ` +
            `keeping a PURGED tombstone so the storage stays findable`,
        );
      }
    }
  }

  if (entry) {
    // An explicit Delete removes the entry rather than leaving a PURGED tombstone,
    // guarded on `storageGone`: a failed `fs.rm` would orphan the corestore.
    if (purge && storageGone) {
      delete manifest.drives[driveId];
      manifest.stats.totalPurged = (manifest.stats.totalPurged || 0) + 1;
      binfo(
        "engine.stop",
        `manifest entry REMOVED drive=${driveId} (explicit delete, storage confirmed gone)`,
      );
      await saveManifest();
    } else {
      setDriveState(
        entry,
        purge ? DriveState.PURGED : DriveState.STOPPED,
        `engineStopDrive: purge=${purge}${purge ? " storage-rm-failed" : ""}`,
      );
      entry.stoppedAt = Date.now();
      if (purge) manifest.stats.totalPurged = (manifest.stats.totalPurged || 0) + 1;
      await saveManifest();
    }
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

// stream a file from disk into the drive. Replaces the
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

// Stream a file out of the drive to disk, unlinking the partial output on any pipe
// error, with a stall watchdog re-armed on each 'data' chunk so a dropped peer cannot hang.
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

// the user asked for this file to stop arriving.
//
// A distinct type rather than a flag on FileStallError because the two must
// never be confused downstream: a stall is a failure and shows an error, a
// cancellation is an instruction obeyed and must not. `engineDownload`
// branches on `cause === "transfer-cancelled"` to unwind rather than to
// record a failed file.
class TransferCancelledError extends EngineError {
  constructor(destPath) {
    super({
      category: "receive.cancelled",
      cause: "transfer-cancelled",
      message: "Cancelled.",
      detail: { destPath },
    });
    this.name = "TransferCancelledError";
  }
}

/**
 * Stream one drive entry to disk. `session._abortActivePipe` is installed for the
 * lifetime of the stream, so a cancel can destroy one parked on blocks that will
 * never arrive. Settle on `'close'` and not `'finish'`; keep the `once("error")` +
 * `settled` pair and the passive `rs.on("data", armStall)`; `armStall()` fires first.
 */
function pipeDriveToFile(drive, driveKey, destPath, session) {
  const partPath = `${destPath}${PARTIAL_SUFFIX}`;
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
      // the handle must go on EVERY exit, not just the happy one.
      // A stale abort handle pointing at a destroyed stream is how a later
      // cancel tears down the wrong file.
      if (session && session._abortActivePipe === abort) {
        session._abortActivePipe = null;
      }
      if (err) {
        // Best-effort destroy so a stalled read stream doesn't keep
        // eating memory after we've moved on to the next file.
        try { rs?.destroy(); } catch {}
        try { ws?.destroy(); } catch {}
        // The partial carries PARTIAL_SUFFIX, so this unlink is hygiene
        // rather than the correctness guarantee it used to be.
        fs.unlink(partPath).catch(() => {});
        reject(err);
      } else {
        // Promote the completed partial onto the real name. Only reached
        // after 'close', i.e. after the write stream has flushed.
        fs.rename(partPath, destPath).then(
          () => resolve(),
          (renameErr) => {
            fs.unlink(partPath).catch(() => {});
            reject(
              wrapError(renameErr, {
                category: "receive.write-fail",
                cause: "partial-rename-fail",
                detail: { destPath },
              }),
            );
          },
        );
      }
    };
    const armStall = () => {
      clearStall();
      stallTimer = setTimeout(
        () => done(new FileStallError(destPath)),
        STALL_TIMEOUT_MS,
      );
    };
    const abort = () => done(new TransferCancelledError(destPath));
    let rs;
    let ws;
    try {
      rs = drive.createReadStream(driveKey);
      ws = createWriteStream(partPath);
    } catch (err) {
      return done(err);
    }
    // Installed before the first byte can flow, so a cancel arriving in the
    // same tick as the open still finds something to abort.
    if (session) session._abortActivePipe = abort;
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

/**
 * The share title is peer-supplied and becomes a directory name, so validate it
 * where it ENTERS, not where it is used. A non-string is rejected, not coerced; NUL,
 * C0 controls and DEL are stripped; length is capped on BOTH character count and
 * UTF-8 byte length. Returns null for anything unusable, meaning no folder wrapping.
 */
const SHARE_TITLE_MAX_CHARS = 120;
const SHARE_TITLE_MAX_BYTES = 255;

function sanitizeShareTitle(raw) {
  // 1. Type. `typeof` rather than truthiness so a number or an object is
  // rejected outright rather than coerced into a plausible-looking name.
  if (typeof raw !== "string") return null;

  // Written as escape sequences rather than literal control bytes: the literal form
  // makes this whole file read as binary to grep and diff, hiding the line from review.
  let out = raw.replace(/[\u0000-\u001F\u007F]/g, "");

  // 3. Length, characters first then bytes. The byte trim walks back one
  // character at a time so a multi-byte character is never cut in half —
  // a truncated UTF-8 sequence is a different kind of bad input, not a fix.
  out = out.slice(0, SHARE_TITLE_MAX_CHARS);
  while (out.length > 0 && b4a.byteLength(out, "utf8") > SHARE_TITLE_MAX_BYTES) {
    out = out.slice(0, -1);
  }

  out = out.trim();
  return out.length > 0 ? out : null;
}

// The sender controls the share name, so strip anything that could traverse out of
// the destination directory. `..` is removed before separators are replaced.
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

/**
 * The folder a previous grab of THIS drive already used, re-derived under the parent
 * being downloaded into now, or `null` — otherwise a second launch splits one share
 * across `MyShare` and `MyShare (1)`. Only the last segment of the stored path is
 * used and it goes back through `safePathWithin`; a different parent gets a fresh root.
 */
function rememberedDownloadRoot(entry, outDir) {
  const prev = entry?.downloadRoot;
  if (typeof prev !== "string" || !prev) return null;
  let sameParent = false;
  try {
    sameParent = path.resolve(path.dirname(prev)) === path.resolve(outDir);
  } catch {
    return null;
  }
  if (!sameParent) return null;
  const base = path.basename(prev);
  if (!base || base === "." || base === "..") return null;
  try {
    return safePathWithin(outDir, base);
  } catch {
    // A stored value that will not pass the containment check is discarded,
    // not repaired. The caller then derives a fresh root the normal way.
    return null;
  }
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

  // Enumerate from the SAVED KEYS, not from `drive.list("/")`, which only sees what
  // has replicated. A key the host has since dropped then fails per file and visibly.
  const savedRefs = Array.isArray(session.files) ? session.files : [];
  const filesToDownload = [];
  if (savedRefs.length) {
    for (const ref of savedRefs) {
      const key = ref?.key || ref?.name;
      if (!key) continue;
      if (normalizeKey(key) === normalizeKey(MANIFEST_DOWNLOAD_SKIP)) continue;
      filesToDownload.push({ key });
    }
    binfo(
      "engine.download",
      `enumerated from saved keys drive=${driveId} keys=${filesToDownload.length} ` +
        `(no drive.list — the persisted set is complete regardless of replication)`,
    );
  } else {
    for await (const entry of drive.list("/")) {
      if (entry.key === MANIFEST_DOWNLOAD_SKIP) continue;
      filesToDownload.push({ key: entry.key });
    }
    bwarn(
      "engine.download",
      `no saved key set drive=${driveId} — fell back to drive.list("/") ` +
        `entries=${filesToDownload.length} (DEGRADED: sees only what has replicated locally)`,
    );
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
    // `safePathWithin`, not `path.join`: resolve-and-verify-containment on a
    // peer-supplied name. A title that fails the check does NOT sink the download.
    let folderRoot = null;
    if (isFolderShare) {
      try {
        folderRoot = safePathWithin(outDir, shareName);
      } catch (e) {
        berror(
          "engine.security",
          `peer-rejected drive=${driveId} cause=peer-path-traversal ` +
            `shareName=${JSON.stringify(shareName)} root=${outDir} ` +
            `— share title rejected as a folder name, downloading flat`,
        );
        emitEvent({
          type: "peer-rejected",
          driveId,
          cause: "peer-path-traversal",
          key: shareName,
        });
        swallowed("engine.download", `share title as folder ${driveId}`, e);
      }
    }
    // phase 2i (C-5). A repeat grab of the SAME drive goes back
    // to the folder it used last time; everything else disambiguates exactly as
    // before. See `rememberedDownloadRoot` for what is trusted (the last
    // segment, re-checked with `safePathWithin`) and what is not.
    const remembered = folderRoot ? rememberedDownloadRoot(manifest.drives?.[driveId], outDir) : null;
    if (remembered) {
      downloadRoot = remembered;
      binfo(
        "engine.download",
        `reusing the folder this drive already downloaded into drive=${driveId} ` +
          `root=${downloadRoot} (no uniqueFolderPath — a repeat grab is not a distinct share)`,
      );
    } else {
      downloadRoot = folderRoot ? await uniqueFolderPath(folderRoot) : outDir;
    }
    session._downloadRoot = downloadRoot;
  }
  if (downloadRoot !== outDir) {
    await fs.mkdir(downloadRoot, { recursive: true });
    // Persisted the moment it is chosen, not in the teardown: the folder exists on
    // disk, so a crash first would leave `uniqueFolderPath` stepping around it.
    const rootOwner = manifest.drives?.[driveId];
    if (rootOwner && rootOwner.downloadRoot !== downloadRoot) {
      rootOwner.downloadRoot = downloadRoot;
      try { await saveManifest(); } catch {}
    }
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

  // compute the selected-file total so the live download
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
      // `f.key` first: `name` is the KEY only on the shape `engineOpenDrive` builds,
      // and reading it on the persisted shape misses every lookup and caps the percent.
      sizeByKey.set(normalizeKey(f.key || f.name || ""), Number(f.size || 0));
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

  // The loop is cancellable and unwinds ITSELF: `engineCancelTransfer` sets this flag
  // and destroys the stream, so exactly one of the two paths does the teardown.
  session._cancelled = false;
  session._dlRunning = true;

  let completed = 0;
  let cancelled = false;
  for (const file of selected) {
    // Checked before each file as well as inside the pipe, so a cancel that
    // lands between two files is obeyed without opening the next stream.
    if (session._cancelled) {
      cancelled = true;
      break;
    }
    let filePath = null;
    try {
      // peer-provided keys are untrusted. safePathWithin
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

      // stream from the drive into the file. Replaces the
      // `drive.get(key) → fs.writeFile(path, buf)` pair, which OOM'd on
      // media. The pipe completes successfully even for 0-byte entries
      // (hyperdrive's createReadStream pushes null with no data).
      await pipeDriveToFile(drive, file.key, filePath, session);

      // Authoritative size from disk: hyperdrive's block accounting can drift from
      // raw file bytes, the same drift that makes the 95% completion threshold necessary.
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
      // A second line of defence against a torn write, and it targets the PART path:
      // nothing is written at `filePath` until the rename, so a failure leaves it absent.
      if (filePath) {
        try {
          await fs.unlink(`${filePath}${PARTIAL_SUFFIX}`);
        } catch {
          // Expected: pipeDriveToFile already removed it. Not `swallowed()` —
          // logging a miss on every failed file would be noise describing
          // the normal case.
        }
      }

      // a cancellation is an instruction obeyed, not a file that
      // failed. It does not go in `failedFiles` (which the UI reports as
      // "N didn't make it"), it does not log at warn, and it stops the loop
      // rather than advancing to the next entry.
      const cancelCause =
        fileError instanceof TransferCancelledError || session._cancelled;
      if (cancelCause) {
        cancelled = true;
        binfo(
          "engine.download",
          `cancelled mid-file drive=${driveId} key=${JSON.stringify(file.key)} ` +
            `done=${downloadedFiles.length}/${selected.length}`,
        );
        break;
      }

      // carry a typed cause when we have one so RN
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

  // settle the manifest entry into INACTIVE so the drive
  // persists across restarts. The local file paths are saved on the entry
  // so the kebab can offer "Open in another app" later. Tear down the swarm
  // since the user's primary intent (grab the files) is satisfied; they can
  // explicitly re-activate via Share-it to seed again.
  binfo(
    "engine.download",
    `download loop ${cancelled ? "cancelled" : "done"} drive=${driveId} ` +
      `ok=${downloadedFiles.length} failed=${failedFiles.length} bytes=${bytesDownloaded}`,
  );

  // the teardown below is IDENTICAL for a cancelled run, and
  // deliberately so. Files that finished before the cancel are real files on
  // disk; dropping them from `localFiles` would strand them where nothing
  // can find them, and `reconcileReceived` reads exactly this list. The
  // storage is preserved (INACTIVE, not PURGED) because the user cancelled a
  // transfer, not a share. Only the terminal event and the return value
  // differ — see below.
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
    setDriveState(
      meta,
      DriveState.INACTIVE,
      cancelled ? "engineDownload: cancelled by user" : "engineDownload: download finished",
    );
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

  // Close the drive, then the store, then delete from `activeDrives`:
  // `hypercore-storage` opens with `lock: true`, so an abandoned store keeps the fd lock.
  if (session.drive) {
    try {
      await session.drive.close();
    } catch (e) {
      swallowed("engine.download", `drive.close ${driveId}`, e);
    }
  }
  if (session.store) {
    try {
      await session.store.close();
    } catch (e) {
      swallowed("engine.download", `store.close ${driveId}`, e);
    }
  }
  activeDrives.delete(driveId);
  emitEvent({ type: "drive-deactivated", driveId });

  // cleared LAST, after the session has left `activeDrives`.
  //
  // Held true for the whole teardown on purpose. A cancel arriving while the
  // manifest write or the swarm destroy is in flight then returns "already
  // unwinding" and emits nothing, instead of taking the deactivate branch
  // and tearing the same session down a second time. A download that got
  // this far genuinely finished, and its own terminal event is the truthful
  // one.
  session._dlRunning = false;

  const duration = Date.now() - start;

  // A cancelled download must never emit `upload-complete`. `transfer-cancelled` is a
  // separate event rather than a flag, so no handler can miss a field and read success.
  if (cancelled) {
    binfo(
      "engine.download",
      `download cancelled drive=${driveId} files=${downloadedFiles.length} ` +
        `failed=${failedFiles.length} bytes=${bytesDownloaded} duration=${duration}ms ` +
        `dest=${downloadRoot}`,
    );
    emitEvent({
      type: "transfer-cancelled",
      driveId,
      direction: "download",
      // What the user actually got to keep, so the UI can say so rather than
      // implying everything was thrown away.
      filesKept: downloadedFiles.length,
      totalBytes: bytesDownloaded,
      duration,
    });
    return {
      ok: true,
      cancelled: true,
      files: downloadedFiles,
      failed: failedFiles,
      totalBytes: bytesDownloaded,
      duration,
      destDir: downloadRoot,
    };
  }

  // A grab in which every file failed must not report success. `upload-complete` has
  // several producers, so this is its own event, with `partial` distinct from success.
  const outcome =
    downloadedFiles.length === 0
      ? "failed"
      : failedFiles.length > 0
        ? "partial"
        : "complete";
  binfo(
    "engine.download",
    `download ${outcome} drive=${driveId} files=${downloadedFiles.length} failed=${failedFiles.length} ` +
      `bytes=${bytesDownloaded} duration=${duration}ms dest=${downloadRoot}`,
  );
  emitEvent({
    type: "download-outcome",
    driveId,
    outcome,
    filesKept: downloadedFiles.length,
    filesFailed: failedFiles.length,
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
    // The field the RN side reads to report that shares could not be loaded and to
    // disable share creation. Always a boolean, so absent can only mean an old worklet.
    manifestUnavailable,
    // `maxTickGapMs` is monotonic and for a log line, NOT window-scoped and not to be
    // graded on; `tickGaps` is what the freeze grader reads. Copied on the way out.
    maxTickGapMs,
    tickGaps: tickGaps.slice(),
    // ADDED, alongside the fields above; nothing is
    // renamed, dropped or retuned. The grace the worklet is actually sweeping
    // on, read back rather than assumed — `0` means RN never handed one down and
    // no wake will ever be emitted, which is a configuration fact a log or a
    // test must be able to see rather than infer from an absence of events.
    idleHostGraceMs,
  };
}

export function engineListDrives() {
  // every drive in the manifest is reported (active + inactive),
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
      // (phase 2i), contract C-2: *"RN reads `reshared` and
      // the completeness predicate; it does not compute the boot rule."* It
      // cannot read what is not on the wire, and this projection is the only
      // place the manifest entry reaches RN. ADDED, never renaming or dropping
      // a field above it.
      //
      // Always a boolean, never absent: `undefined` at the RN end would mean
      // "this worklet predates the field", which is a different fact from "the
      // user has not re-shared this", and a Share control cannot tell them
      // apart. Same reasoning as `manifestUnavailable` on `engineStatus`.
      reshared: entry.reshared === true,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt || entry.createdAt,
    });
  }
  return drives;
}

// Bring an inactive manifest entry's drive online, REUSING an open session rather
// than reopening the store: a second `CORESTORE` open on one path fails on the lock.
export async function engineActivateDrive(driveId, opts) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  if (!driveId) {
    return failure("drive.invalid-arg", "drive-id-required", "driveId required");
  }

  const entry = manifest.drives?.[driveId];
  const existing = activeDrives.get(driveId);

  // The origin-derived default, from whichever source knows: a live session's
  // own flag, else the manifest entry. `serve === undefined` means the caller
  // expressed no preference and the default stands.
  const isReceiving = existing
    ? !!existing.isReceiving
    : (entry?.origin || "hosted") === "received";
  const requested = typeof opts?.serve === "boolean" ? opts.serve : !isReceiving;
  const requestedMode = requested ? "server" : "client";

  // `serve: true` is a REQUEST: a half-downloaded copy must not reach the DHT. The
  // refusal is honest rather than fatal — `ok` stays true and `mode` is what was set up.
  const serveRefused =
    isReceiving && requested && !receivedDriveIsComplete(entry) ? "incomplete" : null;
  const serve = serveRefused ? false : requested;
  if (serveRefused) {
    bwarn(
      "engine.state",
      `activate drive=${driveId} REFUSED the re-share reason=${serveRefused} ` +
        `localFiles=${Array.isArray(entry?.localFiles) ? entry.localFiles.length : 0}` +
        `/${Array.isArray(entry?.files) ? entry.files.length : 0} ` +
        `— a received copy announces only when it holds every file (D-06)`,
    );
  }

  /**
   * Persist the intent, so the boot rule has something to read. Only written for a
   * RECEIVED drive and only when the caller expressed a boolean: `serve` absent is
   * "no opinion" and must not clear an intent set on a previous launch. A refused
   * request writes `false`, since a stale `true` would re-announce a share that
   * has since lost files.
   */
  const persistReshared = (target) => {
    if (!target || !isReceiving) return false;
    if (typeof opts?.serve !== "boolean") return false;
    if (target.reshared === serve) return false;
    target.reshared = serve;
    return true;
  };

  // The reuse path, ordered BEFORE the `entry` checks on purpose: a live session is
  // proof the drive exists and its storage is open, stronger than a manifest lookup.
  if (existing) {
    const previousMode = currentSwarmMode(existing);

    // refresh the list off the manifest even on the reuse path.
    // A hydrated session carries whatever hydration put there, and the entry on
    // disk is the authority — this is what makes `engineDownload` able to
    // enumerate from the persisted key set rather than from what has replicated.
    if (entry) {
      const refs = toDriveFileRefs(entry.files);
      if (refs.length) existing.files = refs;
      if (entry.name !== undefined) existing.shareName = entry.name;
      existing.metadata = entry;
    }
    // delta 3: `bindHyperdriveDownloadTracking` had exactly one
    // call site, in `engineOpenDrive`. A grab on a session that arrived any
    // other way emitted no per-block progress at all — the transfer looked
    // frozen. Idempotent: the hook unbinds the previous listener first.
    ensureDownloadTracking(existing);

    // Compared against `requestedMode`, NOT the mode a refusal resolved to: answering
    // `already: true` for a mode the swarm is not in is exactly the dishonest reply.
    if (previousMode === requestedMode) {
      if (persistReshared(entry)) {
        try { await saveManifest(); } catch {}
      }
      binfo(
        "engine.state",
        `activate drive=${driveId} reused session, already mode=${previousMode} (no change)`,
      );
      return {
        ok: true,
        driveId,
        shareLink:
          existing.shareLink ||
          (existing.metadata?.key ? createShareLink(existing.metadata.key) : ""),
        key: existing.metadata?.key,
        mode: previousMode,
        previousMode,
        requestedMode,
        already: true,
        reusedSession: true,
        serveRefused,
      };
    }

    // Two routes: no swarm at all gets one attached, while a swarm in the wrong mode
    // goes through `PeerDiscoverySession.refresh`, the ONLY non-destructive way.
    existing.serve = serve;
    let mode = previousMode;
    try {
      if (!existing.swarm) {
        existing.swarm = attachHostSwarm(existing);
        mode = currentSwarmMode(existing);
      } else if (existing.discovery && !existing.discovery.destroyed) {
        await existing.discovery.refresh({ server: serve, client: true });
        existing.swarmMode = serve ? "server" : "client";
        mode = existing.swarmMode;
        binfo(
          "engine.swarm",
          `mode change drive=${driveId} ${previousMode}→${mode} via discovery.refresh ` +
            `(non-destructive; no leave, no unannounce)`,
        );
      } else {
        // A swarm with no usable discovery handle. Reported rather than papered
        // over: returning the mode we WANTED here would be the dishonest answer.
        bwarn(
          "engine.swarm",
          `mode change drive=${driveId} requested=${requestedMode} but the session has ` +
            `a swarm and no live discovery handle — mode stays ${previousMode}`,
        );
      }
    } catch (err) {
      bwarn(
        "engine.swarm",
        `mode change FAILED drive=${driveId} ${previousMode}→${requestedMode} — ${describeError(err)}`,
      );
      mode = currentSwarmMode(existing);
    }

    if (entry) {
      setDriveState(entry, DriveState.ACTIVE, "engineActivateDrive: session reused");
      entry.lastActivityAt = Date.now();
      // persisted BEFORE the save, so the intent and the state
      // reach disk in one write. Two writes would leave a window in which a
      // crash produced an ACTIVE received entry with no `reshared` — which
      // hydrates silent, i.e. the failure this round exists to remove.
      persistReshared(entry);
      try { await saveManifest(); } catch {}
    }

    const shareLink =
      existing.shareLink ||
      (existing.metadata?.key ? createShareLink(existing.metadata.key) : "");
    emitEvent({
      type: "drive-activated",
      driveId,
      shareLink,
      key: existing.metadata?.key,
    });
    return {
      ok: true,
      driveId,
      shareLink,
      key: existing.metadata?.key,
      mode,
      previousMode,
      requestedMode,
      // NEVER true for a mode the swarm is not in.
      already: false,
      reusedSession: true,
      serveRefused,
    };
  }

  if (!entry) {
    // Reached only for a driveId with no manifest entry, since the reuse branch runs
    // FIRST. `category`/`cause` are unchanged, because RN branches on `cause`.
    return failure(
      "drive.not-found",
      "drive-not-found",
      "This share is no longer on this device. Close and reopen PearDrop to reload your list.",
    );
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
      swarmMode: "none",
      // the explicit opt-in, read by `attachHostSwarm`. Always a
      // boolean by this point — `serve` was resolved against the origin-derived
      // default at the top of the function.
      serve,
      metadata: entry,
      totalBytes,
      isReceiving,
      shareLink: createShareLink(entry.key),
      // canonical, from the PERSISTED key set. `entry.files || []`
      // handed `engineDownload` the persisted shape under a field name it read
      // as the open shape, which is the size-lookup miss `toDriveFileRef`
      // documents.
      files: toDriveFileRefs(entry.files),
      shareName: entry.name,
    };
    const swarm = attachHostSwarm(session);
    session.swarm = swarm;

    activeDrives.set(driveId, session);
    // delta 3: live per-block progress on a grab that did not come
    // through `engineOpenDrive`. Without this the transfer shows no movement.
    ensureDownloadTracking(session);

    setDriveState(entry, DriveState.ACTIVE, "engineActivateDrive: swarm attached");
    entry.lastActivityAt = Date.now();
    // C-2, same single-write reasoning as the reuse path above.
    persistReshared(entry);
    try { await saveManifest(); } catch {}

    emitEvent({
      type: "drive-activated",
      driveId,
      shareLink: session.shareLink,
      key: entry.key,
    });

    const mode = currentSwarmMode(session);
    binfo(
      "engine.state",
      `activate drive=${driveId} opened storage=${entry.storagePath} mode=${mode} ` +
        `serve=${serve} reshared=${entry.reshared === true} files=${session.files.length}`,
    );
    return {
      ok: true,
      driveId,
      shareLink: session.shareLink,
      key: entry.key,
      mode,
      previousMode: "none",
      requestedMode,
      already: false,
      reusedSession: false,
      serveRefused,
    };
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

// tear down the swarm + drive session but keep storage and the
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

  // The engine guard: the teardown below closes the drive under a still-running
  // `engineDownload` loop, so the order is flag, abort, settle, destroy.
  if (session._dlRunning) {
    bwarn(
      "engine.state",
      `deactivate drive=${driveId} — DOWNLOAD IN FLIGHT. Stopping the loop and waiting for it ` +
        `to unwind before closing the drive (D-19 guard); the loop emits the terminal event.`,
    );
    session._cancelled = true;
    const abort = session._abortActivePipe;
    if (typeof abort === "function") {
      try {
        abort();
      } catch (e) {
        swallowed("engine.state", `abort active pipe ${driveId}`, e);
      }
    }
    await waitForDownloadLoopToSettle(session, driveId);
  }

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

/**
 * 64 hex chars, shaped like a real Hyperdrive key.
 *
 * It has to satisfy `extractKey`'s `/^peardrop:\/\/([a-fA-F0-9]{64})$/i` and
 * the hydrate filter's identical `{64}` test, because the whole point of the
 * simulation is that nothing downstream can tell this key apart from a real
 * one. Not cryptographic and does not need to be — it never signs anything
 * and never reaches the wire.
 */
function fakeShareKeyHex() {
  let out = "";
  while (out.length < 64) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, 64);
}

/**
 * Simulate a sustained DOWNLOAD. It writes a real `origin: "received"` manifest
 * entry, because a received row is keyed `share:<shareKey>` and bridged to the engine
 * `driveId` by an index — events alone would render on no row. No Corestore, no
 * swarm, no bytes. `engineHydrateDrives` skips `simulated: true` entries, never prunes.
 */
export function engineFakeDownloadTest(opts = {}) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }

  const durationMs = Math.max(4000, Number(opts.durationMs || 900000));
  const tickMs = Math.max(250, Number(opts.tickMs || 1000));
  const totalBytes = Math.max(1024, Number(opts.totalBytes || 256 * 1024 * 1024));
  const shareName = String(opts.shareName || "Simulated receive").slice(0, 120);
  const fileCount = Math.max(1, Math.min(50, Number(opts.fileCount || 1)));

  // `??` throughout below: every one of these clamps with `Math.max(0, …)`,
  // so zero is inside the range and carries meaning ("no hold", "no stall").
  // `|| <default>` would discard a deliberate zero. Same trap as
  // `earlyCompletePeers` in the upload simulation.
  const holdAtPercent = Math.max(0, Math.min(100, Number(opts.holdAtPercent ?? 0)));
  const stallAtMs = Math.max(0, Number(opts.stallAtMs ?? 0));
  const stallDurationMs = Math.max(0, Number(opts.stallDurationMs ?? 0));
  const peerDropAtMs = Math.max(0, Number(opts.peerDropAtMs ?? 0));

  const driveId = opts.__driveId ? String(opts.__driveId) : generateDriveId("fakedl");
  const shareKey = opts.__shareKey ? String(opts.__shareKey) : fakeShareKeyHex();
  const shareLink = createShareLink(shareKey);

  // Worklet-side, like the upload simulation's: RN's timers are frozen while
  // backgrounded, so an RN-side delay would only fire on return and would
  // test nothing.
  const startDelayMs = Math.max(0, Number(opts.startDelayMs ?? 0));
  if (startDelayMs > 0) {
    binfo(
      "engine.simulate",
      `scheduled fake-download drive=${driveId} key=${shareKey.slice(0, 12)}… in ${startDelayMs}ms ` +
        `(duration=${durationMs}ms bytes=${totalBytes} hold=${holdAtPercent}%)`,
    );
    const kickoff = setTimeout(() => {
      binfo("engine.simulate", `delay elapsed drive=${driveId} — starting fake download now`);
      engineFakeDownloadTest({
        ...opts,
        startDelayMs: 0,
        __driveId: driveId,
        __shareKey: shareKey,
      });
    }, startDelayMs);
    fakeSessions.set(driveId, {
      driveId,
      intervalId: null,
      timers: [kickoff],
      state: { completed: false },
      simulated: true,
    });
    return {
      ok: true,
      driveId,
      shareKey,
      shareLink,
      durationMs,
      tickMs,
      totalBytes,
      startDelayMs,
      files: buildFakeDownloadFiles(shareName, totalBytes, fileCount),
    };
  }

  const files = buildFakeDownloadFiles(shareName, totalBytes, fileCount);

  // The real receive-path mutation. This is what `engineListDrives()` reports
  // and therefore what lets RN's share-key index resolve progress to the row.
  const meta = {
    driveId,
    key: shareKey,
    shareLink,
    state: DriveState.ACTIVE,
    origin: "received",
    simulated: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ttlMs: 0,
    expiresAt: null,
    name: shareName,
    totalBytes,
    // the simulator writes the canonical pair too.
    // A simulated entry that carried only the legacy spellings would be the one
    // drive in the manifest that reads differently from every real one.
    files: files.map((f) => ({
      name: f.name,
      storagePath: f.name,
      size: f.size,
      key: `/${normalizeKey(f.name)}`,
      displayName: f.name,
    })),
    localFiles: [],
    storagePath: null,
  };
  manifest.drives[driveId] = meta;
  try {
    saveManifest();
  } catch {
    /* best-effort, same as every other caller */
  }

  binfo(
    "engine.simulate",
    `fake-download start drive=${driveId} key=${shareKey.slice(0, 12)}… ` +
      `bytes=${totalBytes} files=${files.length} duration=${durationMs}ms tick=${tickMs}ms ` +
      `hold=${holdAtPercent}% stallAt=${stallAtMs}ms stallFor=${stallDurationMs}ms drop=${peerDropAtMs}ms`,
  );

  const peerId = String(opts.peerPrefix || "sim-sender").trim().toLowerCase();
  const timers = [];
  const startAt = Date.now();
  const fakeState = { completed: false };
  let transferred = 0;
  let paused = false;

  // A real receive has the sender attached as a peer, and the RN stall
  // watchdog reads `peersConnected`. Emitting it keeps the simulated
  // transfer's shape identical to a real one.
  emitEvent({ type: "peer-connected", driveId, peerId, totalBytes });

  const emitProgress = () => {
    const percent = Math.max(0, Math.min(100, Math.round((transferred / totalBytes) * 100)));
    emitEvent({
      type: "upload-progress",
      driveId,
      percent,
      bytesTransferred: Math.round(transferred),
      totalBytes,
    });
  };
  emitProgress();

  const finish = () => {
    if (fakeState.completed) return;
    fakeState.completed = true;
    for (const timer of timers) {
      try { clearInterval(timer); } catch {}
      try { clearTimeout(timer); } catch {}
    }
    fakeSessions.delete(driveId);
    const live = manifest.drives[driveId];
    if (live) {
      setDriveState(live, DriveState.INACTIVE, "engineFakeDownloadTest: simulation finished");
      live.lastActivityAt = Date.now();
      try { saveManifest(); } catch {}
    }
    binfo(
      "engine.simulate",
      `fake-download complete drive=${driveId} bytes=${Math.round(transferred)} ` +
        `elapsed=${Date.now() - startAt}ms`,
    );
    // Same order as the real `engineDownload` teardown: deactivated first,
    // then the completion event RN turns into `Saved` + the toast.
    emitEvent({ type: "drive-deactivated", driveId });
    // A RECEIVE-path producer, so it emits `download-outcome` and not
    // `upload-complete`; a simulation that ran to the end delivered everything.
    emitEvent({
      type: "download-outcome",
      driveId,
      outcome: "complete",
      filesKept: files.length,
      filesFailed: 0,
      totalBytes: Math.round(transferred),
      duration: Date.now() - startAt,
    });
  };

  // Mid-download stall. Stops emitting entirely — silence is the point,
  // because RN's watchdog flips `stalled` on 30 s without events, and a
  // stalled download must stop holding the foreground service.
  if (stallAtMs > 0) {
    timers.push(
      setTimeout(() => {
        if (fakeState.completed) return;
        paused = true;
        binfo("engine.simulate", `fake-download STALL begins drive=${driveId} at=${Date.now() - startAt}ms`);
        emitEvent({ type: "peer-disconnected", driveId, peerId });
        emitEvent({ type: "download-peer-disconnected", driveId });
        if (stallDurationMs > 0) {
          timers.push(
            setTimeout(() => {
              if (fakeState.completed) return;
              paused = false;
              binfo("engine.simulate", `fake-download STALL ends drive=${driveId} — resuming`);
              emitEvent({ type: "peer-connected", driveId, peerId, totalBytes });
              emitProgress();
            }, stallDurationMs),
          );
        }
      }, stallAtMs),
    );
  }

  // Sender vanishes without a stall window — the transfer keeps its bytes
  // but never completes.
  if (peerDropAtMs > 0) {
    timers.push(
      setTimeout(() => {
        if (fakeState.completed) return;
        paused = true;
        binfo("engine.simulate", `fake-download peer drop drive=${driveId}`);
        emitEvent({ type: "peer-disconnected", driveId, peerId });
        emitEvent({ type: "download-peer-disconnected", driveId });
      }, peerDropAtMs),
    );
  }

  const bytesPerMs = totalBytes / durationMs;
  const intervalId = setInterval(() => {
    if (fakeState.completed) return;
    if (paused) return;

    // The ceiling. `holdAtPercent` 0 means "no hold" and lets it run to 100.
    const ceiling =
      holdAtPercent > 0 ? totalBytes * (holdAtPercent / 100) : totalBytes;
    transferred = Math.min(ceiling, transferred + bytesPerMs * tickMs);
    emitProgress();

    if (transferred >= ceiling) {
      if (holdAtPercent > 0) {
        // Held. Keep ticking so `lastEventAt` stays fresh and the stall
        // watchdog does NOT fire — the row must read `Finishing…`
        // indefinitely, which is the state a stuck-at-100 download is in.
        // If this stopped emitting, it would become a stall instead and
        // prove the opposite of what it is for.
        return;
      }
      finish();
    }
  }, tickMs);
  timers.push(intervalId);
  fakeSessions.set(driveId, {
    driveId,
    intervalId,
    timers,
    state: fakeState,
    simulated: true,
  });

  return {
    ok: true,
    driveId,
    shareKey,
    shareLink,
    durationMs,
    tickMs,
    totalBytes,
    holdAtPercent,
    files,
  };
}

/** File list for a simulated share — shaped like `engineOpenDrive`'s. */
function buildFakeDownloadFiles(shareName, totalBytes, fileCount) {
  const per = Math.max(1, Math.floor(totalBytes / fileCount));
  return Array.from({ length: fileCount }, (_, i) => ({
    name: fileCount === 1 ? `${shareName}.bin` : `${shareName}-${i + 1}.bin`,
    size: i === fileCount - 1 ? totalBytes - per * (fileCount - 1) : per,
  }));
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

  // Delayed start, so the app can be backgrounded before the completion lands. The
  // timer is worklet-side because RN's `setInterval` is frozen while backgrounded.
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
  // The simulator's copy of the durable delivery record, so a fix to the real path is
  // not undone here. `earlyCompletePeers` is `?? 1`, never `|| 1`, and is NOT consulted.
  const deliveredPeers = new Set();
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
    // same gate as the real `emitUploadProgressSnapshot`,
    // for the same reason. The `: 100` stays — it is the honest percent once a
    // simulated peer has actually reached `fileBytes`.
    if (activeTotal === 0 && deliveredPeers.size === 0) return;
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
    // read BEFORE the delete, same as the real path — and
    // carried on the event, so RN's finalize sees the same discriminator from
    // the simulator that it sees from a real host.
    if ((peerProgress.get(peerId) || 0) >= fileBytes) deliveredPeers.add(peerId);
    connectedPeers.delete(peerId);
    peerProgress.delete(peerId);
    emitEvent({
      type: "peer-disconnected",
      driveId,
      peerId,
      delivered: deliveredPeers.size > 0,
      deliveredPeers: deliveredPeers.size,
    });
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
