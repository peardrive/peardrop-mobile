import {
  engineInit,
  engineIsReady,
  engineSetEmit,
  engineShareFromPaths,
  engineOpenDrive,
  engineAbortOpen,
  engineDownload,
  engineStopDrive,
  engineStatus,
  engineListDrives,
  engineActivateDrive,
  engineDeactivateDrive,
  engineRemoveDrive,
  engineCheckFiles,
  engineFakeUploadTest,
  engineRefreshSwarm,
} from "./hyperdrive-engine.mjs";
import { EngineError, wrapError } from "./engine-errors.mjs";

let storedBaseDir = null;
let bridgeStarted = false;

// wrap any thrown value in an EngineError before returning
// the failure shape to the RPC layer. `bridge.unexpected` catches
// programmer errors that leak past the engine's own typed sites; the
// engine's typed errors pass through untouched (wrapError is a no-op).
function bridgeFailure(err) {
  return {
    ok: false,
    error: wrapError(err, {
      category: "bridge.unexpected",
      cause: "bridge-unexpected",
    }),
  };
}

export async function bridgeStart({ baseDir, onError, emit } = {}) {
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
    await engineInit(baseDir);
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

export async function bridgeShareFromPaths(paths, relPaths) {
  try {
    return await engineShareFromPaths(paths, relPaths);
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

export async function bridgeActivateDrive(driveId) {
  try {
    return await engineActivateDrive(String(driveId || ""));
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

export async function bridgeRefreshSwarm() {
  try {
    return await engineRefreshSwarm();
  } catch (err) {
    return bridgeFailure(err);
  }
}
