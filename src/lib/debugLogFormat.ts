// Pure formatting and size-cap math for the debug logging subsystem.
// Deliberately RN-free (no react-native, no react-native-fs, no expo-*) so
// Jest can exercise it under `testEnvironment: "node"`. Everything deciding
// what a log line looks like or when the file rotates lives here; the
// side-effecting writer in src/lib/debugLog.ts supplies the filesystem.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Order matters — index doubles as severity rank for threshold filters. */
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Per-entry byte clamp, so one pathological payload cannot eat the whole
 *  file budget. Longer entries are truncated with a visible marker, so a
 *  reader knows data was dropped rather than mis-reading a half-line. */
export const MAX_ENTRY_BYTES = 2048;

/** Rotation threshold. At 2 MB the live file rolls to `.1`. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

const TRUNCATION_MARKER = "…[truncated]";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local-time stamp, millisecond resolution. Local rather than UTC so a
 *  report of "around quarter past two" can be found in the file without
 *  timezone arithmetic; the export filename carries the date separately. */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

/** Render a single log entry. The fixed-width level keeps the tag column
 *  aligned, and newlines inside `msg` are escaped so one entry is always
 *  exactly one line — the export stays grep-able and a torn multi-line entry
 *  cannot be mistaken for two events. */
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

/** Clamp one rendered entry to MAX_ENTRY_BYTES. UTF-16 length is a cheap
 *  proxy for bytes; it under-counts only astral-plane characters, which is
 *  fine for a safety valve. */
export function clampEntry(line: string, max = MAX_ENTRY_BYTES): string {
  if (line.length <= max) return line;
  // The final slice covers `max` being shorter than the marker itself, where
  // the marker alone would overrun the cap.
  return (
    line.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
  ).slice(0, max);
}

/** Serialize an arbitrary value for the message field. Structured engine
 *  errors must survive as structure rather than being flattened to
 *  `String(err.message)`. */
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

/** Render an engine-style structured error preserving category, cause and
 *  detail. `errorMessage()` is the display path; this is the diagnostic path
 *  and deliberately keeps everything. */
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

/** Decide whether a pending write forces a rotation. Pure, so the boundary
 *  is testable without a disk. The `currentBytes > 0` guard matters: a single
 *  append larger than the cap on an empty file must still be written, or an
 *  oversized burst would rotate forever and record nothing. */
export function shouldRotate(
  currentBytes: number,
  pendingBytes: number,
  max = MAX_LOG_BYTES
): boolean {
  if (currentBytes <= 0) return false;
  return currentBytes + pendingBytes > max;
}

/** Worst-case on-disk footprint: the live file plus one rotated segment.
 *  Exposed so the Settings screen can state the real ceiling. */
export function maxOnDiskBytes(max = MAX_LOG_BYTES): number {
  return max * 2;
}

/** Filesystem-safe slug for a user-supplied export label, so an arbitrary
 *  typed string survives a share sheet, a mail attachment and a Windows
 *  filesystem. Falls back to "log" when the input reduces to nothing. */
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

/** `peardrop-log_<label>_<YYYY-MM-DD>.txt`. The label is what makes an
 *  attachment self-describing among several others. */
export function buildLogFilename(label: string, date: Date | number): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `peardrop-log_${slugifyLabel(label)}_${stamp}.txt`;
}

/** Which build produced a log, and whether its instrumentation was armed.
 *  Plain data supplied by the caller, so this module stays RN-free;
 *  `src/lib/devGate.ts` reads the native constants and hands the result in. */
export type BuildContext = {
  appVersion: string;
  appVersionCode: number | null;
  buildType: string;
  isDebugBuild: boolean;
  isDebuggable: boolean | null;
  gateSource: string;
  platform: string;
  /** The generated build stamp, computed at Gradle configuration time, which
   *  tells two builds of the same versionCode apart. Optional so callers that
   *  do not supply it still compile; the header then reads `unknown`, because
   *  a missing line cannot be told from an older build's header. */
  buildStamp?: string | null;
  /** The content hash `bare-pack` writes into the packed worklet header. It
   *  changes only when packed backend source changes, which detects a fresh
   *  RN bundle over a stale worklet — so it stays out of `buildStamp`, whose
   *  value would move on the RN rebuild and hide exactly that. */
  workletBundleId?: string | null;
};

function yesNo(v: boolean | null): string {
  return v === null ? "unknown" : v ? "yes" : "no";
}

/** Print `unknown` for an identifier that did not reach the header, rather
 *  than an empty value or a dropped line: a blank cannot be told apart from
 *  a stamp that was never plumbed through, and a wrong attribution is worse
 *  than none. */
function orUnknown(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  return s || "unknown";
}

/** Header prepended to an export bundle. The `instrument:` line states ARMED
 *  or NOT ARMED in words, because a release build yields a normal-looking log
 *  with no instrumentation in it. The build identifiers live here because the
 *  header cannot be evicted, and `stamp:` and `worklet:` stay separate so a
 *  stale worklet under a fresh RN bundle is visible. */
export function buildBundleHeader(
  label: string,
  at: number,
  segments: number,
  build?: BuildContext
): string {
  const lines = [
    "==== PearDrop debug log ====",
    `label:     ${String(label ?? "").trim() || "(none)"}`,
    `exported:  ${formatTimestamp(at)}`,
    `segments:  ${segments}`,
  ];
  if (build) {
    const code = build.appVersionCode === null ? "?" : build.appVersionCode;
    lines.push(
      `app:       ${build.appVersion} (${code}) ${build.buildType} / ${build.platform}`,
      `stamp:     ${orUnknown(build.buildStamp)}`,
      `worklet:   ${orUnknown(build.workletBundleId)}`,
      `instrument: ${build.isDebugBuild ? "ARMED" : "NOT ARMED"} — heartbeats and probe are ` +
        `${build.isDebugBuild ? "present" : "ABSENT"} from this log`,
      `debuggable: ${yesNo(build.isDebuggable)}`,
      `gate-src:  ${build.gateSource}`
    );
  }
  lines.push(
    "note:      raw log — may contain file paths, file names and share keys.",
    "============================",
    ""
  );
  return lines.join("\n");
}

/** Join rotation segments oldest-first. If the live file rotated mid-session
 *  the run-up to a failure is in `.1` and the failure is in the live file, so
 *  newest-first would put the cause after the effect. */
export function buildBundle(
  label: string,
  at: number,
  segmentsOldestFirst: string[],
  build?: BuildContext
): string {
  const present = segmentsOldestFirst.filter((s) => s && s.length > 0);
  return buildBundleHeader(label, at, present.length, build) + present.join("");
}
