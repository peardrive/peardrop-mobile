import fs from "bare-fs/promises";
import { createReadStream, createWriteStream } from "bare-fs";
import path from "bare-path";

import b4a from "b4a";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import HyperDHT from "hyperdht";
import hypercoreCrypto from "hypercore-crypto";

import {
  loadManifest as readManifestFromDisk,
  isManifestUnavailable,
} from "./manifest-recovery.mjs";
import { atomicWriteJson } from "./atomic-save.mjs";
import { safePathWithin, PathTraversalError } from "./path-safe.mjs";
import {
  pickDriveToReuse,
  selectRemovableOrphans,
  summarizeOrphans,
} from "./drive-reuse.mjs";
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

// Must sit BELOW RN's 30 s (`resolveGuard.ts`), or RN abandons the resolve while this function
// still holds the swarm, store, drive and folder. MOVE EITHER NUMBER AND YOU MUST MOVE THE OTHER.
const RESOLVE_WAIT_MS = 25000;

// How often the receiver re-queries the DHT inside that budget while no peer has answered: the
// initial `swarm.flush()` lookup happens once, before a late host exists.
const RESOLVE_REQUERY_MS = 3000;

// How often the manifest blob is re-probed inside that budget. `drive.update` resolving means HEAD
// METADATA arrived, never that a blob replicated, so the manifest can lag the head.
const MANIFEST_POLL_MS = 500;

// Per-file stall watchdog on receive: a peer dropping mid-file leaves hyperdrive's read stream
// waiting forever, so the file fails after this and the loop moves on to the next.
const STALL_TIMEOUT_MS = 60000;

/**
 * Silence that counts as a stall, measured from BYTE PROGRESS rather than socket events: the wire's
 * only liveness signal is a 5 s keepalive and a dead socket reads connected until UDX gives up at ~18 s.
 */
const DOWNLOAD_SILENCE_MS = 8000;

/** How often the silence watchdog looks. Fine enough to report an 8 s stall
 *  within a second of it becoming true. */
const SILENCE_TICK_MS = 1000;

// Receive files are piped to `<dest><PARTIAL_SUFFIX>` and renamed onto `<dest>` only after a clean
// close. Deliberately NOT a resume marker — hyperdrive re-reads from block zero. It is a tombstone.
const PARTIAL_SUFFIX = ".peardrop-part";

const DriveState = {
  CREATING: "creating",
  ACTIVE: "active",
  SEEDING: "seeding",
  // In-flight receiver-open. Persisted so the corestore folder is cleaned
  // up on next boot if the open didn't complete.
  SEEKING: "seeking",
  // Data preserved locally, NOT announcing. Both hosted and received drives land here; Activate
  // returns them to ACTIVE, and Delete with purge is the only destructive path.
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
 * Every drive-state transition goes through here. `why` carries the trigger, because the
 * transition alone rarely explains itself.
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

// Transient hydrate failures are tracked in memory, never persisted: a briefly unreadable corestore
// folder used to write `state: "failed"` to disk and demote the drive on every later boot.
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

// True when the manifest file exists but could not be read, so `manifest` is an empty PLACEHOLDER.
// Set only by `loadManifest()`, so there is one definition and the engine never re-derives it.
let manifestUnavailable = false;

// The ruling's user-facing sentence, in one place. Deliberately not a raw engine or native error
// string, and it says nothing about networks or expiry.
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
  // The load path is non-destructive: it does not read the drives folder and does not prune
  // entries. Per-drive missing storage is handled at hydrate time.
  try {
    manifest = await readManifestFromDisk(manifestPath);
    // Read the unavailable flag from the loader, the only thing that knows whether the file was
    // readable. A load that succeeds clears it, so this is an assignment, not an |=.
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
  // In-flight cleanup. An engine concern rather than a recovery one because it touches
  // drive-level state and must save the trimmed manifest through the engine's own save chain.
  try {
    await cleanupInFlightManifestEntries();
  } catch (err) {
    console.error("[engine] cleanup in-flight", err);
    berror("engine.boot", `cleanup in-flight failed — ${describeError(err)}`);
  }
}

// Drop any entry stuck in CREATING or SEEKING from a crash mid-operation and rm its corestore
// folder where known. Called once from `loadManifest` during engineInit; not exposed.
async function cleanupInFlightManifestEntries() {
  const stale = new Set([DriveState.CREATING, DriveState.SEEKING]);
  const toRemove = [];
  for (const [driveId, meta] of Object.entries(manifest.drives || {})) {
    if (stale.has(meta?.state)) toRemove.push([driveId, meta]);
  }
  if (toRemove.length === 0) return;
  // This path DELETES user-visible drives and their corestore folders at boot, and it was
  // entirely silent. Log each removal individually.
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

// Serialize saves through a chain so a burst of state transitions cannot interleave temp-file
// writes. The `.catch(() => {})` isolates the next save, so the chain is never permanently rejected.
let _saveChain = Promise.resolve();

function saveManifest() {
  // Refuse rather than throw: several callers are bare `await`s on the boot and share paths, where
  // throwing turns a survivable condition into a boot crash. The explicit state carries it instead.
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
  // A detached observer: the returned promise is unchanged and no caller's control flow moves.
  // Almost every caller wraps this in `try { … } catch {}`, so each was its own blind spot.
  next.catch((err) => {
    berror("engine.manifest", `saveManifest failed — ${describeError(err)}`);
  });
  _saveChain = next;
  return next;
}

/**
 * Liveness counter, and the only thing that can tell "backgrounded" from "frozen": this timer runs
 * in the worklet, which keeps executing while backgrounded and stops dead when the OS freezes it.
 */
const ALIVE_TICK_MS = 30000;
let aliveTicks = 0;
let aliveTimer = null;

/**
 * The worklet measures its own largest inter-tick gap, ungated — the RN-side producer needs a debug
 * heartbeat a release APK never sets. Each gap is stamped with the `aliveTicks` that closed it.
 */
const NOTABLE_TICK_GAP_MS = ALIVE_TICK_MS * 2;
const TICK_GAP_HISTORY_MAX = 32;
let lastAliveTickAt = 0;
let maxTickGapMs = 0;
const tickGaps = [];

/**
 * The grace window expires HERE, not in RN, whose timers do not run while backgrounded — the one
 * state the window spans. The duration comes down from RN; absent, the sweep stays off.
 */
let idleHostGraceMs = 0;

function configureIdleHostGrace(ms) {
  const next = Number(ms);
  // `> 0` rather than `!== undefined`: it covers NaN, null and a negative, and does it where the
  // value ENTERS rather than where it is compared.
  idleHostGraceMs = Number.isFinite(next) && next > 0 ? next : 0;
}

/**
 * One pass over the hosted drives, on the alive ticker's cadence. At most one event per idle
 * period per drive, so a drive that sits idle forever costs one event rather than one per tick.
 */
function sweepIdleHostGrace(now) {
  if (!(idleHostGraceMs > 0)) return;
  for (const tracker of uploadTrackers.values()) {
    if (!tracker || tracker.idleGraceEmitted) continue;
    // A connected peer is the strongest evidence the share is still in use, checked first for the
    // same reason `classifyTransfer` checks it before `completed`.
    if (tracker.peers.size > 0) continue;
    // Null means no departure was ever observed, so there is nothing to expire — the predicate
    // agrees, returning null for a null stamp rather than "idle-host-grace".
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

/**
 * The waiting loop's cadence while the app is backgrounded, where RN's own timers do not run.
 * A wake, never a verdict: which rows are due is RN's to decide, and only RN can read the rows.
 */
function emitWaitingTick(now) {
  emitEvent({ type: "waiting-tick", tick: aliveTicks, at: now });
}

function startAliveTicker() {
  if (aliveTimer) return;
  // Seeded here rather than on the first tick: a freeze beginning one second after `engineInit`
  // must widen the first measured gap, not vanish for want of something to subtract from.
  lastAliveTickAt = Date.now();
  aliveTimer = setInterval(() => {
    const now = Date.now();
    const gapMs = now - lastAliveTickAt;
    lastAliveTickAt = now;
    aliveTicks++;
    // Placed ABOVE the gap guard, which early-returns on a backwards clock step. A moved clock is
    // a reason to distrust a gap measurement, not to stop asking whether a share has been idle.
    sweepIdleHostGrace(now);
    emitWaitingTick(now);
    // Covers a backwards clock step and NaN both, and does it here rather than at the point of
    // interpretation: a threshold comparison used as a validity check admits NaN.
    if (!(gapMs > 0)) return;
    if (gapMs > maxTickGapMs) maxTickGapMs = gapMs;
    if (gapMs >= NOTABLE_TICK_GAP_MS) {
      // `aliveTicks` is already incremented, so `tick` is the tick that CLOSED
      // the gap. RN keeps entries with `tick > ticksAtBackground`.
      tickGaps.push({ tick: aliveTicks, gapMs });
      if (tickGaps.length > TICK_GAP_HISTORY_MAX) tickGaps.shift();
    }
  }, ALIVE_TICK_MS);
}

/**
 * `options.idleHostGraceMs` is RN's own value plus its wake pad, handed down so the worklet expires
 * the window. Absent, the sweep stays off — `configureIdleHostGrace` says why there is no default.
 */
export async function engineInit(documentRoot, options) {
  // First statement, and synchronous: it must not sit between `initialized = true` and
  // `startAliveTicker()`, which have to be adjacent with no await between them.
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

  // Do not await: `engineInit` must return promptly so RN can flip to listening and accept input.
  // `drive-hydrated` events stream out as each drive comes online.
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
    // The DURABLE record of delivery, outliving the peer entry. It is the only thing separating
    // "empty because everyone finished" from "empty because everyone left".
    deliveredPeers: new Set(),
    // Coalescing state for the
    // upload-event-driven snapshot. See emitUploadProgressCoalesced.
    lastUploadEmitAt: 0,
    pendingUploadEmit: null,
    // When the peer count last fell to zero, by THIS realm's clock. Null rather than 0: a tracker
    // that never had a peer has not had one leave, and the sweep must not read never as long ago.
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

  // The `: 100` below is NOT deleted and must not be — it is the genuine completion percent on the
  // happy path. What was missing is `deliveredPeers`, the discriminator between the two empty sets.
  const deliveredCount = tracker.deliveredPeers ? tracker.deliveredPeers.size : 0;
  if (activeTotal === 0 && deliveredCount === 0) {
    bdebug(
      "engine.upload",
      `snapshot suppressed drive=${tracker.driveId} — active set empty and no peer has ever ` +
        `finished (peers=${tracker.peers.size} delivered=0 totalSentBytes=${Math.round(tracker.totalSentBytes)}). ` +
        `Emitting percent=100 here is the bug.`,
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
 * Coalesced to 10 Hz with a trailing edge so the last event is never lost. The 1 Hz timer in
 * `startUploadTrackerTimer` is NOT touched — `lastEventAt` feeds the RN stall watchdog.
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

// Hooks the blobs core's `upload` event and attributes bytes to peers by remotePublicKey; UDX
// sockets expose no Node-net `bytesWritten`, so the old sampler reported percent=0 forever.
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

    // 95%, because Hyperdrive's block accounting does not sum exactly to raw totalBytes. The
    // receiver's own `engineDownload` does accurate per-byte progress.
    if (!peer.completed && peer.sentBytes >= tracker.driveSize * 0.95) {
      peer.completed = true;
      // The durable half of the same fact: `peer.completed` dies with the peer entry, this does
      // not. Recorded on the SAME line as the flag so the two cannot diverge.
      if (tracker.deliveredPeers) tracker.deliveredPeers.add(peerId);
      // The 95% threshold stands in for an exact byte match, because block accounting does not sum
      // to raw totalBytes. Record the numbers behind a completion declared on an approximation.
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

    // Coalesced to 10 Hz. Was one emit — and therefore one exported
    // log line — per replicated block.
    emitUploadProgressCoalesced(tracker);
  };

  // Hook both blobs (file content) and db (metadata) cores: blobs is the big one, db is small but
  // completes first and confirms a peer is actively pulling.
  drive.ready().then(() => {
    try {
      drive.getBlobs().then((blobs) => {
        if (!blobs) {
          // The ONE condition under which the db-core listener below is never unhooked, because
          // `_unhookUpload` is assigned inside this `then`. Reported, not fixed.
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

/**
 * What arrived AFTER a cancel, per drive, outliving the session — without it the event
 * suppression would be unfalsifiable. Keyed by driveId and never pruned, because so is the question.
 */
const cancelledSessionActivity = new Map();

/** 64 KiB — hyperdrive's blob chunk size, and the observed late-block delta. */
const BLOCK_SIZE_HINT = 65536;

function lateRecordFor(driveId) {
  let rec = cancelledSessionActivity.get(driveId);
  if (!rec) {
    rec = {
      inflightAtCancel: null,
      lateBlocks: 0,
      lateBytes: 0,
      firstLateAt: null,
      lastLateAt: null,
    };
    cancelledSessionActivity.set(driveId, rec);
  }
  return rec;
}

function recordLateBlock(driveId, bytes) {
  const rec = lateRecordFor(driveId);
  const now = Date.now();
  rec.lateBlocks++;
  rec.lateBytes += Number(bytes || 0);
  if (rec.firstLateAt === null) rec.firstLateAt = now;
  rec.lastLateAt = now;
}

/**
 * Occupancy and CAPACITY — only the second bounds what may arrive after a cancel. Hypercore-private,
 * so the answer is `null` and never 0, and the blobs core is mandatory: file blocks live there.
 */
function inflightBlocksOf(session) {
  try {
    const core = session?._dlBlobsCore;
    const rep = core?.replicator;
    const active = rep?._inflight?._active;
    if (typeof active !== "number" || !Number.isFinite(active)) return null;
    let capacity = null;
    for (const peer of rep?.peers ?? []) {
      const max = peer?.getMaxInflight?.();
      if (typeof max !== "number" || !Number.isFinite(max)) continue;
      capacity = (capacity ?? 0) + max;
    }
    return { active, capacity };
  } catch {
    /* a closing core answers nothing; `null` is the honest reading */
    return null;
  }
}

// The receive-side mirror of `bindHyperdriveUploadTracking`, so a single big file reports progress
// as it streams. The per-file emit stays as a reconciliation snap at each file boundary.
function bindHyperdriveDownloadTracking(session) {
  const { drive, driveId } = session;
  if (!drive) return () => {};

  // Bytes accumulate on the session object so `engineDownload` can write to it too, and so the
  // tracker survives across multiple `drive.get` calls.
  session._dlBytes = 0;

  // Only blocks a peer sent, and each index only once: `download` also fires for blocks served
  // from this receiver's own Corestore, so the unfiltered sum over-reported badly.
  session._dlPeerBytes = 0;
  session._dlSeenBlocks = new Set();

  /**
   * The active key, the bytes written for THAT key, and that key's own size — the honest per-file
   * source. `bytesFromPeers` cannot stand in: it spans every file the attempt touched.
   */
  session._dlActiveKey = null;
  session._dlActiveBytes = 0;
  session._dlActiveTotal = 0;

  // Throttle: `download` fires per block, and one event each would flood RN. Coalesce to ~10 Hz.
  const MIN_EMIT_INTERVAL_MS = 100;
  let lastEmitAt = 0;
  let pendingEmit = null;

  // Denominator order: this download call's selected-file total, else the whole-drive total, else
  // null — `bytesTransferred` is still emitted so the UI can show byte counts.
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
    // Second of two cancelled-session checks: a `pendingEmit` scheduled before the cancel fires up
    // to 100 ms after it, so gating only the listener below would still let one event out.
    if (session._cancelled === true) return;
    const total = totalBytesOf();
    // Clamped at the denominator, so neither the bar nor the byte figure can
    // claim more than the file holds.
    const transferred =
      total != null ? Math.min(session._dlBytes, total) : session._dlBytes;
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
      bytesFromPeers: session._dlPeerBytes,
      activeKey: session._dlActiveKey ?? null,
      activeBytes: session._dlActiveBytes || 0,
      activeTotal: session._dlActiveTotal || 0,
    });
  };

  // One listener per core, because the blobs core and the db core index their
  // blocks independently and a shared index would collide between them.
  const makeOnDownload = (tag) => (index, bytes, from) => {
    if (!from) return;
    const delta = Number(bytes || 0);
    if (delta <= 0) return;
    const key = `${tag}:${index}`;
    if (session._dlSeenBlocks.has(key)) return;
    session._dlSeenBlocks.add(key);
    session._dlBytes += delta;
    session._dlPeerBytes += delta;

    /**
     * A block already on the wire when the cancel arrived still lands and is still counted; what
     * must never be seen is PROGRESS AFTER STOPPED, so the EVENT is what stops, not the bytes.
     */
    if (session._cancelled === true) {
      recordLateBlock(driveId, delta);
      return;
    }

    const now = Date.now();
    if (now - lastEmitAt >= MIN_EMIT_INTERVAL_MS) {
      emitProgress();
    } else if (!pendingEmit) {
      pendingEmit = setTimeout(emitProgress, MIN_EMIT_INTERVAL_MS);
    }
  };
  const onBlobDownload = makeOnDownload("blob");
  const onDbDownload = makeOnDownload("db");

  drive.ready().then(() => {
    try {
      drive.getBlobs().then((blobs) => {
        if (!blobs) {
          // Receive-side mirror of the upload branch above: `_unhookDownload` is never assigned,
          // so the db-core listener and the coalescing timeout are both left behind.
          bwarn(
            "engine.download",
            `getBlobs resolved falsy drive=${driveId} — download listener on db core will NOT be unhooked`,
          );
          return;
        }
        // Stashed so `inflightBlocksOf` can read the replicator without
        // re-awaiting `getBlobs()` from a synchronous diagnose.
        session._dlBlobsCore = blobs.core;
        blobs.core.on("download", onBlobDownload);
        session._unhookDownload = () => {
          if (pendingEmit) { clearTimeout(pendingEmit); pendingEmit = null; }
          try { blobs.core.off("download", onBlobDownload); } catch {}
          try { drive.db?.core?.off?.("download", onDbDownload); } catch {}
        };
      }).catch(() => {});
      drive.db?.core?.on?.("download", onDbDownload);
    } catch {}
  }).catch(() => {});

  return () => {
    if (typeof session._unhookDownload === "function") {
      try { session._unhookDownload(); } catch {}
    }
  };
}

// Coarse "still alive" tick, keeping tracker totals fresh when the upload burst lands between
// snapshots. It no longer reads bytesWritten — it just emits the current snapshot.
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
  // The coalescing timeout otherwise outlives the tracker and emits one snapshot for a drive that
  // is already gone. Same teardown the download mirror does.
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

// The canonical file shape, `{ key, displayName, size }`: `key` addresses the drive and keeps its
// leading `/`. MIRRORED in `src/state/types.ts` as `DriveFileRef` — the two must move together.
function toDriveFileRef(f) {
  if (!f || typeof f !== "object") return null;

  // Resolution order is load-bearing: `key`, then `storagePath` which is only ever a key, then
  // `name` — on the persisted shape `name` is the DISPLAY name, and `storagePath` settles which.
  const rawKey = f.key ?? f.storagePath ?? f.name ?? "";
  const stripped = normalizeKey(rawKey);
  if (!stripped) return null;
  const key = `/${stripped}`;

  // Display name, in order of trustworthiness: an explicit `displayName`; the persisted shape's
  // `name`, proven by `storagePath` beside it; otherwise the key's basename.
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
 * The canonical shape written to `manifest.drives[id].files`. Carries `key`/`displayName` plus the
 * two legacy spellings RN still reads, so RN can adopt `DriveFileRef` in a separate change.
 */
function driveFileRecord(ref) {
  return {
    key: ref.key,
    displayName: ref.displayName,
    size: ref.size,
    // Legacy: the persisted spelling. `name` is the DISPLAY name here.
    name: ref.displayName,
    storagePath: normalizeKey(ref.key),
  };
}

function localHeldNameKey(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${stem.replace(/ \(\d+\)$/, "")}${ext}`;
}

/**
 * Does this entry hold EVERY file its manifest lists? Deliberately the stricter half of
 * `receivedHoldings.ts`: a false positive seeds a copy that cannot serve what it advertises.
 */
function receivedDriveIsComplete(entry) {
  const files = Array.isArray(entry?.files) ? entry.files : [];
  if (files.length === 0) return false;

  const held = new Map();
  for (const lf of Array.isArray(entry?.localFiles) ? entry.localFiles : []) {
    // `path` is required, not just `name`: a record without a path is not a file anything can
    // read, let alone serve. `describeHoldings` requires both for the same reason.
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
 * May this RECEIVED session announce? Three independent conditions, all required: `session.serve
 * === true`, a persisted `entry.reshared === true`, and every file held. `undefined` is not `true`.
 */
function receivedDriveMayServe(session) {
  if (!session || !session.isReceiving) return false;
  if (session.serve !== true) return false;
  const entry = manifest?.drives?.[session.driveId];
  if (!entry || entry.reshared !== true) return false;
  return receivedDriveIsComplete(entry);
}

/**
 * What this session's swarm is ACTUALLY doing, read from the flag the join site wrote rather than
 * re-derived: two derivations of one fact produced `already: true` for a drive with no swarm.
 */
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
 * The single entry point for receive-side progress tracking, and idempotent because it must be:
 * a second bind before `getBlobs()` resolves would double-count every block and rewind the total.
 */
function ensureDownloadTracking(session) {
  if (!session || !session.drive) return;
  if (session._dlTrackingBound) return;
  session._dlTrackingBound = true;
  bindHyperdriveDownloadTracking(session);
}

// Every host swarm's DHT node watches the interfaces, so one change arrives once per swarm.
const NETWORK_CHANGE_COALESCE_MS = 1000;
let lastNetworkChangeAt = 0;

function noteNetworkChange() {
  const now = Date.now();
  if (now - lastNetworkChangeAt < NETWORK_CHANGE_COALESCE_MS) return;
  lastNetworkChangeAt = now;
  binfo("engine.swarm", `interface change seen at=${now}`);
  emitEvent({ type: "network-changed", at: now });
}

const SWARM_KEYPAIR_FILE = "swarm-keypair.json";

function isSwarmKeyPair(kp) {
  return (
    kp.publicKey.byteLength === 32 &&
    kp.secretKey.byteLength === 64 &&
    b4a.equals(kp.secretKey.subarray(32), kp.publicKey)
  );
}

// One keypair per drive, inside the drive's folder so every purge removes it with the storage.
// A stable host identity overwrites its own DHT record on restart instead of adding a dead one.
async function swarmKeyPairFor(driveId, storagePath) {
  if (!storagePath) return null;
  const file = path.join(storagePath, SWARM_KEYPAIR_FILE);
  try {
    const raw = JSON.parse(b4a.toString(await fs.readFile(file), "utf8"));
    const kp = {
      publicKey: b4a.from(String(raw?.publicKey ?? ""), "hex"),
      secretKey: b4a.from(String(raw?.secretKey ?? ""), "hex"),
    };
    if (isSwarmKeyPair(kp)) {
      binfo(
        "engine.swarm",
        `swarm keypair loaded drive=${driveId} pub=${b4a.toString(kp.publicKey, "hex").slice(0, 12)}`,
      );
      return kp;
    }
    bwarn("engine.swarm", `swarm keypair invalid, replacing drive=${driveId} path=${file}`);
  } catch (err) {
    // Path only: a parse error message can quote the file's contents.
    if (err?.code !== "ENOENT") {
      bwarn("engine.swarm", `swarm keypair unreadable, replacing drive=${driveId} path=${file}`);
    }
  }
  const kp = HyperDHT.keyPair();
  try {
    await atomicWriteJson(file, {
      publicKey: b4a.toString(kp.publicKey, "hex"),
      secretKey: b4a.toString(kp.secretKey, "hex"),
    });
  } catch {
    bwarn("engine.swarm", `swarm keypair not saved drive=${driveId} path=${file}; hosting with it anyway`);
  }
  binfo(
    "engine.swarm",
    `swarm keypair created drive=${driveId} pub=${b4a.toString(kp.publicKey, "hex").slice(0, 12)}`,
  );
  return kp;
}

// Attach a fresh Hyperswarm session to a hosted or rehydrated drive, hooking the same upload and
// peer lifecycle `engineShareFromPaths` installs so the two behave identically.
function attachHostSwarm(session, keyPair) {
  const { driveId, drive, store, totalBytes } = session;
  const swarm = new Hyperswarm(keyPair ? { keyPair } : {});
  swarm.dht.on("network-change", noteNetworkChange);

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
    // A peer is attached, so there is no idle period to expire. Cleared on the RISING edge
    // unconditionally — a second peer arriving writes values that are already correct.
    tracker.lastPeerLeftAt = null;
    tracker.idleGraceEmitted = false;
    // Peer lines carry driveId, peerId and the live peer count: "Peer connected" alone never said
    // which drive, or how many were already attached.
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
        // No tracker means no record either way, so the honest answer is "not delivered" — RN's
        // finalize gates on `=== true` and fails closed rather than on a missing field.
        emitEvent({ type: "peer-disconnected", driveId, peerId, delivered: false, deliveredPeers: 0 });
        binfo(
          "engine.peer",
          `host peer-disconnected drive=${driveId} peer=${peerId} (tracker already gone)`,
        );
        return;
      }
      const peer = liveTracker.peers.get(peerId);
      liveTracker.peers.delete(peerId);
      // Stamp only on the FALLING edge to zero, the same rule the RN handler uses. Read AFTER the
      // delete, so `size === 0` means this peer was the last one.
      if (liveTracker.peers.size === 0) {
        liveTracker.lastPeerLeftAt = Date.now();
        liveTracker.idleGraceEmitted = false;
      }
      // Read after the delete: `deliveredPeers` is the record that survives it. "Delivered" means
      // at least one peer FINISHED, never "the active set is empty" — that was the false-100% bug.
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
  // Join options are ALWAYS explicit at both sites: `server` announces, `client` looks peers up.
  // `session.serve === undefined` is not `false` — it means no preference, so the origin default wins.
  const announce =
    typeof session.serve === "boolean" ? session.serve : !session.isReceiving;
  binfo(
    "engine.swarm",
    `join drive=${driveId} server=${announce} client=true ` +
      `serveOptIn=${typeof session.serve === "boolean" ? String(session.serve) : "default"} ` +
      `(${announce ? "announcing discoveryKey" : "client-only: does not advertise"})`,
  );
  session.discovery = swarm.join(drive.discoveryKey, { server: announce, client: true });
  // Record what was actually set up, written HERE at the join. Deriving the mode at read time
  // from `isReceiving` is how `already: true` came to describe a swarm that did not exist.
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

// Reopen the corestore, recreate the Hyperdrive from the recorded key and re-attach a swarm — the
// re-attach is HOSTED-ONLY. Sequential, and a single drive's failure is non-fatal and retried.
function recordHydrateFailure(driveId, message, detail) {
  resumeErrors.set(driveId, { error: message, at: Date.now() });
  // Give the trace the typed shape the rest of the taxonomy uses; a bare message string with no
  // category or cause was logged nowhere.
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

// The removal switch, and it is off. Boot logs what a pass WOULD delete and deletes nothing.
const ORPHAN_REMOVAL_ENABLED = false;

/** The three probes `selectRemovableOrphans` cannot answer for itself. `withinDrivesDir` resolves
 *  and prefix-checks, the test `safePathWithin` makes, never a join. */
function orphanProbes() {
  return {
    hasSession: (driveId) => activeDrives.has(driveId),
    downloadRunning: (driveId) => activeDrives.get(driveId)?._dlRunning === true,
    withinDrivesDir: (candidate) => {
      if (!drivesDir || typeof candidate !== "string" || candidate.length === 0) return false;
      const root = path.resolve(drivesDir);
      const target = path.resolve(candidate.replace(/\0/g, ""));
      return target !== root && target.startsWith(root + path.sep);
    },
  };
}

/** Folder bytes for every entry that names a storage path. */
async function orphanSizeMap(drives) {
  const sizes = new Map();
  for (const d of Object.values(drives || {})) {
    if (!d?.storagePath) continue;
    sizes.set(d.storagePath, await dirBytesSafe(d.storagePath));
  }
  return sizes;
}

/** What a removal pass would do, and only with the switch on does it. The boot path never passes
 *  `force`, so a shipped build deletes nothing. */
export async function engineRemoveOrphans(opts = {}) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  const enabled = opts.force === true || ORPHAN_REMOVAL_ENABLED;
  const sizes = await orphanSizeMap(manifest.drives);
  const planned = selectRemovableOrphans(manifest.drives, orphanProbes()).map((e) => ({
    ...e,
    bytes: sizes.get(e.storagePath) ?? null,
  }));
  const freeableBytes = planned.reduce(
    (n, e) => n + (Number.isFinite(e.bytes) ? e.bytes : 0),
    0,
  );
  if (!enabled) {
    binfo(
      "engine.orphans",
      `orphan-removal disabled — would remove ${planned.length} entry(ies), ${freeableBytes} bytes`,
    );
    return { ok: true, enabled: false, planned, removed: [], failed: [], freeableBytes };
  }
  const removed = [];
  const failed = [];
  for (const entry of planned) {
    try {
      await fs.rm(entry.storagePath, { recursive: true, force: true });
      delete manifest.drives[entry.driveId];
      removed.push(entry.driveId);
    } catch (err) {
      failed.push({ driveId: entry.driveId, error: String(err?.message || err) });
    }
  }
  if (removed.length) {
    try {
      await saveManifest();
    } catch (err) {
      swallowed("engine.orphans", "manifest save after orphan removal", err);
    }
  }
  binfo(
    "engine.orphans",
    `orphan-removal removed=${removed.length} failed=${failed.length} bytes=${freeableBytes}`,
  );
  return { ok: true, enabled: true, planned, removed, failed, freeableBytes };
}

/** Bytes under a directory, or null if it cannot be read. Never throws. */
async function dirBytesSafe(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirBytesSafe(full);
      if (typeof sub === "number") total += sub;
    } else {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // a file that vanished between readdir and stat contributes nothing
      }
    }
  }
  return total;
}

export async function engineHydrateDrives() {
  if (!initialized) {
    return {
      ...failure("engine.not-initialized", "not-initialized", "Engine not initialized"),
      hydrated: 0,
    };
  }

  // Hydrate ACTIVE fully and INACTIVE lightly, mapping the legacy STOPPED state to INACTIVE.
  // Each rejection names its reason; the filter used to drop drives with nothing saying why.
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
    // A simulated receive has a real manifest entry but no corestore, so hydrating one would
    // surface a permanent failure row. Skipped, never pruned — deleting it is the user's call.
    if (d.simulated) {
      bwarn("engine.hydrate", `skip drive=${d.driveId} reason=simulated-entry`);
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

  // The orphan report plus the removal dry run. Both only describe — drive folders are never
  // pruned on a guess, so the duplicates are made visible here and removed by nobody.
  try {
    const sizes = await orphanSizeMap(manifest.drives);
    const orphans = summarizeOrphans(manifest.drives, (p) => sizes.get(p) ?? null);
    if (orphans.duplicateKeys > 0) {
      bwarn(
        "engine.orphans",
        `duplicate received drives: keys=${orphans.duplicateKeys} ` +
          `orphanEntries=${orphans.orphanCount} orphanBytes=${orphans.orphanBytes} ` +
          `(reported only — nothing is removed)`,
      );
      for (const line of orphans.lines) bwarn("engine.orphans", line);
    } else {
      bdebug("engine.orphans", "no duplicate received drives");
    }

    // The dry run. One header line plus one line per candidate, so the owner
    // can read the whole decision out of an exported log.
    const removable = selectRemovableOrphans(manifest.drives, orphanProbes());
    let dryRunBytes = 0;
    for (const e of removable) {
      const bytes = sizes.get(e.storagePath);
      if (Number.isFinite(bytes)) dryRunBytes += bytes;
    }
    bwarn(
      "engine.orphans",
      `orphan-dry-run enabled=${ORPHAN_REMOVAL_ENABLED} ` +
        `wouldRemove=${removable.length} wouldFreeBytes=${dryRunBytes} (nothing deleted)`,
    );
    for (const e of removable) {
      const bytes = sizes.get(e.storagePath);
      bwarn(
        "engine.orphans",
        `orphan-dry-run drive=${e.driveId} state=${e.state} ` +
          `bytes=${Number.isFinite(bytes) ? bytes : "unreadable"} keep=${e.keepDriveId}`,
      );
    }
  } catch (err) {
    swallowed("engine.hydrate", "orphan report", err);
  }

  let hydrated = 0;
  let failed = 0;
  for (const entry of entries) {
    const targetState = normalizeState(entry.state);
    try {
      try {
        await fs.access(entry.storagePath);
      } catch {
        // Non-destructive: never mark the entry failed in the manifest. A transient error would
        // otherwise permanently demote the drive. Tracked in memory; next boot re-attempts.
        recordHydrateFailure(entry.driveId, "Storage directory missing");
        failed++;
        continue;
      }

      if (targetState === DriveState.INACTIVE) {
        bdebug(
          "engine.hydrate",
          `drive=${entry.driveId} light-hydrate (inactive, no swarm, no corestore)`,
        );
        // Light hydration: announce the entry to RN without joining the swarm or opening the
        // corestore, and clear any stale resumeError — the drive hydrated cleanly this boot.
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
        // Stated rather than inferred from `swarm == null`: a received drive leaves this branch
        // with a live store, a live Hyperdrive, a registration in `activeDrives` — and no swarm.
        swarmMode: "none",
        metadata: entry,
        totalBytes,
        isReceiving: isReceived,
        shareLink: createShareLink(entry.key),
        // The persisted key set in the canonical shape, so a grab through `engineActivateDrive`
        // does not depend on what has replicated locally. See `toDriveFileRef`.
        files: toDriveFileRefs(entry.files),
        shareName: entry.name,
      };
      // A received drive gets a swarm at boot ONLY if `reshared` AND complete, and then as a server.
      // Neither half is redundant: completeness is not consent, and consent alone seeds a partial copy.
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
              `files=${Array.isArray(entry.files) ? entry.files.length : 0} — re-share`,
          );
        }
        session.swarm = attachHostSwarm(
          session,
          await swarmKeyPairFor(entry.driveId, entry.storagePath),
        );
      }

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
  }

  binfo(
    "engine.hydrate",
    `hydrate done: hydrated=${hydrated} failed=${failed} considered=${entries.length}`,
  );
  return { ok: true, hydrated, failed, considered: entries.length };
}

// Nudge every active drive's swarm to re-announce. A non-destructive flush, never `leave()` +
// `join()`: the leave is an active `dht.unannounce`, so an idle share erased its own record.
export async function engineRefreshSwarm() {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }

  const flushes = [];
  let reannounced = 0;

  // Runs on the foreground interval, a network change and every background→active transition, and it used to be
  // silent. "It worked, then peers stopped finding me" is answered from this loop.
  bdebug("engine.swarm", `refresh start: ${activeDrives.size} active drive(s)`);

  for (const session of activeDrives.values()) {
    if (!session.swarm) {
      bdebug("engine.swarm", `refresh skip drive=${session.driveId} reason=no-swarm`);
      continue;
    }
    if (session.isReceiving && !receivedDriveMayServe(session)) {
      // Flush-only for every received session but one holding all three of `session.serve`, a
      // persisted `entry.reshared` and every file. Never weaken this without the rejoin's `server`.
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
        // Re-announce WITHOUT unannouncing: `leave()` + `join()` is an active `dht.unannounce`,
        // and `noPeersRightNow` is true for every idle hosted share, so it ran as the normal case.
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
          // Not reachable today — every hosted swarm here is built by `attachHostSwarm`, which
          // stores the handle. A warn, because the share would silently stop being re-announced.
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
  // `rejoined` is kept on the wire and pinned at 0: it is typed in `src/lib/rpc.ts` and read by
  // the harness, and nothing rejoins any more. `reannounced` carries the meaning it used to.
  return { ok: true, refreshed: flushes.length, reannounced, rejoined: 0 };
}

/**
 * Is anyone announcing these shares right now? One shared DHT node for every waiting row, and
 * LOOKUP ONLY — neither `announce` nor `connect` is ever called, so it cannot re-announce a share.
 */
const LOOKUP_BUDGET_MS = 10000;
const LOOKUP_MAX_KEYS = 20;

let lookupDht = null;

async function ensureLookupDht() {
  if (lookupDht && !lookupDht.destroyed) return lookupDht;
  lookupDht = new HyperDHT();
  await lookupDht.ready();
  bdebug("engine.lookup", "shared lookup DHT node created");
  return lookupDht;
}

/**
 * Resolve as soon as one peer is seen, rather than draining the query. A
 * waiting row only needs to know that somebody is there.
 */
async function lookupOne(dht, keyHex, budgetMs) {
  const startedAt = Date.now();
  let target;
  try {
    target = hypercoreCrypto.discoveryKey(b4a.from(keyHex, "hex"));
  } catch {
    return { key: keyHex, found: false, peers: 0, ms: 0, error: "bad-key" };
  }

  const query = dht.lookup(target);
  let peers = 0;
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve("budget"), budgetMs);
  });

  const scan = (async () => {
    for await (const node of query) {
      const n = Array.isArray(node?.peers) ? node.peers.length : 0;
      if (n > 0) {
        peers = n;
        return "found";
      }
    }
    return "exhausted";
  })();

  let why;
  try {
    why = await Promise.race([scan, budget]);
  } catch (err) {
    swallowed("engine.lookup", `lookup ${keyHex.slice(0, 12)}`, err);
    why = "error";
  }
  if (timer) clearTimeout(timer);
  // The query holds a socket until it is drained or destroyed, and we stop
  // reading it the moment the first peer arrives.
  try {
    query.destroy();
  } catch {}
  // The scan rejects once the query is destroyed under it; nothing is waiting
  // on that rejection and an unhandled one in the worklet realm would be fatal.
  scan.catch(() => {});

  return {
    key: keyHex,
    found: peers > 0,
    peers,
    ms: Date.now() - startedAt,
    why,
  };
}

export async function engineLookupPeers(keys, opts) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  const list = Array.isArray(keys) ? keys : [];
  const valid = [];
  for (const raw of list) {
    const k = String(raw || "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(k) && !valid.includes(k)) valid.push(k);
    if (valid.length >= LOOKUP_MAX_KEYS) break;
  }

  // An empty list releases the node rather than holding one open for nothing.
  if (valid.length === 0) {
    await engineReleaseLookup();
    return { ok: true, results: [], released: true };
  }

  const budgetMs = Math.max(1000, Number(opts?.budgetMs) || LOOKUP_BUDGET_MS);
  binfo("engine.lookup", `lookup round keys=${valid.length} budget=${budgetMs}ms`);
  const startedAt = Date.now();
  let dht;
  try {
    dht = await ensureLookupDht();
  } catch (err) {
    return {
      ok: false,
      error: wrapError(err, { category: "lookup.dht-fail", cause: "lookup-dht-fail" }),
    };
  }

  const results = await Promise.all(valid.map((k) => lookupOne(dht, k, budgetMs)));
  const foundCount = results.filter((r) => r.found).length;
  binfo(
    "engine.lookup",
    `lookup round done keys=${valid.length} found=${foundCount} in ${Date.now() - startedAt}ms`,
  );
  return { ok: true, results, released: false };
}

/** Called when the list empties and from RN's active to background transition. */
export async function engineReleaseLookup() {
  if (!lookupDht) return { ok: true, released: false };
  const dht = lookupDht;
  lookupDht = null;
  try {
    await dht.destroy();
    bdebug("engine.lookup", "shared lookup DHT node destroyed");
  } catch (err) {
    swallowed("engine.lookup", "lookup dht destroy", err);
  }
  return { ok: true, released: true };
}

// `relPaths` (optional) is a parallel array of subdirectory paths inside a shared folder; unset,
// each file flattens to its basename.

/**
 * `shareName` goes on the wire, and for a single file it becomes the drive ENTRY KEY, not just the
 * title — the receiver writes what `drive.list("/")` yields, and entry keys take the guarded path.
 */
export async function engineShareFromPaths(paths, relPaths, shareName) {
  if (!initialized) {
    throw new EngineError({
      category: "engine.not-initialized",
      cause: "not-initialized",
      message: "Engine not initialized",
    });
  }

  // Creating a share is blocked while the manifest is unavailable: `saveManifest` refuses, so the
  // drive would exist only in memory and vanish — a share the user believes they made.
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

  // Stat the files up front rather than reading their bytes: it validates readability and captures
  // the authoritative size without holding any file content in memory.
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

  // Run through the SAME validators the receive path uses on a peer's title: the dialog has
  // validated it, but an engine that trusts its caller is one caller away from being unguarded.
  const chosenTitle = sanitizeShareTitle(shareName);

  // Single file: the chosen name becomes the in-drive ENTRY KEY, because that is what the receiver
  // writes. Skipped when `relPath` is set — that key encodes a position in a folder tree.
  if (chosenTitle && fileList.length === 1 && !fileList[0].relPath) {
    const original = fileList[0].name;
    const dot = original.lastIndexOf(".");
    const ext = dot > 0 ? original.slice(dot) : "";
    // A drive entry key must be a single path component — `sanitizeFolderName`
    // is what folds separators, and reusing it keeps one definition of that.
    const safeBase = sanitizeFolderName(chosenTitle);
    if (safeBase) {
      // Same double-extension rule as the dialog's `joinNameAndExt`, duplicated because the
      // worklet cannot load TypeScript. The two must move together; `shareName.test.ts` covers it.
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
    // Single file: title and filename converge, which is right — there is only one thing to name.
    // Bundle: the chosen title, falling back to the generic default so an unnamed share renders.
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

  // The wire caps a drive manifest at 1000 entries; over that the receiver silently sees a
  // truncated list, which is worth a loud line on the sending side too.
  if (fileList.length > DRIVE_MANIFEST_MAX_FILES) {
    bwarn(
      "engine.share",
      `file count ${fileList.length} exceeds DRIVE_MANIFEST_MAX_FILES=${DRIVE_MANIFEST_MAX_FILES} — receiver will see a truncated list`,
    );
  }

  try {
    let totalBytes = 0;
    const fileEntries = [];

    // Stream each file in sequentially. The size came from `fs.stat`, so the manifest entry does
    // not depend on byte counters flowing through the pipe.
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
      // A relPath is the caller's chosen in-drive key, so its basename is the name BOTH ends
      // show; `f.name` is the cache basename and would leave the sender reading a temp filename.
      const entryName = f.relPath ? path.basename(storagePath) : f.name;
      fileEntries.push({
        name: entryName,
        storagePath,
        size: f.size,
        addedAt: Date.now(),
        // The canonical spellings, written beside the legacy pair so the hosted side reads one
        // shape too. See `toDriveFileRef`.
        key: `/${normalizeKey(storagePath)}`,
        displayName: entryName,
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

    const swarm = attachHostSwarm(session, await swarmKeyPairFor(driveId, drivePath));
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

// Re-probe the manifest blob until the resolve budget is spent. `drive.update()` resolves on HEAD
// METADATA, not blob replication, so one probe at that instant routinely returns null.
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
    // `drive.get` blocks when the entry is known but its block has not arrived, so the probe is
    // raced against the budget. The detached `.catch` stops the loser surfacing as unhandled.
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

  // Receiving is blocked too while the manifest is unavailable: the open path persists SEEKING
  // first, and with saves refused the corestore folder becomes an orphan no cleanup pass can find.
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

  // Reuse the share's own drive, in three cases. The live-session case must come FIRST:
  // `hypercore-storage` opens CORESTORE with `lock: true`, so a second open on that path throws.
  const reuseEntry = pickDriveToReuse(manifest.drives, keyHex);
  const reuseSession = reuseEntry ? activeDrives.get(reuseEntry.driveId) : null;

  if (reuseSession && reuseSession.drive) {
    // The session is handed back AS IT IS; its swarm mode is untouched. This may be a re-share
    // running as a server, and a resolve is not a request to demote one.
    const entry = manifest.drives[reuseEntry.driveId] || reuseEntry;
    const refs = toDriveFileRefs(entry.files);
    binfo(
      "engine.open",
      `reusing LIVE session drive=${reuseEntry.driveId} key=${keyHex.slice(0, 12)}… ` +
        `mode=${currentSwarmMode(reuseSession)} files=${refs.length} (no mode change)`,
    );
    return {
      ok: true,
      driveId: reuseEntry.driveId,
      files: refs.map((r) => ({
        name: r.key,
        displayName: r.displayName,
        size: r.size,
        key: r.key,
      })),
      shareName: entry.name ?? null,
      totalBytes: Number(entry.totalBytes || 0),
      hasManifest: true,
      truncated: null,
      reused: "session",
    };
  }

  // No live session, but storage we can adopt. `fs.access` first: an entry
  // whose folder is gone must fall through to a fresh mint rather than fail.
  let reusedPath = null;
  if (reuseEntry) {
    try {
      await fs.access(reuseEntry.storagePath);
      reusedPath = reuseEntry.storagePath;
    } catch {
      bwarn(
        "engine.open",
        `entry drive=${reuseEntry.driveId} names storage that is gone — minting a new drive`,
      );
    }
  }

  const driveId = reusedPath ? reuseEntry.driveId : generateDriveId("recv");
  const drivePath = reusedPath || path.join(drivesDir, driveId);
  // Whether THIS call created the folder. The failure paths below key on it:
  // a store we adopted is closed, never deleted.
  const createdStorage = !reusedPath;
  binfo(
    "engine.open",
    `link parsed ok drive=${driveId} key=${keyHex.slice(0, 12)}… ` +
      `reuse=${reusedPath ? "storage" : "none"}`,
  );

  const store = new Corestore(drivePath);
  await store.ready();

  const drive = new Hyperdrive(store, b4a.from(keyHex, "hex"));
  await drive.ready();
  bdebug("engine.open", `corestore+hyperdrive opened drive=${driveId} at ${drivePath}`);

  // Persist SEEKING so the corestore folder is not an orphan if the app dies mid-open — but ONLY
  // for a drive this call created: writing it over a reused entry would replace a real record.
  if (createdStorage) {
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
  } else {
    binfo(
      "engine.open",
      `reusing stored drive=${driveId} storage=${drivePath} — entry left intact, no SEEKING write`,
    );
  }

  const swarm = new Hyperswarm();
  // Receive-side peer count, so the log can distinguish
  // "no peer ever arrived" from "a peer arrived and then dropped".
  const connectedPeerIds = new Set();

  swarm.on("connection", (socket, peerInfo) => {
    // A stable 12-char peerId from the remote public key, so two senders on one received drive
    // do not collapse into a single entry in RN's string-keyed peerIds set.
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
  // Client-only. Hyperswarm defaults to `{ server: true, client: true }`, so a bare join published
  // an announce record before this device held a single block. Announcing is not part of resolving.
  binfo(
    "engine.open",
    `joining swarm drive=${driveId}, seeking peers (server=false client=true, receiver does not announce)`,
  );
  // The discovery session is CAPTURED here. Discarding it is the second half of why a late host
  // was never found — see the re-query timer below.
  const discovery = swarm.join(drive.discoveryKey, { server: false, client: true });
  const flushStart = Date.now();
  await swarm.flush();
  binfo(
    "engine.open",
    `swarm.flush returned drive=${driveId} in ${Date.now() - flushStart}ms peers=${connectedPeerIds.size}`,
  );

  // Released on the RESOLVE_WAIT_MS deadline, not on `swarm.flush()`: flush resolving means this
  // client's lookup propagated, not that a peer answered. Idempotent — three paths reach it.
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

  // Re-query the DHT while waiting: `swarm.flush()` runs the lookup once, at t=0, when nobody was
  // announcing. `{ server: false }` is load-bearing — `refresh` PROMOTES when the flag is omitted.
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
      // Four best-effort teardown steps, each previously a
      // bare `catch {}`. Behaviour unchanged; the failures are now visible.
      bdebug("engine.open", `cleanup start drive=${driveId}`);
      // Release the deadline timer and `findingPeers` FIRST: a timer left armed here fires against
      // a closed Hyperdrive, and the re-query interval against a destroyed swarm.
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
      // ONLY remove storage this call created: with reuse, an unconditional `fs.rm` would delete
      // the share's accumulated blocks because one resolve failed. The store is closed either way.
      if (createdStorage) {
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
      } else {
        binfo(
          "engine.open",
          `cleanup kept reused storage drive=${driveId} path=${drivePath} ` +
            `(closed, not deleted; manifest entry intact)`,
        );
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
    // The abort race throws "Connection cancelled by user", and the cause label is what lets RN
    // hide the toast on a cancel.
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
  // Head metadata is in, or the budget ran out. Either way nothing further waits on discovery, so
  // stop holding `findingPeers`: the remaining budget belongs to the manifest blob.
  clearTimeout(findingPeersTimer);
  clearInterval(rediscoverTimer);
  releaseFindingPeers("drive.update returned");

  let files = [];
  let manifestData = null;
  let totalBytes = 0;
  let shareName = null;
  let truncated = null;

  try {
    // A one-shot probe taken the instant head metadata landed is the earliest moment the blob can
    // be missing, so this re-probes until the resolve budget is spent.
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
        // Validated where it enters, not where it is used: this value later becomes a directory
        // name. See `sanitizeShareTitle`.
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
        // Surface a truncation hint when the manifest declares more files than the wire-level
        // 1000-entry cap allows, instead of silently dropping the overflow.
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
          // When `path` is missing from the manifest entry, fall back to the basename; the old
          // behaviour produced `name: "/"`, which the receiver cannot `drive.get`.
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
            // The canonical spelling of `name`, added alongside it rather than replacing it:
            // `name` here is the KEY, which is the collision `DriveFileRef` exists to end.
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
        // Canonical spelling, added beside the legacy one.
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

  // The gate keys on `manifestData`, the same expression behind the returned `hasManifest`, so the
  // engine and RN cannot disagree about "usable". NOT on `files.length`: zero files can be real.
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

  // Transition the SEEKING entry to ACTIVE rather than deleting it, so the receiver drive survives
  // restarts. After engineDownload completes the entry settles into INACTIVE.
  const meta = manifest.drives[driveId] || {};
  meta.driveId = driveId;
  meta.key = keyHex;
  setDriveState(meta, DriveState.ACTIVE, "engineOpenDrive: resolve complete");
  meta.origin = "received";
  meta.shareLink = shareLink.trim();
  meta.storagePath = drivePath;
  meta.lastActivityAt = Date.now();
  // Storage keeps the real title or nothing — a display fallback stored here becomes a directory
  // literally named `Received`. `null`, not `undefined`: only null survives the JSON round-trip.
  meta.name = shareName || null;
  meta.totalBytes = totalBytes;
  // One canonical shape, written by both producers.
  const fileRefs = toDriveFileRefs(files);
  meta.files = fileRefs.map(driveFileRecord);
  manifest.drives[driveId] = meta;
  try { await saveManifest(); } catch {}

  const session = {
    driveId,
    drive,
    store,
    swarm,
    // The mode is `client`, stated rather than re-derived: two derivations of one fact is how
    // `already: true` came to describe a swarm that did not exist. `discovery` is kept for promotion.
    discovery,
    swarmMode: "client",
    serve: false,
    isReceiving: true,
    manifest: manifestData,
    totalBytes,
    shareName,
    shareLink: shareLink.trim(),
    metadata: meta,
    // The session carries the CANONICAL shape. The wire reply
    // below still carries the legacy one until RN adopts `DriveFileRef`.
    files: fileRefs,
    // The live peer set, so a grab that gave up can say whether anyone was there: a stall with a
    // peer is a bad link, with none it is an absent sender, and only the second is worth queueing.
    connectedPeerIds,
  };
  activeDrives.set(driveId, session);

  // Live progress as blocks land, not one event per file. Routed through `ensureDownloadTracking`
  // so this and `engineActivateDrive` share ONE binding path — two would double-count.
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
    // Says how this drive was obtained. `closePreview` skips its teardown only for `"session"`,
    // but reporting both makes the reply describe what happened rather than one caller's branch.
    reused: createdStorage ? undefined : "storage",
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
 * Stop a transfer happening right now without destroying anything the user did not ask to lose.
 * It sets `_cancelled` and destroys the parked stream; the loop observes the flag and unwinds itself.
 */
export async function engineCancelTransfer(driveId) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  const id = String(driveId || "");
  if (!id) {
    return failure("drive.invalid-arg", "drive-id-required", "driveId required");
  }

  // Simulated transfers: engineStopDrive's fake-session teardown already clears the timers.
  // `purge:false` because there is no real storage and the flag only decorates the event.
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
    // Nothing in flight, and it emits NOTHING on purpose: the likeliest way here is a cancel that
    // lost a race with a download finishing, which must stay reported as finished.
    binfo("engine.cancel", `cancel drive=${id} — no active session, nothing to stop`);
    return { ok: true, alreadyInactive: true };
  }

  // BEFORE `_cancelled` is set: the question is what the pipeline looked like when the user
  // stopped. `capacity` bounds what may still arrive; `active` is recorded alongside, not a bound.
  const inflightAtCancel = inflightBlocksOf(session);

  session._cancelled = true;

  if (session._dlRunning) {
    lateRecordFor(id).inflightAtCancel = inflightAtCancel;
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

  // No download loop: a hosted share serving peers, or a receive session opened but never started.
  // Deactivate — swarm and session torn down, storage and manifest entry preserved.
  const direction = session.isReceiving ? "download" : "upload";
  const res = await engineDeactivateDrive(id);
  binfo("engine.cancel", `cancelled drive=${id} direction=${direction} (deactivated, not purged)`);
  emitEvent({ type: "transfer-cancelled", driveId: id, direction, filesKept: 0 });
  return res;
}

/**
 * Wait for a cancelled `engineDownload` loop to unwind. Bounded, so a wedged loop cannot turn
 * Delete into a hang; timing out is no worse than never having waited.
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
    // The download simulation is the only fake session owning a manifest entry, so cancelling it
    // must take the entry too, or the row outlives the simulation.
    if (fakeSession.simulated && manifest.drives[driveId]?.simulated) {
      delete manifest.drives[driveId];
      try { saveManifest(); } catch {}
      binfo("engine.simulate", `removed simulated manifest entry drive=${driveId} (cancelled)`);
    }
    emitEvent({ type: "drive-stopped", driveId, purged: opts.purge !== false });
    return { ok: true };
  }

  // A drive with no live session is still deletable: every INACTIVE drive is light-hydrated
  // without one. The failure is kept only for an id with no session AND no manifest entry.
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

  // Flag, abort, settle, THEN destroy. Aborting without waiting leaves the loop's own teardown
  // racing the `fs.rm` below, and an in-flight pipe can recreate content the purge just deleted.
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
  }

  // Fall back to the manifest entry's storagePath: a light-hydrated drive has no session to
  // carry it, and that is the case this path exists for.
  const storagePath = session?.metadata?.storagePath ?? entry?.storagePath;

  // Whether the bytes are genuinely gone, which decides whether the entry may be removed.
  // `force: true` does not throw on a missing path, so "already absent" correctly counts as removed.
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
    // An explicit Delete removes the entry outright — the one case that is unambiguous by
    // construction. Guarded on `storageGone`: removing it after a failed `fs.rm` would orphan bytes.
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

// Stream a file from disk into the drive; the `fs.readFile` → `drive.put` pair it replaces OOM'd
// on media. Await `'close'`, not `'finish'`: Hyperdrive commits the bee entry inside `final()`.
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

// Stream a file out of the drive to disk, unlinking the partial on any pipe error. The stall
// watchdog re-arms on each chunk, or a dropped peer would hang the whole `engineDownload` loop.
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

// A distinct type rather than a flag on FileStallError: a stall is a failure and shows an error,
// a cancellation is an instruction obeyed and must not. `engineDownload` branches on the cause.
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
 * Load-bearing, all four: settle on `'close'` not `'finish'`; `once("error")` plus the `settled`
 * guard; passive `rs.on("data", armStall)` ALONGSIDE `pipe`; `armStall()` BEFORE the first data.
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
      // The handle must be cleared on EVERY exit: a stale abort handle pointing at a destroyed
      // stream is how a later cancel tears down the wrong file.
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
    /**
     * The per-file watchdog YIELDS to the session's recovery: a stall is a pause, not a failure, so
     * firing it re-asks whether the session is alive and still downloading, and re-arms if so.
     */
    const armStall = () => {
      clearStall();
      stallTimer = setTimeout(() => {
        /**
         * The re-arm is GATED on bytes already held this attempt, or a peer attached right now.
         * Ungated, a grab that never reached anyone never resolves and the caller waits forever.
         */
        const held = session?._dlBytes ?? 0;
        const peersNow = session?.connectedPeerIds?.size ?? 0;
        const worthWaitingFor = held > 0 || peersNow > 0;
        const alive =
          !!session &&
          session._dlRunning === true &&
          session._cancelled !== true &&
          worthWaitingFor;
        if (alive) {
          bdebug(
            "engine.download",
            `per-file stall budget elapsed for ${destPath} — waiting, ` +
              `the session is recovering (held=${held} peers=${peersNow})`,
          );
          armStall();
          return;
        }
        done(new FileStallError(destPath));
      }, STALL_TIMEOUT_MS);
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
    // Passive listener ALONGSIDE pipe, never instead of it: it re-arms the watchdog and counts the
    // file's own bytes. The blob core's `download` event counts blocks, so a resume would over-report.
    rs.on("data", (chunk) => {
      armStall();
      if (session) {
        session._dlActiveBytes =
          (session._dlActiveBytes || 0) + (chunk?.length || 0);
      }
    });
    rs.pipe(ws);
    // Arm immediately in case no data ever arrives (peer already gone
    // before the first block).
    armStall();
  });
}

/**
 * The share title is peer-supplied and becomes a directory name, so it is validated where it
 * ENTERS: type, NUL and C0 controls, and length in both characters and UTF-8 bytes. Null if unusable.
 */
const SHARE_TITLE_MAX_CHARS = 120;
const SHARE_TITLE_MAX_BYTES = 255;

function sanitizeShareTitle(raw) {
  // 1. Type. `typeof` rather than truthiness so a number or an object is
  // rejected outright rather than coerced into a plausible-looking name.
  if (typeof raw !== "string") return null;

  // NUL, C0 controls and DEL, written as escape sequences: the literal bytes make this file
  // register as binary to grep and diff, which hides a security-relevant line from review.
  let out = raw.replace(/[\u0000-\u001F\u007F]/g, "");

  // Length, characters first then bytes. The byte trim walks back one character at a time, so a
  // multi-byte character is never cut in half.
  out = out.slice(0, SHARE_TITLE_MAX_CHARS);
  while (out.length > 0 && b4a.byteLength(out, "utf8") > SHARE_TITLE_MAX_BYTES) {
    out = out.slice(0, -1);
  }

  out = out.trim();
  return out.length > 0 ? out : null;
}

// Second line of defence; the title is sanitized at the parse boundary first. The
// `..`-removed-before-separator-replacement ordering is an Appendix C constraint — keep it.
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
 * The folder a previous grab of THIS drive used, re-derived under the current parent, or null.
 * Only the last segment is trusted and it goes back through `safePathWithin`, never `path.join`.
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

/**
 * The silence watchdog and the forced recovery it drives. Hyperswarm keeps one connection per remote
 * key, so a dead socket still considered alive blocks the returning sender's new one.
 */
function startSilenceWatchdog(session) {
  const { driveId } = session;
  if (session._silenceTimer) return;

  session._stalled = false;
  session._lastByteAt = Date.now();
  session._lastByteSeen = session._dlBytes ?? 0;
  session._stallCycles = 0;

  session._silenceTimer = setInterval(() => {
    // The session is gone, or the download is over. Either way there is
    // nothing to watch; `stopSilenceWatchdog` normally gets here first.
    if (!activeDrives.has(driveId) || session._dlRunning !== true) return;

    const now = Date.now();
    const bytes = session._dlBytes ?? 0;

    if (bytes > session._lastByteSeen) {
      session._lastByteSeen = bytes;
      session._lastByteAt = now;
      if (session._stalled) {
        session._stalled = false;
        const held = bytes;
        const total = session._dlExpected || session.totalBytes || 0;
        const pct = total > 0 ? Math.min(100, Math.round((held / total) * 100)) : 0;
        binfo(
          "engine.transfer",
          `resumed drive=${driveId} heldBytes=${held} pct=${pct}`,
        );
        emitEvent({ type: "transfer-resumed", driveId, heldBytes: held, percent: pct });
      }
      return;
    }

    const silenceMs = now - session._lastByteAt;
    if (silenceMs < DOWNLOAD_SILENCE_MS) return;

    // Already reported this silence. The recovery retries on the re-query cadence rather than
    // every tick, so a long outage cannot destroy a freshly-arrived connection.
    if (session._stalled && now - (session._lastRecoveryAt ?? 0) < RESOLVE_REQUERY_MS) {
      return;
    }

    const destroyed = forceReconnect(session, silenceMs);
    session._lastRecoveryAt = now;

    if (!session._stalled) {
      session._stalled = true;
      session._stallCycles = (session._stallCycles ?? 0) + 1;
      const peers = (session.connectedPeerIds ?? new Set()).size;
      binfo(
        "engine.transfer",
        `stalled drive=${driveId} silenceMs=${silenceMs} peers=${peers} destroyed=${destroyed}`,
      );
      emitEvent({
        type: "transfer-stalled",
        driveId,
        silenceMs,
        peers,
        destroyed,
        heldBytes: bytes,
      });
    }
  }, SILENCE_TICK_MS);
  // The worklet must be able to exit; an interval that pins it is a freeze of
  // our own making.
  session._silenceTimer.unref?.();
}

/**
 * Close a stall before tearing the watchdog down: a stall resolved by the download FINISHING
 * emitted no `transfer-resumed`, because the tick that would have noticed never ran.
 */
function closeStallIfOpen(session) {
  if (!session?._stalled) return;
  session._stalled = false;
  const held = session._dlBytes ?? 0;
  const total = session._dlExpected || session.totalBytes || 0;
  const pct = total > 0 ? Math.min(100, Math.round((held / total) * 100)) : 0;
  binfo(
    "engine.transfer",
    `resumed drive=${session.driveId} heldBytes=${held} pct=${pct} (download ended)`,
  );
  emitEvent({
    type: "transfer-resumed",
    driveId: session.driveId,
    heldBytes: held,
    percent: pct,
  });
}

function stopSilenceWatchdog(session) {
  closeStallIfOpen(session);
  if (!session?._silenceTimer) return;
  try {
    clearInterval(session._silenceTimer);
  } catch {
    /* already cleared */
  }
  session._silenceTimer = null;
  session._stalled = false;
}

/**
 * Destroy the drive's connections and ask the DHT again. Every connection goes, because the silence
 * is share-wide. The swarm is NOT destroyed and the topic is NOT left, so discovery survives.
 */
function forceReconnect(session, silenceMs) {
  const { driveId } = session;
  let destroyed = 0;
  try {
    for (const conn of session.swarm?.connections ?? []) {
      try {
        conn.destroy();
        destroyed++;
      } catch {
        /* a connection already going away still counts as gone */
      }
    }
  } catch {
    /* a destroyed swarm has no connections to walk */
  }
  // `{ server: false, client: true }` explicitly — the `false` is load-bearing. `refresh` PROMOTES
  // when the flag is omitted, announcing this receiver as a source of blocks it does not hold.
  try {
    if (session.discovery) {
      Promise.resolve(
        session.discovery.refresh({ server: false, client: true }),
      ).catch((e) => swallowed("engine.transfer", `recovery refresh ${driveId}`, e));
    }
  } catch (e) {
    swallowed("engine.transfer", `recovery refresh ${driveId}`, e);
  }
  bdebug(
    "engine.transfer",
    `forced reconnect drive=${driveId} silenceMs=${silenceMs} destroyed=${destroyed}`,
  );
  return destroyed;
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

  // One download per drive. Two loops over one session share `_abortActivePipe`, `_dlBytes` and
  // `_downloadRoot`, so the second would retarget the first's cancel handle and corrupt its bytes.
  if (session._dlRunning) {
    bwarn(
      "engine.download",
      `download REFUSED drive=${driveId} — one is already running for this drive`,
    );
    return failure(
      "receive.already-downloading",
      "already-downloading",
      "This share is already downloading.",
      { driveId },
    );
  }

  const { drive } = session;
  const outDir = destDir || downloadsDir;
  await fs.mkdir(outDir, { recursive: true });

  const downloadedFiles = [];
  const failedFiles = [];
  const start = Date.now();
  let bytesDownloaded = 0;

  // Enumerate from the SAVED KEYS, not from what has replicated: `drive.list("/")` yields zero
  // files inside the pre-replication window, which produced a short list with no error.
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

  // A folder-shaped share wraps downloads under `<outDir>/<shareName>/`, cached on the session so a
  // later per-file grab reuses the same root rather than making "MyProject (1)" beside it.
  const shareName = sanitizeFolderName(session.shareName);
  const isFolderShare =
    (filesToDownload.length > 1 || (shareName && !shareName.includes("."))) && !!shareName;
  let downloadRoot = session._downloadRoot;
  if (!downloadRoot) {
    // `safePathWithin`, never `path.join` — the share title arrives by a different route from the
    // per-file keys. A title that fails the check does not sink the grab; files land flat in outDir.
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
    // A repeat grab of the SAME drive goes back to the folder it used last time. Only the last
    // segment is trusted, and it is re-checked with `safePathWithin`.
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
    // Persisted the moment it is chosen, not in the teardown: the folder exists on disk already, so
    // a crash before teardown would leave `uniqueFolderPath` stepping around it on the next launch.
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

  // No synthetic self-peer: RN classifies transfers by drive origin, so a fake one only
  // confused the UI.

  // The selected-file total, so the tracker emits percent against THIS call's expected bytes.
  // Otherwise grabbing 1 file of 3 caps the percent at ~33% even when the user is done.
  let selectedExpected = 0;
  // Hoisted out of the `if` below so the per-file loop can read a selected key's own size.
  // Empty when the session carries no file metadata, which the `|| 0` at every read handles.
  const sizeByKey = new Map();
  if (Array.isArray(session.files) && session.files.length) {
    for (const f of session.files) {
      // `session.files` is canonical on every path. Reading `f.name` as the key was true of the
      // open shape and false of the persisted one, so every lookup missed and percent capped low.
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
  session._dlActiveKey = null;
  session._dlActiveBytes = 0;
  session._dlActiveTotal = 0;
  // Once per block index per download, so a resume counts the gap and not the
  // blocks the interrupted attempt already stored.
  session._dlPeerBytes = 0;
  if (session._dlSeenBlocks instanceof Set) session._dlSeenBlocks.clear();
  else session._dlSeenBlocks = new Set();

  // Prefer session.totalBytes so percent tracks bytes pulled over the wire rather than a
  // files-completed ratio. Fall back to the file-count ratio when no total is known.
  const knownTotal = selectedExpected > 0
    ? selectedExpected
    : (typeof session.totalBytes === "number" && session.totalBytes > 0
        ? session.totalBytes
        : 0);

  // The loop is cancellable and unwinds ITSELF: `engineCancelTransfer` sets the flag and destroys
  // the stream, so exactly one of the two paths does the teardown, and it is this one.
  session._cancelled = false;
  session._dlRunning = true;
  // Armed BEFORE the first file opens, so a sender that is already gone is
  // caught by silence rather than waited out for 60 s per file.
  startSilenceWatchdog(session);

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
      // Peer-provided keys are untrusted. On rejection the file is skipped and recorded with a
      // peer-path-traversal cause, so one hostile key cannot sink the whole download.
      const relativePath = file.key.replace(/^\//, "");
      filePath = safePathWithin(downloadRoot, relativePath);
      const parentDir = path.dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });
      const requestedPath = filePath;
      filePath = await uniquePath(filePath);
      if (filePath !== requestedPath) {
        // Record the rename, so "where did my file go" is answerable when the user gets
        // "photo (1).jpg".
        binfo(
          "engine.download",
          `name collision drive=${driveId} wanted=${requestedPath} using=${filePath}`,
        );
      }
      const fileStart = Date.now();

      // Stamped BEFORE the pipe, so the file's first progress event already names it.
      // `_dlActiveTotal` is the same figure RN holds on the record.
      session._dlActiveKey = file.key;
      session._dlActiveBytes = 0;
      session._dlActiveTotal = sizeByKey.get(normalizeKey(file.key)) || 0;

      // Stream from the drive into the file; the `drive.get` → `fs.writeFile` pair it replaces
      // OOM'd on media. The pipe completes even for 0-byte entries.
      await pipeDriveToFile(drive, file.key, filePath, session);

      // Authoritative size from disk. Byte counters flowing through the stream drift from raw file
      // bytes — the same drift that makes the sender-side 95% threshold necessary.
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

      // Per-file completion, emitted here and nowhere else, so `k of N saved` advances during the
      // grab. Inside the try and after the push: the only place a file is known to be on disk.
      emitEvent({
        type: "download-file-done",
        driveId,
        key: file.key,
        name: path.basename(filePath),
        localPath: filePath,
        size: fileSize,
        filesDone: downloadedFiles.length,
        filesTotal: selected.length,
      });
    } catch (fileError) {
      // A second line of defence, and it targets the PART path. Unlinking `filePath` would be
      // wrong: nothing is written there until the rename, so a failure leaves it absent.
      if (filePath) {
        try {
          await fs.unlink(`${filePath}${PARTIAL_SUFFIX}`);
        } catch {
          // Expected — pipeDriveToFile already removed it. Logging a miss on every failed file
          // would be noise describing the normal case.
        }
      }

      // A cancellation is an instruction obeyed, not a file that failed: it stays out of
      // `failedFiles`, does not log at warn, and stops the loop rather than advancing.
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

      // Carry a typed cause where there is one, so RN can tell a peer-hostile path from a local
      // disk failure. Non-typed failures fall through with the raw message.
      const cause = fileError instanceof PathTraversalError
        ? fileError.cause
        : (fileError?.cause || undefined);
      if (cause === "peer-path-traversal") {
        // Security-relevant: a peer handed us a key that tried to escape the download root, so this
        // is loud and is delivered to RN rather than emitted into the void.
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
    // Reconcile to the authoritative per-file byteLength at each boundary so block-overhead drift
    // cannot accumulate. `_dlPeerBytes` is NOT reconciled — it is the wire figure.
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
      bytesFromPeers: session._dlPeerBytes,
    });
  }

  // Clear the per-download denominator, or a later download keeps computing percent against this
  // call's expected bytes.
  session._dlExpected = 0;
  stopSilenceWatchdog(session);
  // And the active file, for the same reason: a stale key would make RN draw a
  // progress bar on a file nothing is writing.
  session._dlActiveKey = null;
  session._dlActiveBytes = 0;
  session._dlActiveTotal = 0;

  // Settle the entry into INACTIVE so the drive survives a restart, and tear the swarm down: the
  // user's intent was to grab the files. Re-activating via Share seeds again.
  binfo(
    "engine.download",
    `download loop ${cancelled ? "cancelled" : "done"} drive=${driveId} ` +
      `ok=${downloadedFiles.length} failed=${failedFiles.length} bytes=${bytesDownloaded}`,
  );

  // Identical for a cancelled run, deliberately: files that finished before the cancel are real
  // files on disk, and dropping them from `localFiles` would strand them where nothing can find them.
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

  // Close the drive, then the store, then delete from `activeDrives` — the same three steps, in the
  // same order, as the other two teardowns. An abandoned store keeps its fd lock for the process.
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

  // Cleared LAST, after the session has left `activeDrives`, so a cancel arriving mid-teardown
  // returns "already unwinding" instead of tearing the same session down a second time.
  session._dlRunning = false;

  const duration = Date.now() - start;

  // A cancelled download must never emit `upload-complete` — RN posts "Download complete" off it.
  // `transfer-cancelled` is a separate event so no handler can treat it as completion by accident.
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

  // A grab where every file failed must not emit `upload-complete`. The old emit is REPLACED, never
  // dual-emitted: leaving it here would let the old "Download complete" path fire as well.
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
    // Peers attached when the loop finished. RN needs it to tell a stall with
    // nobody there from a stall against a peer that is simply slow.
    peersConnected: session.connectedPeerIds?.size ?? 0,
  };
}

export function engineStatus() {
  return {
    stub: false,
    started: initialized,
    activeCount: activeDrives.size,
    pendingOpen: pendingConnections.size,
    // Liveness counter and its cadence, carried on the existing status reply rather than a new
    // opcode, so observing it costs nothing beyond the status call RN already makes.
    aliveTicks,
    aliveTickMs: ALIVE_TICK_MS,
    // The field RN reads to show the manifest-unavailable message and disable share creation.
    // Always a boolean, so `undefined` can only mean "this worklet predates the field".
    manifestUnavailable,
    // `maxTickGapMs` is monotonic and for a log line, never graded on. `tickGaps` is what the
    // freeze grader reads, and it is copied on the way out so a caller cannot mutate the record.
    maxTickGapMs,
    tickGaps: tickGaps.slice(),
    // The grace the worklet is actually sweeping on, read back rather than assumed. `0` means RN
    // handed none down and no wake will be emitted, which a log must be able to see.
    idleHostGraceMs,
  };
}

/**
 * Pure measurement for one drive — reads and copies, mutates nothing. A socket can sit in
 * `swarm.connections` while `connectedPeerIds` still lists its peer and no byte has moved.
 */
export function engineDiagnoseDrive(driveId) {
  const session = activeDrives.get(driveId);
  if (!session) {
    // `late` is additive, and it is the only way to ask what landed after a cancel once the
    // session is gone — which is exactly when the question gets asked.
    return {
      ok: false,
      reason: "no-session",
      late: cancelledSessionActivity.get(driveId) ?? null,
    };
  }
  const swarm = session.swarm;
  let connections = null;
  try {
    // Hyperswarm exposes a Set; older versions exposed an array-like. Neither `size` nor `length`
    // is guaranteed, so this reports `null` rather than inventing a zero.
    const c = swarm?.connections;
    if (c && typeof c.size === "number") connections = c.size;
    else if (c && typeof c.length === "number") connections = c.length;
  } catch {
    /* a destroyed swarm answers nothing; `null` is the honest reading */
  }
  let peerKeys = [];
  try {
    for (const conn of swarm?.connections ?? []) {
      const hex = conn?.remotePublicKey?.toString?.("hex");
      if (hex) peerKeys.push(hex.slice(0, 12));
    }
  } catch {
    peerKeys = [];
  }
  return {
    ok: true,
    driveId,
    // The engine's own peer bookkeeping, which is what the events are built
    // from.
    connectedPeerIds: Array.from(session.connectedPeerIds ?? []),
    // The swarm's live socket set. The gap between this and the line above is the thing to look for.
    connections,
    peerKeys,
    dlRunning: session._dlRunning === true,
    dlBytes: session._dlBytes ?? null,
    dlPeerBytes: session._dlPeerBytes ?? null,
    dlExpected: session._dlExpected ?? null,
    activeKey: session._dlActiveKey ?? null,
    activeBytes: session._dlActiveBytes ?? null,
    activeTotal: session._dlActiveTotal ?? null,
    cancelled: session._cancelled === true,
    // Outstanding block requests. `null`, never 0, when hypercore's private
    // replicator state cannot be read - see `inflightBlocksOf`.
    inflightBlocks: inflightBlocksOf(session),
    blocksSeen: session._dlSeenBlocks?.size ?? null,
    late: cancelledSessionActivity.get(driveId) ?? null,
  };
}

export function engineListDrives() {
  // Every drive in the manifest is reported, active and inactive, not just in-process sessions.
  // RN's unified list reads from this; per-drive state decides the visual treatment.
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
      // Always a boolean, never absent: `undefined` at the RN end would mean "this worklet predates
      // the field", which a Share control cannot tell from "the user has not re-shared this".
      reshared: entry.reshared === true,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt || entry.createdAt,
    });
  }
  return drives;
}

// Bring an inactive manifest entry online: reopen corestore, recreate Hyperdrive against the
// recorded key, attach a swarm. A received drive gets a CLIENT-ONLY swarm unless `serve` opts in.
export async function engineActivateDrive(driveId, opts) {
  if (!initialized) {
    return failure("engine.not-initialized", "not-initialized", "Engine not initialized");
  }
  if (!driveId) {
    return failure("drive.invalid-arg", "drive-id-required", "driveId required");
  }

  const entry = manifest.drives?.[driveId];
  const existing = activeDrives.get(driveId);

  // The origin-derived default, from whichever source knows: a live session's own flag, else the
  // manifest entry. `serve === undefined` means no preference and the default stands.
  const isReceiving = existing
    ? !!existing.isReceiving
    : (entry?.origin || "hosted") === "received";
  const requested = typeof opts?.serve === "boolean" ? opts.serve : !isReceiving;
  const requestedMode = requested ? "server" : "client";

  // `serve: true` is a REQUEST, refused for an incomplete copy: announcing one puts a file list on
  // the DHT that a third peer will stall on. `ok` stays true — only the announce is declined.
  const serveRefused =
    isReceiving && requested && !receivedDriveIsComplete(entry) ? "incomplete" : null;
  const serve = serveRefused ? false : requested;
  if (serveRefused) {
    bwarn(
      "engine.state",
      `activate drive=${driveId} REFUSED the re-share reason=${serveRefused} ` +
        `localFiles=${Array.isArray(entry?.localFiles) ? entry.localFiles.length : 0}` +
        `/${Array.isArray(entry?.files) ? entry.files.length : 0} ` +
        `— a received copy announces only when it holds every file`,
    );
  }

  /**
   * Written only for a received drive and only when the caller expressed a boolean — absent `serve`
   * is "no opinion". A refusal writes `false`, so a stale `true` cannot re-announce a lost share.
   */
  const persistReshared = (target) => {
    if (!target || !isReceiving) return false;
    if (typeof opts?.serve !== "boolean") return false;
    if (target.reshared === serve) return false;
    target.reshared = serve;
    return true;
  };

  // Ordered BEFORE the `entry` checks: a live session is proof the drive exists and its storage is
  // open, so a drive with a session can no longer reach any failure return below.
  if (existing) {
    const previousMode = currentSwarmMode(existing);

    // Refresh the list off the manifest even on the reuse path — the entry on disk is the
    // authority, which is what lets `engineDownload` enumerate from the persisted key set.
    if (entry) {
      const refs = toDriveFileRefs(entry.files);
      if (refs.length) existing.files = refs;
      if (entry.name !== undefined) existing.shareName = entry.name;
      existing.metadata = entry;
    }
    // A grab on a session that arrived any other way emitted no per-block progress at all.
    // Idempotent: the hook unbinds the previous listener first.
    ensureDownloadTracking(existing);

    // Compared against `requestedMode`, not the mode the refusal resolved to: a refused
    // `serve: true` must fall through and report `already: false`.
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

    // No swarm at all means attach one; a swarm in the wrong mode means `PeerDiscoverySession
    // .refresh`, the only non-destructive way to change it — leave+join empties the topic first.
    existing.serve = serve;
    let mode = previousMode;
    try {
      if (!existing.swarm) {
        const keyPair = await swarmKeyPairFor(
          driveId,
          existing.metadata?.storagePath ?? entry?.storagePath,
        );
        // Re-checked after the await, so two overlapping activates never attach two swarms.
        if (!existing.swarm) existing.swarm = attachHostSwarm(existing, keyPair);
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
        // A swarm with no usable discovery handle, reported rather than papered over: answering
        // with the mode we WANTED is the dishonesty this reply exists to avoid.
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
      // Persisted BEFORE the save, so intent and state reach disk in one write. Two writes leave a
      // window where a crash produces an ACTIVE received entry with no `reshared`.
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
      // NEVER true for a mode the swarm is not in. This is the whole of N-04.
      already: false,
      reusedSession: true,
      serveRefused,
    };
  }

  if (!entry) {
    // The remedy has to name a thing that exists: a relaunch genuinely reloads the list
    // (`engineInit` → `loadManifest` → `engineHydrateDrives`). `cause` is unchanged; RN branches on it.
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
      // The explicit opt-in, read by `attachHostSwarm`. Always a boolean by here — `serve` was
      // resolved against the origin-derived default at the top of the function.
      serve,
      metadata: entry,
      totalBytes,
      isReceiving,
      shareLink: createShareLink(entry.key),
      // Canonical, from the PERSISTED key set. `entry.files || []` hands `engineDownload` the
      // persisted shape under a field name it reads as the open shape.
      files: toDriveFileRefs(entry.files),
      shareName: entry.name,
    };
    const swarm = attachHostSwarm(session, await swarmKeyPairFor(driveId, entry.storagePath));
    session.swarm = swarm;

    activeDrives.set(driveId, session);
    // Live per-block progress on a grab that did not come
    // through `engineOpenDrive`. Without this the transfer shows no movement.
    ensureDownloadTracking(session);

    setDriveState(entry, DriveState.ACTIVE, "engineActivateDrive: swarm attached");
    entry.lastActivityAt = Date.now();
    // Same single-write reasoning as the reuse path above.
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

// Tear down the swarm and drive session but keep storage and the manifest entry intact. Distinct
// from engineStopDrive({purge:true}), which is the destructive Delete path.
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

  // A re-share is not torn down by a preview closing. The refusal is narrow: received origin, a
  // persisted `reshared === true`, and a swarm actually in server mode.
  const dEntry = manifest.drives?.[driveId];
  if (
    (dEntry?.origin || "hosted") === "received" &&
    dEntry?.reshared === true &&
    currentSwarmMode(session) === "server"
  ) {
    binfo(
      "engine.state",
      `deactivate drive=${driveId} REFUSED — a re-shared received drive is announcing; ` +
        `a preview closing must not stop it`,
    );
    return { ok: true, refused: "reshared", driveId, mode: "server" };
  }

  binfo("engine.state", `deactivate drive=${driveId}: tearing down session (storage preserved)`);

  // Flag, abort, settle, destroy — in that order. The teardown below closes the drive and the
  // corestore, which a still-running `engineDownload` loop is holding mid-pipe.
  if (session._dlRunning) {
    bwarn(
      "engine.state",
      `deactivate drive=${driveId} — DOWNLOAD IN FLIGHT. Stopping the loop and waiting for it ` +
        `to unwind before closing the drive; the loop emits the terminal event.`,
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
 * 64 hex chars, shaped like a real Hyperdrive key so nothing downstream can tell it apart.
 * Not cryptographic and does not need to be — it never signs anything and never reaches the wire.
 */
function fakeShareKeyHex() {
  let out = "";
  while (out.length < 64) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, 64);
}

/**
 * Destroy a hosted drive's live peer sockets and leave its swarm joined — the connection dies while
 * the host goes on announcing. Not `engineDeactivateDrive`, which tears the swarm down as well.
 */
export function engineDropPeerSockets(driveId) {
  const tracker = uploadTrackers.get(driveId);
  if (!tracker) return { ok: false, dropped: 0, reason: "no-tracker" };
  let dropped = 0;
  for (const peer of tracker.peers.values()) {
    try {
      peer.socket?.destroy?.();
      dropped++;
    } catch {
      /* already gone; the peer-disconnected handler settles it either way */
    }
  }
  binfo(
    "engine.swarm",
    `dropped ${dropped} peer socket(s) drive=${driveId} - swarm stays joined`,
  );
  return { ok: true, dropped };
}

/**
 * Simulate a sustained download. Writes a real `origin: "received"` manifest entry so the
 * shareKey index resolves it genuinely; `simulated: true` makes `engineHydrateDrives` skip it.
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

  // `??` throughout: every one of these clamps with `Math.max(0, …)`, so zero is in range and
  // carries meaning. `|| <default>` would discard a deliberate zero.
  const holdAtPercent = Math.max(0, Math.min(100, Number(opts.holdAtPercent ?? 0)));
  const stallAtMs = Math.max(0, Number(opts.stallAtMs ?? 0));
  const stallDurationMs = Math.max(0, Number(opts.stallDurationMs ?? 0));
  const peerDropAtMs = Math.max(0, Number(opts.peerDropAtMs ?? 0));

  const driveId = opts.__driveId ? String(opts.__driveId) : generateDriveId("fakedl");
  const shareKey = opts.__shareKey ? String(opts.__shareKey) : fakeShareKeyHex();
  const shareLink = createShareLink(shareKey);

  // Worklet-side, like the upload simulation's: RN's timers are frozen while backgrounded, so an
  // RN-side delay would only fire on return and would test nothing.
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
    // The simulator writes the canonical pair too, or it would be the one drive in the manifest
    // that reads differently from every real one.
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

  // A real receive has the sender attached and the RN stall watchdog reads `peersConnected`,
  // so emitting it keeps the simulated transfer's shape identical to a real one.
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
    // A receive-path producer, so it emits `download-outcome` rather than `upload-complete`.
    // A simulation that ran to the end delivered everything it pretended to, so nothing failed.
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

  // Mid-download stall. Silence is the point: RN's watchdog flips `stalled` after 30 s without
  // events, and a stalled download must stop holding the foreground service.
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
        // Held: keep ticking so `lastEventAt` stays fresh and the stall watchdog does not fire —
        // the row must read `Finishing…` indefinitely, which is what a stuck-at-100 download is.
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
  // `__driveId` is set only by this function's deferred re-entry, never over the wire. Reusing it
  // means the id RN got at schedule time is the one the eventual `upload-complete` carries.
  const driveId = opts.__driveId ? String(opts.__driveId) : generateDriveId("fake");

  // Delayed start, so a user can background the app before the completion lands. The timer is
  // worklet-side: RN's own timers do not fire while backgrounded, so an RN delay would test nothing.
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
  // A simulated peer counts as delivered when its own progress reaches `fileBytes`, the equivalent
  // of the real path's 95% threshold. `earlyCompletePeers` is neither consulted nor modified here.
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
  // `??`, never `||`: this clamp is `Math.max(0, …)`, so zero is in range and means "no peer
  // disconnects early". `|| 1` would discard it and shift completion onto another path.
  const earlyCompletePeers = Math.max(0, Number(opts.earlyCompletePeers ?? 1));

  const emitProgressSnapshot = () => {
    const activePeerIds = Array.from(connectedPeers);
    const activeCount = activePeerIds.length;
    const activeTransferred = activePeerIds.reduce(
      (sum, peerId) => sum + (peerProgress.get(peerId) || 0),
      0
    );
    const activeTotal = activeCount * fileBytes;
    // Same gate as the real `emitUploadProgressSnapshot`. The `: 100` is the honest percent once
    // a simulated peer has actually reached `fileBytes`.
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
    // Read BEFORE the delete, same as the real path, and carried on the event so RN's finalize
    // sees the same discriminator from the simulator that it sees from a real host.
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
