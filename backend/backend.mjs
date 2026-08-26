import b4a from "b4a";
import RPC from "bare-rpc";

import {
  RPC_EVENT,
  RPC_LISTEN,
  RPC_HYPERDRIVE_SHARE,
  RPC_HYPERDRIVE_STOP,
  RPC_HYPERDRIVE_OPEN,
  RPC_HYPERDRIVE_ABORT,
  RPC_HYPERDRIVE_DOWNLOAD,
  RPC_HYPERDRIVE_STATUS,
  RPC_DRIVES_LIST,
  RPC_DRIVES_PAUSE,
  RPC_DRIVES_RESUME,
  RPC_DRIVES_REMOVE,
  RPC_DRIVES_CHECK_FILES,
  RPC_TEST_FAKE_UPLOAD,
  RPC_REFRESH_SWARM,
  RPC_SET_DEBUG_LOGGING,
} from "../rpc-commands.mjs";
import { setLogEmit, setLogEnabled, binfo } from "./debug-log.mjs";

import { getBaseDir } from "./config.mjs";
import {
  bridgeStart,
  bridgeShareFromPaths,
  bridgeOpenLink,
  bridgeAbortOpen,
  bridgeDownload,
  bridgeStopDrive,
  bridgeStatus,
  bridgeListDrives,
  bridgeDeactivateDrive,
  bridgeActivateDrive,
  bridgeRemoveDrive,
  bridgeCheckFiles,
  bridgeFakeUploadTest,
  bridgeRefreshSwarm,
} from "./bridge.mjs";
import { wrapError } from "./engine-errors.mjs";

const { IPC } = BareKit;

// Extract a display-safe string from a structured res.error
// so the `emit({type:"error", message: ...})` sideband keeps carrying a
// plain string (RN treats event.message as text). Falls back to the
// object's toString if it lacks a .message field.
function messageOf(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object" && typeof err.message === "string") return err.message;
  return String(err);
}

// Last-line-of-defense wrapper for the top-level RPC handler
// catches. The bridge already produces typed errors for anything that
// bubbles out of the engine; this fires only for programmer errors
// (unknown state, opcode-level bugs).
function outerCatchReply(err) {
  return JSON.stringify({
    ok: false,
    error: wrapError(err, {
      category: "internal.rpc",
      cause: "rpc-unexpected",
    }),
  });
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ type: "error", message: "event serialize failed" });
  }
}

const rpc = new RPC(IPC, async (req) => {
  try {
    switch (req.command) {
      case RPC_LISTEN:
        return onListen(req);
      case RPC_HYPERDRIVE_SHARE:
        return onHyperdriveShare(req);
      case RPC_HYPERDRIVE_STOP:
        return onHyperdriveStop(req);
      case RPC_HYPERDRIVE_OPEN:
        return onHyperdriveOpen(req);
      case RPC_HYPERDRIVE_ABORT:
        return onHyperdriveAbort(req);
      case RPC_HYPERDRIVE_DOWNLOAD:
        return onHyperdriveDownload(req);
      case RPC_HYPERDRIVE_STATUS:
        return onHyperdriveStatus(req);
      case RPC_DRIVES_LIST:
        return onDrivesList(req);
      case RPC_DRIVES_PAUSE:
        return onDrivesPause(req);
      case RPC_DRIVES_RESUME:
        return onDrivesResume(req);
      case RPC_DRIVES_REMOVE:
        return onDrivesRemove(req);
      case RPC_DRIVES_CHECK_FILES:
        return onDrivesCheckFiles(req);
      case RPC_TEST_FAKE_UPLOAD:
        return onTestFakeUpload(req);
      case RPC_REFRESH_SWARM:
        return onRefreshSwarm(req);
      case RPC_SET_DEBUG_LOGGING:
        return onSetDebugLogging(req);
      default:
        return;
    }
  } catch (err) {
    emit({ type: "error", message: String(err?.stack || err?.message || err) });
    try {
      req.reply(b4a.from("error"));
    } catch {}
  }
});

function emit(payload) {
  const request = rpc.request(RPC_EVENT);
  request.send(safeJson(payload));
}

// The worklet never touches the log file — it ships lines over
// this same event channel and the RN side does the single write. Wired
// once here, immediately after `rpc` exists.
setLogEmit(emit);

// ---------------------------------------------------------------------
// Worklet liveness heartbeat
// ---------------------------------------------------------------------
//
// The question: does this worklet keep executing while the app is off
// screen? bare-kit's module-scope AppState listener calls `suspend()` on
// background, and what that does to the Bare event loop is implemented in
// a prebuilt AAR — source cannot answer it. A timer that ticks from
// inside the worklet can.
//
// It lives HERE rather than in hyperdrive-engine.mjs because the engine's
// `emitEvent` is only wired by `bridgeStart` (i.e. after RPC_LISTEN),
// whereas `emit` above exists from RPC construction. Liveness is a
// property of the worklet, not of the engine, so the probe must not
// depend on the engine having started.
//
// Gated on a `heartbeat` flag carried alongside the debug-logging flag on
// the same opcode. Requires both, and RN only sets `heartbeat` in
// development builds.
//
// Payload is deliberately two numbers. At 2 s this emits 300 events over
// a ten-minute background run; anything larger would be paying rent.
const HEARTBEAT_INTERVAL_MS = 2000;

let heartbeatTimer = null;
let heartbeatSeq = 0;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatSeq = 0;
  heartbeatTimer = setInterval(() => {
    try {
      // `n` is monotonic within one enable→disable run; `at` is the
      // WORKLET's own clock. The RN side stamps its receive time
      // separately — a gap in `at` and a gap in arrival mean different
      // things (engine stopped vs IPC queued).
      emit({ type: "worklet-tick", n: ++heartbeatSeq, at: Date.now() });
    } catch {
      // A dead IPC must not take the worklet down; the missing tick is
      // itself the observation.
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatSeq = 0;
}

/**
 * Push the debugging flag down from RN. Fire-and-forget from the RN side;
 * we still reply so `invoke()` has something to resolve on.
 */
function onSetDebugLogging(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const next = !!body.enabled;
    setLogEnabled(next);
    // Emitted after the flag flips so the "enabled" line itself is logged.
    binfo("backend", `debug logging ${next ? "ENABLED" : "disabled"} in worklet realm`);

    // Needs BOTH flags. Debug logging is a shipping user feature, so gating
    // the heartbeat on it alone starts a 2 s IPC timer for any release user
    // who enables Debugging. This realm has no build-type constant, so the
    // RN side owns that decision; an absent `heartbeat` must mean off.
    const heartbeat = next && !!body.heartbeat;
    if (heartbeat) startHeartbeat();
    else stopHeartbeat();
    req.reply(
      b4a.from(JSON.stringify({ ok: true, enabled: next, heartbeat }), "utf8"),
    );
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onListen(req) {
  try {
    const base = getBaseDir();
    await bridgeStart({
      baseDir: base,
      onError: (err) => emit({ type: "error", message: messageOf(err) }),
      emit,
    });

    emit({ type: "listening" });
    req.reply(b4a.from("ok"));
  } catch (err) {
    emit({ type: "error", message: messageOf(err) });
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onHyperdriveShare(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    const relPaths = Array.isArray(body.relPaths)
      ? body.relPaths.map((p) => (p == null ? "" : String(p)))
      : undefined;
    const res = await bridgeShareFromPaths(paths, relPaths);
    if (!res.ok) emit({ type: "error", message: messageOf(res.error) || "share failed" });
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    emit({ type: "error", message: messageOf(err) });
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onHyperdriveStop(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const driveId = String(body.driveId || "");
    const purge = body.purge !== false;
    const res = await bridgeStopDrive(driveId, { purge });
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onHyperdriveOpen(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const link = String(body.link || "").trim();
    const res = await bridgeOpenLink(link);
    if (!res.ok) emit({ type: "error", message: messageOf(res.error) || "open failed" });
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    emit({ type: "error", message: messageOf(err) });
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

function onHyperdriveAbort(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const driveId = body.driveId != null ? String(body.driveId) : undefined;
    const res = bridgeAbortOpen(driveId);
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onHyperdriveDownload(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const res = await bridgeDownload(body);
    if (!res.ok) emit({ type: "error", message: messageOf(res.error) || "download failed" });
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    emit({ type: "error", message: messageOf(err) });
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

function onHyperdriveStatus(req) {
  const status = bridgeStatus();
  req.reply(b4a.from(JSON.stringify({ ok: true, status }), "utf8"));
}

function onDrivesList(req) {
  const { drives } = bridgeListDrives();
  req.reply(b4a.from(JSON.stringify({ ok: true, drives }), "utf8"));
}

async function onDrivesPause(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const driveId = String(body.driveId || body.id || "");
    const res = await bridgeDeactivateDrive(driveId);
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onDrivesResume(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const driveId = String(body.driveId || body.id || "");
    const res = await bridgeActivateDrive(driveId);
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onDrivesRemove(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const res = await bridgeRemoveDrive(String(body.driveId || body.id || ""), body.opts || {});
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

function onDrivesCheckFiles(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const res = bridgeCheckFiles(String(body.id || ""));
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

function onTestFakeUpload(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const res = bridgeFakeUploadTest(body || {});
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}

async function onRefreshSwarm(req) {
  try {
    const res = await bridgeRefreshSwarm();
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
    req.reply(b4a.from(outerCatchReply(err), "utf8"));
  }
}
