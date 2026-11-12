// Last line of defence for the worklet. Imported FIRST by backend.mjs, so it is installed before
// any other module evaluates — including native addons that can fail to load.
//
// Without a listener, Bare aborts the whole app on an uncaught exception or unhandled rejection,
// and the user is left with a crash and no record of why. With one, the error is:
//   1. sent to the RN log like any other error line (debug-log.mjs holds it until RN is wired), and
//   2. appended to `<Documents>/peardrop-crash.log` straight from here, because a failure during
//      boot can stop RN from ever receiving it. RN folds that file into the log on next launch
//      (src/lib/debugLog.ts importWorkletCrashes) and deletes it.
// The worklet keeps running: one failed task must not take down every transfer and the UI.
//
// No static imports beyond debug-log.mjs (pure JS): a broken native addon must not take this
// module down with it.

import { blog } from "./debug-log.mjs";

const CRASH_FILE = "peardrop-crash.log";

function render(kind, err) {
  let text;
  if (err && typeof err === "object") {
    text = `${err.name || "Error"}: ${err.message || ""}\n${err.stack || ""}`;
    if (err.cause) text += `\ncause: ${err.cause && err.cause.stack ? err.cause.stack : String(err.cause)}`;
  } else {
    text = String(err);
  }
  return `${new Date().toISOString()} [${kind}] ${text}`.slice(0, 8000);
}

async function writeCrashFile(line) {
  try {
    const root = String((globalThis.Bare && Bare.argv && Bare.argv[0]) || "").trim();
    if (!root) return;
    const { default: fs } = await import("bare-fs");
    fs.appendFileSync(`${root}/${CRASH_FILE}`, `${line}\n`);
  } catch {
    // bare-fs itself may be the addon that failed to load; the RN log line is the fallback.
  }
}

function report(kind, err) {
  const line = render(kind, err);
  try {
    blog("error", "crash", line);
  } catch {}
  void writeCrashFile(line);
}

if (globalThis.Bare && typeof Bare.on === "function") {
  Bare.on("uncaughtException", (err) => report("uncaught exception", err));
  Bare.on("unhandledRejection", (reason) => report("unhandled rejection", reason));
}
