const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < UNITS.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${idx === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[idx]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function clampPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Render a past timestamp as a relative label for the first week, then
 * fall back to a short absolute date. Used by the SHARE INFO / FILE INFO
 * surfaces. Anchored to a caller-supplied `now` for testability.
 */
export function formatRelativeOrDate(ms?: number, now: number = Date.now()): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const diff = Math.max(0, now - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Absolute short date — "Jul 01, 2026". Used by File-info surfaces where
 * we always want the actual date rather than a "2h ago" recency label.
 */
export function formatAbsoluteDate(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * "0:32" / "2:14" / "1:02:33" formatter for media playback timestamps.
 * Hours are only shown when needed; minutes always include leading
 * single-digit (e.g. "0:05" not "5"); seconds are zero-padded to two
 * digits. Negative or non-finite inputs return "0:00".
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  if (h > 0) {
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}
