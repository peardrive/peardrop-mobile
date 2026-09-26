import { AppState, type AppStateStatus } from "react-native";
import RNFS from "react-native-fs";
import * as Sharing from "expo-sharing";

import {
  MAX_LOG_BYTES,
  buildBundle,
  buildLogFilename,
  formatEntry,
  formatStructuredError,
  shouldRotate,
  stringifyDetail,
  type LogLevel,
} from "./debugLogFormat";
import {
  isDebugLoggingEnabledSync,
  subscribeDebugLogging,
} from "../state/debugLogStorage";
import { buildIdentity, describeBuild } from "./devGate";

/**
 * The single file writer. RN calls `log()` directly; the Bare backend ships
 * its lines over the RPC event channel and `logFromBackend()` feeds them in
 * here. The file is never written from the worklet — two realms appending to
 * one path with no lock produce interleaved, torn lines. Write policy is
 * buffer + flush. Flag OFF means off: no buffer, no timer, no file handle.
 */

const LIVE_PATH = `${RNFS.DocumentDirectoryPath}/peardrop-debug.log`;
const ROTATED_PATH = `${RNFS.DocumentDirectoryPath}/peardrop-debug.log.1`;
/** Where a "cleared" log goes. Rotate-not-delete: clearing is recoverable. */
const EXPORTED_PATH = `${RNFS.DocumentDirectoryPath}/peardrop-debug.log.exported`;

/** Flush cadence. Short enough that a crash loses ~1 s, long enough to coalesce. */
const FLUSH_INTERVAL_MS = 1000;
/** Flush early if the buffer reaches this many entries (burst protection). */
const FLUSH_AT_ENTRIES = 64;
/** …or this many buffered bytes, whichever comes first. Entries are capped at
 *  ~2 KB each, so an entry-count threshold alone could hold ~128 KB between
 *  ticks; this bounds the buffer by size as well as count. */
const FLUSH_AT_BYTES = 32 * 1024;
/** Re-stat the live file every N flushes to correct any drift in our counter. */
const STAT_RECONCILE_EVERY = 32;

/** The priority class. Eviction is whole-segment and oldest-first, so the
 *  lines that make a log readable go first; the last line of each priority
 *  kind is re-written into the head of each new segment. Classification is by
 *  tag, so no call site can forget it, and every error qualifies. */
const PRIORITY_TAGS = new Set<string>([
  // Session boundary + identity (src/lib/debugLog.ts applyEnabled, deviceIdentity.ts)
  "debug",
  "build",
  "device",
  // Backend/app state transitions (src/state/backend.ts, every setStatus site)
  "rn.state",
  // Foreground-service decision and outcome
  "rn.fgs",
  "rn.probe.oem",
  // Freeze window, verdict and attribution
  "rn.freeze",
  "rn.freeze.attr",
  // Fallback ladder
  "rn.fallback",
  "rn.fallback.forced",
  "rn.bgsettings",
  "rn.autostart",
  // Boot recovery
  "rn.reconcile",
  // Resolve start/end with a peer count
  "rn.resolve",
  // Worklet realm (logFromBackend prefixes `be:`)
  "be:engine.boot",
  "be:engine.hydrate",
]);

/** How many distinct priority kinds are carried forward. Bounds the
 *  carry-forward block at `PRIORITY_MAX_KINDS × MAX_ENTRY_BYTES`. When the map
 *  is full, new kinds are dropped and existing ones kept, which biases
 *  retention toward the earliest kinds — exactly the prologue. */
const PRIORITY_MAX_KINDS = 128;

/** Distinct keys the change gate tracks. One per drive, and drives are bounded. */
const CHANGE_GATE_MAX_KEYS = 64;

/** How long a change-gated line may be suppressed before one is forced. A
 *  line that is never re-emitted turns a quiet transfer into no evidence at
 *  all, and staying under `DEFAULT_STALL_MS` lets a reader tell "idle" from
 *  "the log stopped". No timer: the comparison runs when an event arrives. */
export const CHANGE_GATE_HEARTBEAT_MS = 30_000;

let enabled = false;
let buffer: string[] = [];
let bufferBytes = 0;
let liveBytes = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> = Promise.resolve();
let flushCount = 0;
let appStateSub: { remove: () => void } | null = null;
let initialized = false;
/** Last rendered line per priority kind — the carry-forward set. */
let priorityByKind: Map<string, string> = new Map();
/** Rotations this session, so the carry-forward marker says which one it follows. */
let rotations = 0;
/** Per-key state for `logChangeGated`. */
const changeGates: Map<string, { signature: string; at: number }> = new Map();
/** BLAKE2b content hash of the packed worklet bundle, once someone parses it. */
let workletBundleId: string | null = null;

// Hot path

/** Record one entry. No-ops when debugging is off, which is what makes "flag
 *  OFF = zero overhead" true and lets every call site stay unconditional. */
export function log(level: LogLevel, tag: string, msg: string): void {
  if (!enabled) return;
  push(formatEntry(Date.now(), level, tag, msg), level, tag, msg);
}

/** Record one entry only when it says something new. `signature` decides
 *  "changed" and `msg` is what gets written: the progress line carries live
 *  byte counters that change on every event, so gating on the rendered message
 *  would suppress nothing. Returns whether a line was written. */
export function logChangeGated(
  level: LogLevel,
  tag: string,
  key: string,
  signature: string,
  msg: string,
  now: number = Date.now()
): boolean {
  if (!enabled) return false;
  const k = String(key);
  const sig = String(signature);
  const prev = changeGates.get(k);
  if (prev && prev.signature === sig) {
    const elapsed = now - prev.at;
    // A non-finite or backwards elapsed time means the clock moved; writing is
    // the safe direction, since the alternative wedges the line off silently.
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < CHANGE_GATE_HEARTBEAT_MS) {
      return false;
    }
  }
  if (!prev && changeGates.size >= CHANGE_GATE_MAX_KEYS) {
    // Bounded: evict the oldest key. Map iteration order is insertion order.
    const oldest = changeGates.keys().next().value;
    if (oldest !== undefined) changeGates.delete(oldest);
  }
  changeGates.set(k, { signature: sig, at: now });
  push(formatEntry(now, level, tag, msg), level, tag, msg);
  return true;
}

/** Forget a change-gate key, so the next line for it always writes. */
export function resetChangeGate(key: string): void {
  changeGates.delete(String(key));
}

export const logDebug = (tag: string, msg: string) => log("debug", tag, msg);
export const logInfo = (tag: string, msg: string) => log("info", tag, msg);
export const logWarn = (tag: string, msg: string) => log("warn", tag, msg);
export const logError = (tag: string, msg: string) => log("error", tag, msg);

/** Log a structured engine error preserving category, cause and detail.
 *  Flattening to `String(err.message)` loses the taxonomy at exactly the
 *  moment it is useful; `formatStructuredError` keeps all four fields. */
export function logStructuredError(tag: string, context: string, err: unknown): void {
  if (!enabled) return;
  const rendered = formatStructuredError(err);
  const msg = `${context} — ${rendered}`;
  push(formatEntry(Date.now(), "error", tag, msg), "error", tag, msg);
}

/** Entry point for lines that originated in the Bare worklet. */
export function logFromBackend(entry: {
  level?: string;
  tag?: string;
  msg?: string;
  at?: number;
}): void {
  if (!enabled) return;
  const level = (["debug", "info", "warn", "error"].includes(String(entry.level))
    ? entry.level
    : "info") as LogLevel;
  const at = typeof entry.at === "number" ? entry.at : Date.now();
  // Backend lines already carry their own tag (e.g. "engine.open"); prefix
  // so the realm is obvious when reading a mixed stream.
  const tag = `be:${entry.tag || "backend"}`;
  const msg = String(entry.msg ?? "");
  push(formatEntry(at, level, tag, msg), level, tag, msg);
}

/** Convenience for logging arbitrary structured payloads. */
export function logValue(level: LogLevel, tag: string, label: string, value: unknown): void {
  if (!enabled) return;
  const msg = `${label} ${stringifyDetail(value)}`;
  push(formatEntry(Date.now(), level, tag, msg), level, tag, msg);
}

/** Is this entry part of the set that must outlive eviction? Pure, and
 *  exported so the classification is testable without a filesystem. */
export function isPriorityEntry(level: LogLevel, tag: string): boolean {
  if (level === "error") return true;
  return PRIORITY_TAGS.has(String(tag ?? ""));
}

/** The "kind" a priority line belongs to — one carry-forward slot per kind,
 *  last one wins. Derived from the tag plus the leading words of the message,
 *  stopping at the first token carrying a number or a `key=value` pair. Only
 *  the last line of each kind survives; earlier ones go with their segment. */
export function priorityKindOf(tag: string, msg: string): string {
  const words: string[] = [];
  for (const token of String(msg ?? "").trim().split(/\s+/)) {
    if (!token) continue;
    if (token.includes("=") || /\d/.test(token)) break;
    words.push(token);
    if (words.length === 4) break;
  }
  return `${String(tag ?? "")}::${words.join(" ")}`;
}

function push(line: string, level: LogLevel, tag: string, msg: string): void {
  if (isPriorityEntry(level, tag)) {
    const kind = priorityKindOf(tag, msg);
    // Full map: keep what is already there. Existing kinds still update, so the
    // prologue stays current; only brand-new kinds are refused.
    if (priorityByKind.has(kind) || priorityByKind.size < PRIORITY_MAX_KINDS) {
      priorityByKind.set(kind, line);
    }
  }
  buffer.push(line);
  bufferBytes += line.length + 1;
  if (buffer.length >= FLUSH_AT_ENTRIES || bufferBytes >= FLUSH_AT_BYTES) {
    void flush();
  }
}

// Flush + rotation

/** Drain the buffer to disk. Serialized through `flushing` so overlapping
 *  callers cannot interleave two appends onto the same file. */
export function flush(): Promise<void> {
  flushing = flushing.then(() => doFlush()).catch(() => {});
  return flushing;
}

async function doFlush(): Promise<void> {
  if (buffer.length === 0) return;
  const chunk = buffer.join("\n") + "\n";
  buffer = [];
  bufferBytes = 0;

  try {
    // The in-memory byte counter drifts if a write partially failed or the
    // file was touched outside this module, so re-stat periodically.
    if (flushCount % STAT_RECONCILE_EVERY === 0) {
      liveBytes = await statSize(LIVE_PATH);
    }
    flushCount++;

    if (shouldRotate(liveBytes, chunk.length, MAX_LOG_BYTES)) {
      await rotate();
    }

    await RNFS.appendFile(LIVE_PATH, chunk, "utf8");
    liveBytes += chunk.length;
  } catch {
    // A failed flush must never take the app down or spin. The entries in
    // this chunk are lost; the next flush proceeds normally.
  }
}

/** Render the carry-forward block written at the head of each new segment.
 *  Written straight to disk rather than through `push`, so it cannot
 *  re-classify itself, re-enter the buffer, or trigger another rotation. */
function renderCarryForward(): string {
  if (priorityByKind.size === 0) return "";
  const lines = [
    formatEntry(
      Date.now(),
      "warn",
      "debug",
      `---- carried forward after rotation ${rotations}: ` +
        `${priorityByKind.size} priority line(s), original timestamps ----`
    ),
    ...Array.from(priorityByKind.values()),
  ];
  return lines.join("\n") + "\n";
}

/** Roll the live file to `.1`, replacing any previous `.1`, so worst case on
 *  disk is 2 × MAX_LOG_BYTES. The priority set is re-written at the head of
 *  the new live segment: the prologue is carried forward rather than protected
 *  in place, which whole-segment rotation cannot do. */
async function rotate(): Promise<void> {
  try {
    if (await RNFS.exists(ROTATED_PATH)) await RNFS.unlink(ROTATED_PATH);
  } catch {}
  try {
    if (await RNFS.exists(LIVE_PATH)) await RNFS.moveFile(LIVE_PATH, ROTATED_PATH);
  } catch {}
  liveBytes = 0;
  rotations++;
  const carry = renderCarryForward();
  if (carry) {
    try {
      await RNFS.appendFile(LIVE_PATH, carry, "utf8");
      liveBytes += carry.length;
    } catch {
      // A failed carry-forward must not abort the rotation — the alternative is
      // a live file that never rolls and grows without bound.
    }
  }
}

async function statSize(path: string): Promise<number> {
  try {
    if (!(await RNFS.exists(path))) return 0;
    const st = await RNFS.stat(path);
    return Number(st.size) || 0;
  } catch {
    return 0;
  }
}

async function readIfPresent(path: string): Promise<string> {
  try {
    if (!(await RNFS.exists(path))) return "";
    return await RNFS.readFile(path, "utf8");
  } catch {
    return "";
  }
}

// Lifecycle

/** Subscribe to the flag. Call once at app boot. Idempotent. Everything the
 *  subsystem costs when the flag is off is this one subscription. */
export function initDebugLog(): void {
  if (initialized) return;
  initialized = true;
  subscribeDebugLogging((next) => {
    void applyEnabled(next);
  });
}

async function applyEnabled(next: boolean): Promise<void> {
  if (next === enabled) return;
  if (next) {
    enabled = true;
    liveBytes = await statSize(LIVE_PATH);
    startTimer();
    attachAppState();
    log("info", "debug", "=== debug logging enabled ===");
    // Emitted here rather than from a boot effect: this is the moment the log
    // begins to exist, and it must not be gated on the debug-build flag,
    // whose state it exists to report.
    log("warn", "build", describeBuild());
    // The worklet bundle id detects a fresh RN bundle over a stale worklet.
    // Tagged `build` so it is priority-classified and cannot be evicted.
    if (workletBundleId) {
      log("warn", "build", `worklet-bundle-id ${workletBundleId}`);
    }
  } else {
    // Falling edge: capture the closing line, drain, then tear everything
    // down so an off flag really does cost nothing.
    log("info", "debug", "=== debug logging disabled ===");
    await flush();
    enabled = false;
    stopTimer();
    detachAppState();
    buffer = [];
    bufferBytes = 0;
    // Off means off: holding the carry-forward set across an off period would
    // put the earlier session's prologue into the next one.
    priorityByKind = new Map();
    changeGates.clear();
    rotations = 0;
  }
}

function startTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (buffer.length > 0) void flush();
  }, FLUSH_INTERVAL_MS);
}

function stopTimer(): void {
  if (!flushTimer) return;
  clearInterval(flushTimer);
  flushTimer = null;
}

function attachAppState(): void {
  if (appStateSub) return;
  const onChange = (state: AppStateStatus) => {
    // Backgrounding is the most likely moment for the OS to kill us, so
    // force a drain rather than waiting on the next tick.
    if (state !== "active") void flush();
  };
  appStateSub = AppState.addEventListener("change", onChange);
}

function detachAppState(): void {
  if (!appStateSub) return;
  try {
    appStateSub.remove();
  } catch {}
  appStateSub = null;
}

export function isDebugLogEnabled(): boolean {
  return enabled;
}

// Worklet bundle identity

/** Pull the worklet bundle's content hash out of the packed artifact.
 *  `bare-pack` writes a header whose `id` is a digest over every file in the
 *  bundle, so it changes only when backend source does, which detects a fresh
 *  RN bundle over a stale worklet. Returns `null` rather than a guess. */
export function parseWorkletBundleId(packed: string): string | null {
  if (typeof packed !== "string" || packed.length === 0) return null;
  // The id sits within the first few hundred characters, so bound the search
  // rather than walking a multi-megabyte string.
  const head = packed.slice(0, 2048);
  const match = /"id"\s*:\s*"([0-9a-f]{64})"/.exec(head);
  // `match[1]` is `string | undefined` under `noUncheckedIndexedAccess`;
  // collapsing to `null` is correct rather than a cast — no group is unreadable.
  return match?.[1] ?? null;
}

/** Register the parsed id, so the export surface can state it. A setter rather
 *  than an import because `src/state/backend.ts` imports this module and the
 *  cycle would be real. Stores `null` for anything that is not a 64-hex
 *  digest: an id that is not the real one is worse than none. */
export function setWorkletBundleId(id: string | null): void {
  workletBundleId =
    typeof id === "string" && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

export function getWorkletBundleId(): string | null {
  return workletBundleId;
}

/** Re-read the persisted flag (used at boot before the first subscribe fires). */
export function syncEnabledFromStorage(): void {
  void applyEnabled(isDebugLoggingEnabledSync());
}

// Export + reset

export type LogSizes = { live: number; rotated: number; total: number };

export async function getLogSizes(): Promise<LogSizes> {
  const live = await statSize(LIVE_PATH);
  const rotated = await statSize(ROTATED_PATH);
  return { live, rotated, total: live + rotated };
}

/** Build the export bundle: both rotation segments, oldest-first, behind a
 *  header, written to the cache directory. The copy lives in cache — never the
 *  live log — so a later reset cannot touch a file the share sheet still
 *  holds, and the bundled FileProvider already grants `cache/`. */
export async function buildExportBundle(
  label: string
): Promise<{ uri: string; fileName: string; bytes: number } | null> {
  // Get everything buffered onto disk first, or the most recent (and most
  // relevant) entries would be missing from the export.
  await flush();

  const rotated = await readIfPresent(ROTATED_PATH);
  const live = await readIfPresent(LIVE_PATH);
  if (!rotated && !live) return null;

  // The header is the only never-evicted surface, so build identity belongs
  // here, and the full id — never a prefix — is what proves a matched pair.
  const contents = buildBundle(label, Date.now(), [rotated, live], {
    ...buildIdentity(),
    workletBundleId,
  });
  const fileName = buildLogFilename(label, Date.now());
  const uri = `${RNFS.CachesDirectoryPath}/${fileName}`;

  try {
    if (await RNFS.exists(uri)) await RNFS.unlink(uri);
  } catch {}
  await RNFS.writeFile(uri, contents, "utf8");

  return { uri, fileName, bytes: contents.length };
}

/** Hand the bundle to the system share sheet. Resolves on dismissal: Android
 *  reports neither the chosen target nor a cancel, so resolving says nothing
 *  about delivery, which is why runExportFlow asks the user afterwards rather
 *  than auto-clearing. Throwing here means the sheet never opened. */
export async function shareBundle(uri: string, fileName: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(uri.startsWith("file://") ? uri : `file://${uri}`, {
    mimeType: "text/plain",
    dialogTitle: `Send ${fileName}`,
    UTI: "public.plain-text",
  });
}

/** "Clear" the log by rotation, not deletion: both segments are folded into
 *  `.exported` and the live files removed, so the cleared content is still on
 *  disk and recoverable if someone clears something they should not have. */
export async function clearLog(): Promise<void> {
  await flush();
  const rotated = await readIfPresent(ROTATED_PATH);
  const live = await readIfPresent(LIVE_PATH);
  const combined = rotated + live;

  if (combined.length > 0) {
    try {
      if (await RNFS.exists(EXPORTED_PATH)) await RNFS.unlink(EXPORTED_PATH);
    } catch {}
    try {
      await RNFS.writeFile(EXPORTED_PATH, combined, "utf8");
    } catch {
      // Clear even when the stash failed: honouring the request beats
      // leaving the log to grow.
    }
  }

  try {
    if (await RNFS.exists(LIVE_PATH)) await RNFS.unlink(LIVE_PATH);
  } catch {}
  try {
    if (await RNFS.exists(ROTATED_PATH)) await RNFS.unlink(ROTATED_PATH);
  } catch {}

  liveBytes = 0;
  buffer = [];
  bufferBytes = 0;
  log("info", "debug", "=== log cleared (previous contents kept at .exported) ===");
}

export const DEBUG_LOG_PATHS = {
  live: LIVE_PATH,
  rotated: ROTATED_PATH,
  exported: EXPORTED_PATH,
};
