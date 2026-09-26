import {
  engineInit,
  engineIsReady,
  engineSetEmit,
  engineShareFromPaths,
  engineOpenDrive,
  engineAbortOpen,
  engineDownload,
  engineCancelTransfer,
  engineStopDrive,
  engineStatus,
  engineListDrives,
  engineActivateDrive,
  engineDeactivateDrive,
  engineRemoveDrive,
  engineCheckFiles,
  engineFakeUploadTest,
  engineFakeDownloadTest,
  engineRefreshSwarm,
} from "./hyperdrive-engine.mjs";
import { EngineError, wrapError } from "./engine-errors.mjs";

let storedBaseDir = null;
let bridgeStarted = false;

// Wrap any thrown value in an EngineError before returning the failure shape
// to the RPC layer. The engine's own typed errors pass through untouched.
function bridgeFailure(err) {
  return {
    ok: false,
    error: wrapError(err, {
      category: "bridge.unexpected",
      cause: "bridge-unexpected",
    }),
  };
}

/**
 * `idleHostGraceMs` is passed straight through to `engineInit`. Not defaulted
 * and not validated here: the engine validates it at the boundary where it
 * enters, and a second opinion in this file is a second place for the number
 * to drift.
 */
export async function bridgeStart({ baseDir, onError, emit, idleHostGraceMs } = {}) {
  if (bridgeStarted && engineIsReady()) return { ok: true, already: true };

  if (!baseDir) {
    const err = new EngineError({
      category: "bridge.invalid-arg",
      cause: "missing-basedir",
      message: "bridgeStart: baseDir required",
    });
    onError?.(err);
    throw err;
  }

  storedBaseDir = baseDir;
  engineSetEmit(emit || (() => {}));

  try {
    await engineInit(baseDir, { idleHostGraceMs });
  } catch (err) {
    const wrapped = wrapError(err, {
      category: "bridge.init-fail",
      cause: "engine-init-fail",
    });
    onError?.(wrapped);
    throw wrapped;
  }

  bridgeStarted = true;
  return { ok: true, baseDir: storedBaseDir };
}

export function bridgeStopAll() {
  bridgeStarted = false;
  return { ok: true };
}

export async function bridgeShareFromPaths(paths, relPaths, shareName) {
  try {
    return await engineShareFromPaths(paths, relPaths, shareName);
  } catch (err) {
    return bridgeFailure(err);
  }
}

export async function bridgeOpenLink(link) {
  try {
    return await engineOpenDrive(link);
  } catch (err) {
    return bridgeFailure(err);
  }
}

export function bridgeAbortOpen(driveId) {
  return engineAbortOpen(driveId ? String(driveId) : undefined);
}

export async function bridgeDownload(payload) {
  try {
    const driveId = String(payload?.driveId || "");
    const destDir = payload?.destDir ? String(payload.destDir) : undefined;
    const fileName = payload?.fileName ? String(payload.fileName) : undefined;
    // Per-file selection: optional list of entry keys. When present, only
    // those files are downloaded and `fileName` is ignored.
    const fileNames = Array.isArray(payload?.fileNames)
      ? payload.fileNames.map(String).filter(Boolean)
      : undefined;
    if (!driveId) {
      return {
        ok: false,
        error: new EngineError({
          category: "drive.invalid-arg",
          cause: "drive-id-required",
          message: "driveId required (open the link first).",
        }),
      };
    }
    return await engineDownload(driveId, destDir, fileName, fileNames);
  } catch (err) {
    return bridgeFailure(err);
  }
}

/** cancel in flight. Never purges — see engineCancelTransfer. */
export async function bridgeCancelTransfer(driveId) {
  try {
    return await engineCancelTransfer(String(driveId || ""));
  } catch (err) {
    return bridgeFailure(err);
  }
}

export async function bridgeStopDrive(driveId, opts = {}) {
  try {
    return await engineStopDrive(String(driveId || ""), opts);
  } catch (err) {
    return bridgeFailure(err);
  }
}

export function bridgeStatus() {
  return {
    ...engineStatus(),
    baseDir: storedBaseDir,
  };
}

export function bridgeListDrives() {
  return { drives: engineListDrives() };
}

export async function bridgeDeactivateDrive(driveId) {
  try {
    return await engineDeactivateDrive(String(driveId || ""));
  } catch (err) {
    return bridgeFailure(err);
  }
}

/**
 * `opts.serve` is the explicit announce opt-in, normalised here to a boolean
 * or undefined. The difference is load-bearing: `undefined` means the caller
 * expressed no preference and the engine applies its origin-derived default (a
 * received drive stays client-only). Coercing an absent flag to `false` looks
 * identical for a received drive and silently stops a hosted drive announcing.
 */
export async function bridgeActivateDrive(driveId, opts) {
  try {
    const serve = typeof opts?.serve === "boolean" ? opts.serve : undefined;
    return await engineActivateDrive(String(driveId || ""), { serve });
  } catch (err) {
    return bridgeFailure(err);
  }
}

export async function bridgeRemoveDrive(driveId, opts) {
  try {
    return await engineRemoveDrive(String(driveId || ""), opts || {});
  } catch (err) {
    return bridgeFailure(err);
  }
}

export function bridgeCheckFiles(driveId) {
  return engineCheckFiles(String(driveId || ""));
}

export function bridgeFakeUploadTest(opts) {
  return engineFakeUploadTest(opts || {});
}

/** receive-side counterpart. */
export function bridgeFakeDownloadTest(opts) {
  return engineFakeDownloadTest(opts || {});
}

export async function bridgeRefreshSwarm() {
  try {
    return await engineRefreshSwarm();
  } catch (err) {
    return bridgeFailure(err);
  }
}
