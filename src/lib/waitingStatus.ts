/** The status a saved received-share row carries, and the line it shows. Pure and import-free, because a status line written inline in a screen is one no test can read. */

/** The persisted statuses: one fewer than the reducer's, because expiry is a function of the timestamp and is never written. */
// A user stop IS stored: nothing can re-derive it, and losing it across a restart would silently resume a stopped download.
export type WaitingStatus =
  | "waiting"
  | "ready"
  | "queued"
  | "paused"
  | "downloading"
  | "stopped"
  | "done";

export const WAITING_STATUSES: readonly WaitingStatus[] = [
  "waiting",
  "ready",
  "queued",
  "paused",
  "downloading",
  "stopped",
  "done",
];

/** Narrow a reducer status to the persisted union, or null for expiry. */
// Callers that persist a reducer status go through here so the drop is explicit rather than a cast.
export function persistableStatus(status: string): WaitingStatus | null {
  if (status === "expired") return null;
  return isWaitingStatus(status) ? status : null;
}

export function isWaitingStatus(value: unknown): value is WaitingStatus {
  return (
    typeof value === "string" &&
    (WAITING_STATUSES as readonly string[]).includes(value)
  );
}

/** The statuses the waiting loop may pick up. */
// Both this and the reducer's retry list are pinned, so the real difference between them cannot drift into a bug.
export const LOOP_STATUSES: readonly WaitingStatus[] = ["waiting", "queued", "paused"];

export function isLoopStatus(status: WaitingStatus): boolean {
  return (LOOP_STATUSES as readonly string[]).includes(status);
}

/** A row stops waiting after seven days without progress, counted from
 * `lastUpdatedAt`, so a row that resumed yesterday gets the full window again. */
export const ROW_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type StatusFile = {
  readonly isDownloaded: boolean;
  /** The drive entry key. Optional because the derivation does not need it. */
  readonly name?: string;
};

/** The status for a record written before the field existed. An empty file list answers ready, not done: all-downloaded is vacuously true of nothing, and done would claim a transfer that never happened. */
export function deriveStatus(files: readonly StatusFile[] | null | undefined): WaitingStatus {
  if (!Array.isArray(files) || files.length === 0) return "ready";
  return files.every((f) => f?.isDownloaded === true) ? "done" : "ready";
}

/** Give a stored record a status, changing nothing else and dropping no record. An unrecognised status is treated as absent and re-derived, because a value outside the union renders nothing. */
export function migrateStatus<T extends { status?: unknown; files?: readonly StatusFile[] }>(
  record: T,
): T & { status: WaitingStatus } {
  if (isWaitingStatus(record.status)) {
    return record as T & { status: WaitingStatus };
  }
  return { ...record, status: deriveStatus(record.files) };
}

/** The status a successful resolve leaves behind: a resolve brings a newer file list, not a newer intent. */
// So a row the user queued or paused keeps that status and its selection, and only the three that carry no intent are re-derived.
export function statusAfterResolve(
  prev: WaitingStatus | undefined,
  files: readonly StatusFile[],
): WaitingStatus {
  if (prev === "queued" || prev === "paused" || prev === "downloading") return prev;
  return deriveStatus(files) === "done" ? "done" : "ready";
}

export function isExpired(
  status: WaitingStatus,
  lastUpdatedAt: number,
  now: number,
): boolean {
  // Excludes a user stop: expiring it after seven days would retire a decision the user had already made.
  if (!isLoopStatus(status)) return false;
  if (!Number.isFinite(lastUpdatedAt) || !Number.isFinite(now)) return false;
  return now - lastUpdatedAt > ROW_EXPIRY_MS;
}

export type StatusLineInput = {
  readonly status: WaitingStatus;
  readonly files: readonly StatusFile[];
  /** Selected file paths, as stored on the record. */
  readonly selection?: readonly string[];
  /** Selected paths the latest version of the share does not have. */
  readonly missing?: readonly string[];
  readonly lastUpdatedAt: number;
  readonly now: number;
  /** Downloaded count among the selection, when the caller knows it. */
  readonly downloadedInSelection?: number;
};

export type StatusLines = {
  /** The row's own line. `null` means the row keeps whatever it shows today. */
  readonly primary: string | null;
  /** The second line, when some selected files are gone. */
  readonly missing: string | null;
  readonly expired: boolean;
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Expiry is checked before the status: the line is the only place the user is
 * told the loop let go, so a stopped row must not still offer to wait. */
export function statusLines(input: StatusLineInput): StatusLines {
  const selection = input.selection ?? [];
  const missing = input.missing ?? [];
  const missingLine =
    missing.length > 0
      ? `${missing.length} ${plural(missing.length, "file", "files")} no longer shared`
      : null;

  if (isExpired(input.status, input.lastUpdatedAt, input.now)) {
    return { primary: "Stopped waiting", missing: missingLine, expired: true };
  }

  switch (input.status) {
    case "waiting":
      return { primary: "Waiting for sender", missing: missingLine, expired: false };
    case "ready":
      return { primary: "Choose files", missing: missingLine, expired: false };
    case "queued":
      return {
        primary: `Queued · ${selection.length} ${plural(selection.length, "file", "files")}`,
        missing: missingLine,
        expired: false,
      };
    case "paused": {
      const done =
        typeof input.downloadedInSelection === "number"
          ? input.downloadedInSelection
          : countDownloadedInSelection(input.files, selection);
      return {
        primary: `Paused · ${done} of ${selection.length} ${plural(selection.length, "file", "files")}`,
        missing: missingLine,
        expired: false,
      };
    }
    // These three have their own surface. `stopped` joins them because its whole copy needs a percentage, and this
    // function has no transfer to read one from.
    case "downloading":
    case "stopped":
    case "done":
      return { primary: null, missing: missingLine, expired: false };
  }
}

/** Matching is by the stored `name`, which is the drive entry key: the identity
 * `receivedRegrab.ts` documents and the one the selection is stored in. */
export function countDownloadedInSelection(
  files: readonly StatusFile[],
  selection: readonly string[],
): number {
  if (selection.length === 0) return 0;
  const wanted = new Set(selection.map(normalizePath));
  let n = 0;
  for (const f of files) {
    if (!f?.isDownloaded) continue;
    if (wanted.has(normalizePath(f.name ?? ""))) n++;
  }
  return n;
}

/** One spelling for a drive entry key, so a selection stored with a leading slash still matches a manifest entry written without one. */
export function normalizePath(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

export type SelectionMatch = {
  /** Selected paths the latest version still has. */
  readonly present: string[];
  /** Selected paths that are gone. */
  readonly missing: string[];
};

/** Re-match a saved selection against the latest version of the share, before the download rather than inside it. */
// The engine enumerates from the persisted key set, so a key the host removed costs a stall timeout per file, and dropping it here costs nothing.
export function matchSelection(
  selection: readonly string[],
  latestPaths: readonly string[],
): SelectionMatch {
  const available = new Set(latestPaths.map(normalizePath));
  const present: string[] = [];
  const missing: string[] = [];
  for (const raw of selection) {
    const p = normalizePath(raw);
    if (!p) continue;
    if (available.has(p)) present.push(raw);
    else missing.push(raw);
  }
  return { present, missing };
}

/** A row holding a selection is never ready: a row carrying the user's choice is queued. */
// One-directional: it demotes an impossible ready and rewrites nothing else. Pure, so the invariant is assertable.
export function withConsistentStatus<
  T extends { status: WaitingStatus; selection?: readonly string[] },
>(share: T): T {
  if (share.status !== "ready") return share;
  if ((share.selection?.length ?? 0) === 0) return share;
  return { ...share, status: "queued" };
}
