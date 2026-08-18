// Pure formatting + size-cap math for the debug logging subsystem.
// Deliberately RN-free (no react-native, no react-native-fs, no expo-*) so
// Jest can exercise it under `testEnvironment: "node"`.
//
// What a log line looks like and when the file rotates is decided here; the
// side-effecting writer (src/lib/debugLog.ts) supplies the filesystem.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Order matters — index doubles as severity rank for threshold filters. */
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Per-entry byte clamp. One pathological payload (a stringified manifest,
 * a base64 blob that slipped into a `detail`) must not be able to eat the
 * whole file budget on its own. Entries longer than this are truncated
 * with a visible marker so the reader knows data was dropped rather than
 * silently mis-reading a half-line.
 */
export const MAX_ENTRY_BYTES = 2048;

/** Rotation threshold. At 2 MB the live file rolls to `.1`. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

const TRUNCATION_MARKER = "…[truncated]";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Local-time stamp, millisecond resolution: `2026-08-08 14:03:07.412`.
 *
 * Local rather than ISO/UTC on purpose — a tester says "it broke around
 * quarter past two" and we need to find that in the file without doing
 * timezone arithmetic. The export filename carries the date separately.
 */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Render a single log entry.
 *
 *   2026-08-08 14:03:07.412  WARN [engine.open] drive.update raced abort
 *
 * Fixed-width level keeps the tag column aligned, which matters a lot when
 * you're eyeballing 2 MB of it. Newlines inside `msg` are escaped to `\n`
 * so one entry is always exactly one line — the export is grep-able and a
 * torn multi-line entry can't be mistaken for two events.
 */
export function formatEntry(
  ts: number,
  level: LogLevel,
  tag: string,
  msg: string
): string {
  const safeTag = String(tag || "app").replace(/[\s\]]+/g, "-");
  const flattened = String(msg ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "\\n");
  const line = `${formatTimestamp(ts)}  ${level.toUpperCase().padEnd(5)} [${safeTag}] ${flattened}`;
  return clampEntry(line);
}

/**
 * Clamp one rendered entry to MAX_ENTRY_BYTES. Uses UTF-16 length as a
 * cheap proxy for bytes — it over-counts nothing and under-counts only
 * for astral-plane characters, which is fine for a safety valve.
 */
export function clampEntry(line: string, max = MAX_ENTRY_BYTES): string {
  if (line.length <= max) return line;
  // Final slice matters for the degenerate case where `max` is shorter
  // than the marker itself — otherwise the marker alone would overrun the
  // cap this function exists to enforce.
  return (
    line.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
  ).slice(0, max);
}

/**
 * Serialize an arbitrary value for the message field. Structured engine errors
 * ({category, cause, detail}) must survive as structure — flattening them to
 * `String(err.message)` discards the taxonomy.
 */
export function stringifyDetail(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise unserializable — fall back to a shallow shape
    // rather than losing the entry entirely.
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * Render an engine-style structured error preserving category + cause +
 * detail. `errorMessage()` in src/lib/errorMessage.ts is the *display*
 * path; this is the *diagnostic* path and deliberately keeps everything.
 */
export function formatStructuredError(err: unknown): string {
  if (err == null) return "";
  if (typeof err !== "object") return String(err);
  const e = err as {
    category?: string;
    cause?: string;
    message?: string;
    detail?: unknown;
    stack?: string;
  };
  const parts: string[] = [];
  if (e.category) parts.push(`category=${e.category}`);
  if (e.cause) parts.push(`cause=${e.cause}`);
  if (e.message) parts.push(`message=${JSON.stringify(e.message)}`);
  if (e.detail !== undefined) parts.push(`detail=${stringifyDetail(e.detail)}`);
  if (parts.length === 0) return stringifyDetail(err);
  return parts.join(" ");
}

/**
 * Decide whether a pending write forces a rotation.
 *
 * Pure so the boundary condition is testable without touching a disk:
 * given the live file's current size and the number of bytes about to be
 * appended, does the result cross the cap?
 *
 * Note the `currentBytes > 0` guard: a single append larger than the cap
 * on an *empty* file must still be written, otherwise an oversized burst
 * would rotate forever and never record anything.
 */
export function shouldRotate(
  currentBytes: number,
  pendingBytes: number,
  max = MAX_LOG_BYTES
): boolean {
  if (currentBytes <= 0) return false;
  return currentBytes + pendingBytes > max;
}

/**
 * Total worst-case on-disk footprint of the subsystem: the live file plus
 * one rotated segment. Exposed so the Settings screen can state the real
 * ceiling rather than a hand-wave.
 */
export function maxOnDiskBytes(max = MAX_LOG_BYTES): number {
  return max * 2;
}

/**
 * Filesystem-safe slug for a user-supplied export label.
 *
 * Testers type things like "crash on grab (2nd try)" — that has to become
 * something a share sheet, an email attachment, and a Windows filesystem
 * will all accept. Collapses runs of unsafe characters to a single dash,
 * trims leading/trailing dashes, caps length, and falls back to "log" when
 * the input reduces to nothing.
 */
export function slugifyLabel(raw: string, maxLen = 40): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "log";
}

/**
 * `peardrop-log_<label>_<YYYY-MM-DD>.txt`
 *
 * The label is what makes a tester's attachment self-describing when it
 * lands in our inbox next to four others.
 */
export function buildLogFilename(label: string, date: Date | number): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `peardrop-log_${slugifyLabel(label)}_${stamp}.txt`;
}

/**
 * Header prepended to an export bundle: context that isn't in any individual
 * line, plus a plain statement that the contents are unscrubbed.
 */
export function buildBundleHeader(
  label: string,
  at: number,
  segments: number
): string {
  return [
    "==== PearDrop debug log ====",
    `label:     ${String(label ?? "").trim() || "(none)"}`,
    `exported:  ${formatTimestamp(at)}`,
    `segments:  ${segments}`,
    "note:      raw log — may contain file paths, file names and share keys.",
    "============================",
    "",
  ].join("\n");
}

/**
 * Join rotation segments oldest-first into the exported bundle.
 *
 * Oldest-first matters: if the live file rotated mid-session, the run-up
 * to the failure is in `.1` and the failure itself is in the live file.
 * Concatenating newest-first would put the cause after the effect.
 */
export function buildBundle(
  label: string,
  at: number,
  segmentsOldestFirst: string[]
): string {
  const present = segmentsOldestFirst.filter((s) => s && s.length > 0);
  return buildBundleHeader(label, at, present.length) + present.join("");
}
