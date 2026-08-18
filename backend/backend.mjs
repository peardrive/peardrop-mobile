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

// The emit({type:"error"}) sideband must carry a plain string — RN treats
// event.message as text, not a structured error.
function messageOf(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object" && typeof err.message === "string") return err.message;
  return String(err);
}

// The bridge already types anything bubbling out of the engine, so this
// fires only for opcode-level programmer errors.
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

// Log lines ride the same event channel; wired once, right after `rpc` exists.
setLogEmit(emit);

/**
 * Push the debugging flag down from RN. Fire-and-forget on the RN side, but
 * still replies so `invoke()` has something to resolve on.
 */
function onSetDebugLogging(req) {
  try {
    const body = JSON.parse(b4a.toString(req.data || b4a.alloc(0), "utf8") || "{}");
    const next = !!body.enabled;
    setLogEnabled(next);
    // Emitted after the flag flips so the "enabled" line itself is logged.
    binfo("backend", `debug logging ${next ? "ENABLED" : "disabled"} in worklet realm`);
    req.reply(b4a.from(JSON.stringify({ ok: true, enabled: next }), "utf8"));
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
