// backend-side (Bare worklet) logging.
//
// The worklet does NOT write the log file. Two realms appending to one
// path with no lock produces interleaved, torn lines. Instead every line
// is shipped over the existing RPC event channel as
// `{type:"log", level, tag, msg, at}`; BackendProvider on the RN side
// hands it to the single file writer (src/lib/debugLog.ts).
//
// This supersedes the vestigial `{type:"debug", where, msg}` member of the
// BackendEvent union, which was declared in src/state/types.ts but never
// emitted and never handled.
//
// Gated by a flag pushed down from RN (RPC_SET_DEBUG_LOGGING). Off by
// default and off means off: `blog` returns before it does any string
// work, so instrumenting a hot loop costs one boolean test per call.
//
// Import-safety: this module imports nothing from the engine (in
// particular not engine-errors.mjs, which imports *this*), so there is no
// cycle.

let emitLog = () => {};
let enabled = false;

/** Wire the emitter. Called once from backend.mjs at RPC construction. */
export function setLogEmit(fn) {
  emitLog = typeof fn === "function" ? fn : () => {};
}

/** Flip the flag. Pushed from RN whenever the Settings toggle changes. */
export function setLogEnabled(value) {
  enabled = !!value;
}

export function isLogEnabled() {
  return enabled;
}

/** Mirror of the RN-side per-entry clamp — one payload can't flood the wire. */
const MAX_MSG = 2000;

function clamp(s) {
  const str = String(s ?? "");
  return str.length <= MAX_MSG ? str : `${str.slice(0, MAX_MSG - 13)}…[truncated]`;
}

export function blog(level, tag, msg) {
  if (!enabled) return;
  try {
    emitLog({
      type: "log",
      level,
      tag: String(tag || "backend"),
      msg: clamp(msg),
      at: Date.now(),
    });
  } catch {
    // Never let instrumentation break the path it's instrumenting.
  }
}

export const bdebug = (tag, msg) => blog("debug", tag, msg);
export const binfo = (tag, msg) => blog("info", tag, msg);
export const bwarn = (tag, msg) => blog("warn", tag, msg);
export const berror = (tag, msg) => blog("error", tag, msg);

/**
 * Render a structured EngineError (or any thrown value) preserving
 * category / cause / detail rather than flattening to `.message`. The
 * whole point of the Sprint 5I B4 fix.
 */
export function describeError(err) {
  if (err == null) return "";
  if (typeof err !== "object") return String(err);
  const parts = [];
  if (err.category) parts.push(`category=${err.category}`);
  if (err.cause) parts.push(`cause=${err.cause}`);
  if (err.message) parts.push(`message=${JSON.stringify(String(err.message))}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.detail !== undefined) {
    try {
      parts.push(`detail=${JSON.stringify(err.detail)}`);
    } catch {
      parts.push("detail=[unserializable]");
    }
  }
  if (parts.length === 0) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return parts.join(" ");
}

/**
 * Log a best-effort `catch {}` that would otherwise be a blind spot.
 *
 * The engine is full of legitimate swallowed catches (cleanup steps,
 * manifest saves, socket teardown). Each is correct and each was
 * invisible. `swallowed()` keeps the behaviour and records the fact.
 */
export function swallowed(tag, what, err) {
  if (!enabled) return;
  blog("warn", tag, `swallowed: ${what} — ${describeError(err)}`);
}
