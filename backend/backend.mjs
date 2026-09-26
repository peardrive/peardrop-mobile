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
  RPC_HYPERDRIVE_CANCEL,
  RPC_HYPERDRIVE_STATUS,
  RPC_DRIVES_LIST,
  RPC_DRIVES_PAUSE,
  RPC_DRIVES_RESUME,
  RPC_DRIVES_REMOVE,
  RPC_DRIVES_CHECK_FILES,
  RPC_TEST_FAKE_UPLOAD,
  RPC_TEST_FAKE_DOWNLOAD,
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
  bridgeCancelTransfer,
  bridgeStopDrive,
  bridgeStatus,
  bridgeListDrives,
  bridgeDeactivateDrive,
  bridgeActivateDrive,
  bridgeRemoveDrive,
  bridgeCheckFiles,
  bridgeFakeUploadTest,
  bridgeFakeDownloadTest,
  bridgeRefreshSwarm,
} from "./bridge.mjs";
import { wrapError } from "./engine-errors.mjs";

const { IPC } = BareKit;

// Extract a display-safe string from a structured res.error so the
// `emit({type:"error", message: ...})` sideband keeps carrying a plain string.
function messageOf(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object" && typeof err.message === "string") return err.message;
  return String(err);
}

// Last line of defence for the top-level RPC handler catches. The bridge
// already types anything that bubbles out of the engine, so this fires only
// for programmer errors.
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
      case RPC_HYPERDRIVE_CANCEL:
        return onHyperdriveCancel(req);
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
      case RPC_TEST_FAKE_DOWNLOAD:
        return onTestFakeDownload(req);
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

// The worklet never touches the log file: it ships lines over this same event
// channel and the RN side does the single write. Wired once, as `rpc` exists.
setLogEmit(emit);

// Only a timer inside the worklet can answer whether this realm keeps executing off screen.
// It needs both the debug-logging flag and `heartbeat`, and must not depend on the engine.
const HEARTBEAT_INTERVAL_MS = 2000;

let heartbeatTimer = null;
let heartbeatSeq = 0;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatSeq = 0;
  heartbeatTimer = setInterval(() => {
    try {
      // `n` is monotonic within one enable→disable run; `at` is the worklet's
      // own clock, and a gap in `at` differs from a gap in arrival time.
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
 * Push the debugging flag down from RN. Fire-and-forget on the RN side, but
 * the reply still happens so `invoke()` has something to resolve on.
 */
function onSetDebugLogging(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const next = !!body.enabled;
    setLogEnabled(next);
    // Emitted after the flag flips so the "enabled" line itself is logged.
    binfo("backend", `debug logging ${next ? "ENABLED" : "disabled"} in worklet realm`);

    // Needs both flags. Debug logging is a shipping user feature, so gating
    // the heartbeat on it alone starts a 2 s IPC timer for any release user
    // who enables Debugging. This realm has no build-type constant, so the
    // RN side owns that decision; an absent `heartbeat` means off.
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
    // The body carries RN's own idle-host grace so the worklet can expire that
    // window in the realm that keeps running while the app is backgrounded.
    // Same `JSON.parse(… || "{}")` idiom as every other handler here, so an
    // empty body from an older RN half parses to `{}` and the engine never
    // sweeps.
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    await bridgeStart({
      baseDir: base,
      idleHostGraceMs: body.idleHostGraceMs,
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
    // The user's chosen name, passed through as-is: the engine validates it
    // with the same functions it uses on a peer's title, so the guard lives in
    // one place rather than being duplicated per caller.
    const shareName = body.shareName == null ? undefined : String(body.shareName);
    const res = await bridgeShareFromPaths(paths, relPaths, shareName);
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

/**
 * There is no `purge` in the body and no way to add one: cancelling never
 * destroys storage. The distinction from RPC_HYPERDRIVE_STOP is the point of
 * the opcode.
 */
async function onHyperdriveCancel(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const res = await bridgeCancelTransfer(String(body.driveId || ""));
    req.reply(b4a.from(JSON.stringify(res), "utf8"));
  } catch (err) {
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
    // The `serve` announce opt-in, read with `=== true` / `=== false` rather
    // than coerced, because three states have to survive the wire: announce,
    // do not announce, and no opinion. An older RN build sends no flag at all,
    // and that keeps meaning "use the engine's origin-derived default" — the
    // same rule opcode 33's `heartbeat` follows.
    const serve =
      body.serve === true ? true : body.serve === false ? false : undefined;
    const res = await bridgeActivateDrive(driveId, { serve });
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

function onTestFakeDownload(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const res = bridgeFakeDownloadTest(body || {});
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
