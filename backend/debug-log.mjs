// Backend-side (Bare worklet) logging.
//
// The worklet does not write the log file: two realms appending to one path
// with no lock produce interleaved, torn lines. Every line ships over the RPC
// event channel and the RN side hands it to the single file writer.
//
// Gated by a flag pushed down from RN, off by default: `blog` returns before any
// string work. This module imports nothing from the engine, so there is no cycle.

let emitLog = () => {};
let enabled = false;
/**
 * Has the flag ever arrived from RN? One-way, unlike `enabled`, which goes
 * false again when the user toggles Debugging off. It separates the two
 * reasons a line can be missing from an export: Debugging was never turned on,
 * or the flag had not arrived yet when the line was written.
 */
let everEnabled = false;
/** Lines `blog`/`swallowed` refused because the flag had not arrived yet. */
let droppedBeforeFlag = 0;

/**
 * Count one refused line, but only while the flag has never arrived. Shaped so
 * `blog` still returns before it does any string work, which is the
 * load-bearing part. Once the flag has arrived, this is a single boolean test
 * and never touches the counter again.
 */
function countRefused() {
  if (!everEnabled) droppedBeforeFlag++;
}

/** Wire the emitter. Called once from backend.mjs at RPC construction. */
export function setLogEmit(fn) {
  emitLog = typeof fn === "function" ? fn : () => {};
}

/**
 * Flip the flag. Pushed from RN whenever the Settings toggle changes.
 *
 * On the first rising edge, report how many lines were refused before the flag
 * arrived. A non-zero count is the signature of the boot race: `RPC_LISTEN` →
 * `engineInit` → `loadManifest` running before `RPC_SET_DEBUG_LOGGING` lands,
 * so `manifest loaded` is never emitted and its absence says nothing about
 * eviction. This line is how an export proves the RN-side ordering held.
 */
export function setLogEnabled(value) {
  const next = !!value;
  const rising = next && !everEnabled;
  enabled = next;
  if (next) everEnabled = true;
  if (rising) {
    blog(
      "warn",
      "debug-log",
      `flag arrived: pre-flag lines dropped=${droppedBeforeFlag} ` +
        `(non-zero means the worklet logged before RN told it the flag — ` +
        `absence of engine.boot lines is NOT eviction)`,
    );
  }
}

export function isLogEnabled() {
  return enabled;
}

/** How many lines were refused before the flag ever arrived. Never resets. */
export function droppedBeforeFlagCount() {
  return droppedBeforeFlag;
}

/** Whether the flag has ever arrived from RN. */
export function hasLogFlagArrived() {
  return everEnabled;
}

/** Mirror of the RN-side per-entry clamp — one payload can't flood the wire. */
const MAX_MSG = 2000;

function clamp(s) {
  const str = String(s ?? "");
  return str.length <= MAX_MSG ? str : `${str.slice(0, MAX_MSG - 13)}…[truncated]`;
}

export function blog(level, tag, msg) {
  if (!enabled) {
    countRefused();
    return;
  }
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
 * category / cause / detail rather than flattening to `.message`.
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
 * Log a best-effort `catch {}` that would otherwise be a blind spot. The
 * engine has many legitimate swallowed catches — cleanup steps, manifest
 * saves, socket teardown — and each one is correct but invisible. This keeps
 * the behaviour and records the fact.
 */
export function swallowed(tag, what, err) {
  if (!enabled) {
    countRefused();
    return;
  }
  blog("warn", tag, `swallowed: ${what} — ${describeError(err)}`);
}
