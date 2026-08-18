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

/**
 * The single file writer. RN calls `log()` directly; the Bare backend ships
 * its lines over the RPC event channel and BackendProvider feeds them into
 * `logFromBackend()`. The worklet never writes the file — two realms
 * appending to one path with no lock produces interleaved, torn lines.
 *
 * Buffer + flush rather than append-per-line: the download loop emits
 * per-file and per-progress entries, and an RNFS.appendFile per entry would
 * thrash the disk on exactly the path most worth tracing.
 *
 * Flag off means no buffer, no timer, no file handle — see `applyEnabled()`.
 */

const LIVE_PATH = `${RNFS.DocumentDirectoryPath}/peardrop-debug.log`;
const ROTATED_PATH = `${RNFS.DocumentDirectoryPath}/peardrop-debug.log.1`;
/** Where a "cleared" log goes. Rotate-not-delete: clearing is recoverable. */
const EXPORTED_PATH = `${RNFS.DocumentDirectoryPath}/peardrop-debug.log.exported`;

/** Flush cadence. Short enough that a crash loses ~1 s, long enough to coalesce. */
const FLUSH_INTERVAL_MS = 1000;
/** Flush early if the buffer reaches this many entries (burst protection). */
const FLUSH_AT_ENTRIES = 64;
/**
 * …or this many buffered bytes, whichever comes first. Entries are capped
 * at ~2 KB each, so an entry-count threshold alone could hold ~128 KB in
 * memory between ticks. This bounds the buffer by size as well as count.
 */
const FLUSH_AT_BYTES = 32 * 1024;
/** Re-stat the live file every N flushes to correct any drift in our counter. */
const STAT_RECONCILE_EVERY = 32;

let enabled = false;
let buffer: string[] = [];
let bufferBytes = 0;
let liveBytes = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> = Promise.resolve();
let flushCount = 0;
let appStateSub: { remove: () => void } | null = null;
let initialized = false;

// ---------------------------------------------------------------------
// Hot path
// ---------------------------------------------------------------------

/**
 * Record one entry. No-ops when debugging is off — this is the guard that
 * makes "flag OFF = zero overhead" true, and it's why every instrumented
 * call site can be unconditional.
 */
export function log(level: LogLevel, tag: string, msg: string): void {
  if (!enabled) return;
  push(formatEntry(Date.now(), level, tag, msg));
}

export const logDebug = (tag: string, msg: string) => log("debug", tag, msg);
export const logInfo = (tag: string, msg: string) => log("info", tag, msg);
export const logWarn = (tag: string, msg: string) => log("warn", tag, msg);
export const logError = (tag: string, msg: string) => log("error", tag, msg);

/**
 * Log a structured engine error preserving category / cause / detail.
 *
 * `formatStructuredError` keeps all four fields; flattening to
 * `String(err.message)` discards the taxonomy exactly when it's most useful.
 */
export function logStructuredError(tag: string, context: string, err: unknown): void {
  if (!enabled) return;
  const rendered = formatStructuredError(err);
  push(formatEntry(Date.now(), "error", tag, `${context} — ${rendered}`));
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
  push(formatEntry(at, level, `be:${entry.tag || "backend"}`, String(entry.msg ?? "")));
}

/** Convenience for logging arbitrary structured payloads. */
export function logValue(level: LogLevel, tag: string, label: string, value: unknown): void {
  if (!enabled) return;
  push(formatEntry(Date.now(), level, tag, `${label} ${stringifyDetail(value)}`));
}

function push(line: string): void {
  buffer.push(line);
  bufferBytes += line.length + 1;
  if (buffer.length >= FLUSH_AT_ENTRIES || bufferBytes >= FLUSH_AT_BYTES) {
    void flush();
  }
}

// ---------------------------------------------------------------------
// Flush + rotation
// ---------------------------------------------------------------------

/**
 * Drain the buffer to disk. Serialized through `flushing` so overlapping
 * callers (timer, burst threshold, AppState, export) can't interleave two
 * appends onto the same file.
 */
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
    // Periodically reconcile our in-memory byte counter against reality —
    // it can drift if a write partially failed or the file was touched
    // outside this module.
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

/**
 * Roll the live file to `.1`, replacing any previous `.1`. Worst case on
 * disk is therefore 2 × MAX_LOG_BYTES.
 */
async function rotate(): Promise<void> {
  try {
    if (await RNFS.exists(ROTATED_PATH)) await RNFS.unlink(ROTATED_PATH);
  } catch {}
  try {
    if (await RNFS.exists(LIVE_PATH)) await RNFS.moveFile(LIVE_PATH, ROTATED_PATH);
  } catch {}
  liveBytes = 0;
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

// ---------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------

/**
 * Subscribe to the flag. Call once at app boot. Idempotent.
 *
 * Everything the subsystem costs when the flag is off is this one
 * subscription — no timer, no buffer, no file handle.
 */
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

/** Re-read the persisted flag (used at boot before the first subscribe fires). */
export function syncEnabledFromStorage(): void {
  void applyEnabled(isDebugLoggingEnabledSync());
}

// ---------------------------------------------------------------------
// Export + reset
// ---------------------------------------------------------------------

export type LogSizes = { live: number; rotated: number; total: number };

export async function getLogSizes(): Promise<LogSizes> {
  const live = await statSize(LIVE_PATH);
  const rotated = await statSize(ROTATED_PATH);
  return { live, rotated, total: live + rotated };
}

/**
 * Build the export bundle: both rotation segments, oldest-first, behind a
 * header, written to the cache directory under the labeled filename.
 *
 * The copy lives in cache — never the live log — so a subsequent reset can
 * never touch a file the share sheet is still holding.
 *
 * Cache is also what makes it shareable: expo-file-system ships a
 * FileProvider whose file_paths grants both `files/` and `cache/`, so the
 * content URI resolves without any manifest work on our side.
 */
export async function buildExportBundle(
  label: string
): Promise<{ uri: string; fileName: string; bytes: number } | null> {
  // Get everything buffered onto disk first, or the most recent (and most
  // relevant) entries would be missing from the export.
  await flush();

  const rotated = await readIfPresent(ROTATED_PATH);
  const live = await readIfPresent(LIVE_PATH);
  if (!rotated && !live) return null;

  const contents = buildBundle(label, Date.now(), [rotated, live]);
  const fileName = buildLogFilename(label, Date.now());
  const uri = `${RNFS.CachesDirectoryPath}/${fileName}`;

  try {
    if (await RNFS.exists(uri)) await RNFS.unlink(uri);
  } catch {}
  await RNFS.writeFile(uri, contents, "utf8");

  return { uri, fileName, bytes: contents.length };
}

/**
 * Hand the bundle to the system share sheet.
 *
 * Resolves on dismissal. Android reports neither the chosen target nor a
 * cancel, so this resolving tells us nothing about delivery — which is
 * precisely why runExportFlow asks the user afterwards instead of
 * auto-clearing. Throwing here means the sheet never opened.
 */
export async function shareBundle(uri: string, fileName: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(uri.startsWith("file://") ? uri : `file://${uri}`, {
    mimeType: "text/plain",
    dialogTitle: `Send ${fileName}`,
    UTI: "public.plain-text",
  });
}

/**
 * "Clear" the log — by rotation, not deletion.
 *
 * Both live segments are folded into `.exported` (replacing any previous
 * one) and the live files are removed. The user gets a fresh log; the
 * cleared content is still on disk and recoverable via adb if a tester
 * clears something they shouldn't have.
 */
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
      // If we can't stash it we still clear — the user asked. Better to
      // honour the request than to leave the log growing.
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
