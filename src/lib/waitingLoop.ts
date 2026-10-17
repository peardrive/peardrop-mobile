/** The loop that waits for a sender: a plain module with an injected clock, so backoff and expiry are assertable. */
// Nothing here imports react, storage or the bridge; the caller wires all of it.

import { isExpired, isLoopStatus, type WaitingStatus } from "./waitingStatus";

/** Rows per lookup round. Beyond this the loop rotates rather than refusing. */
export const LOOKUP_CAP = 20;

/** A row is checked this often, until it has been empty long enough to back off. */
export const BASE_INTERVAL_MS = 60_000;
export const BACKOFF_INTERVAL_MS = 5 * 60_000;
export const BACKOFF_AFTER_EMPTY_CHECKS = 10;

/** A row the user has committed to is checked this often, forever: the only question left is when the sender appears. */
// Backed off, such a row sat queued against a live announcer until the user tapped confirm, which bypasses the loop.
export const COMMITTED_INTERVAL_MS = 10_000;

/** How often the loop looks for due rows, which is not how often a row is checked. */
// Must divide the committed interval, or a committed row's effective cadence is the tick rather than the interval.
export const TICK_MS = 5_000;

export type WaitingRow = {
  readonly shareKey: string;
  readonly status: WaitingStatus;
  readonly lastUpdatedAt: number;
  readonly lastCheckedAt?: number;
  readonly emptyChecks?: number;
  /** Has the user confirmed a selection for this row? Supplied by the caller, because the loop does not read storage, so the commitment has to travel with the row. */
  readonly committed?: boolean;
};

export type LookupAnswer = {
  readonly key: string;
  readonly found: boolean;
};

export function intervalFor(
  emptyChecks: number | undefined,
  committed?: boolean,
): number {
  // A committed row is never backed off. See COMMITTED_INTERVAL_MS.
  if (committed) return COMMITTED_INTERVAL_MS;
  const n = typeof emptyChecks === "number" && Number.isFinite(emptyChecks) ? emptyChecks : 0;
  return n >= BACKOFF_AFTER_EMPTY_CHECKS ? BACKOFF_INTERVAL_MS : BASE_INTERVAL_MS;
}

/** A row that has never been checked is due immediately. */
export function isDue(row: WaitingRow, now: number): boolean {
  if (!isLoopStatus(row.status)) return false;
  const last = row.lastCheckedAt;
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  return now - last >= intervalFor(row.emptyChecks, row.committed);
}

/** The due rows for this round, oldest-checked first and capped. The sort is
 * what makes the cap a rotation; applied unsorted it would starve the tail. */
export function selectDueRows(
  rows: readonly WaitingRow[],
  now: number,
  cap: number = LOOKUP_CAP,
): WaitingRow[] {
  return rows
    .filter((r) => isLoopStatus(r.status) && !isExpired(r.status, r.lastUpdatedAt, now))
    .filter((r) => isDue(r, now))
    .sort((a, b) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0))
    .slice(0, Math.max(0, cap));
}

export function selectExpiredRows(
  rows: readonly WaitingRow[],
  now: number,
): WaitingRow[] {
  return rows.filter((r) => isExpired(r.status, r.lastUpdatedAt, now));
}

export type WaitingLoopDeps = {
  readonly now: () => number;
  /** Every saved row, in any status. The loop does its own filtering. */
  readonly loadRows: () => Promise<readonly WaitingRow[]>;
  /** One lookup round. Share keys in, answers out. */
  readonly lookup: (keys: string[]) => Promise<readonly LookupAnswer[]>;
  /** The sender is reachable: resolve, or resume the download. */
  readonly onFound: (row: WaitingRow) => Promise<void>;
  /** Bookkeeping for a round that ran. Must not count as progress. */
  readonly onChecked: (shareKey: string, found: boolean, at: number) => Promise<void>;
  /** The row has waited seven days. It leaves the loop; its files stay. */
  readonly onExpired: (row: WaitingRow) => Promise<void>;
  /** Is something the user started already running for this row? A loop
   * download must never race a user-started one for the same share. */
  readonly isBusy?: (shareKey: string) => boolean;
  /** Clear a row's backoff. Called by `retryNow` before it looks the row up. */
  readonly onBackoffReset?: (shareKey: string) => Promise<void>;
  readonly log?: (level: "debug" | "info" | "warn", message: string) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
};

export type WaitingLoop = {
  /** One round. Resolves when the round is over, including its onFound work. */
  runOnce: () => Promise<number>;
  start: (tickMs?: number) => void;
  stop: () => void;
  /** Check one row now, with its backoff reset. */
  retryNow: (shareKey: string) => Promise<boolean>;
  isRunning: () => boolean;
};

export function createWaitingLoop(deps: WaitingLoopDeps): WaitingLoop {
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  // One round at a time, one action per row. Two guards: a second round doubles
  // every lookup, a second per-row action runs two downloads into one folder.
  let roundRunning = false;
  let timer: unknown = null;
  let started = false;
  const rowsInFlight = new Set<string>();

  const busy = (shareKey: string): boolean =>
    rowsInFlight.has(shareKey) || deps.isBusy?.(shareKey) === true;

  async function handleFound(row: WaitingRow): Promise<void> {
    if (busy(row.shareKey)) {
      log("debug", `loop skip ${row.shareKey.slice(0, 8)} — already busy`);
      return;
    }
    rowsInFlight.add(row.shareKey);
    try {
      await deps.onFound(row);
    } catch (err) {
      log("warn", `loop onFound failed ${row.shareKey.slice(0, 8)}: ${String(err)}`);
    } finally {
      rowsInFlight.delete(row.shareKey);
    }
  }

  async function round(only?: string): Promise<number> {
    if (roundRunning) {
      log("debug", "loop round skipped — one is already in flight");
      return 0;
    }
    roundRunning = true;
    try {
      const now = deps.now();
      const all = await deps.loadRows();

      for (const row of selectExpiredRows(all, now)) {
        try {
          await deps.onExpired(row);
        } catch (err) {
          log("warn", `loop expiry handler failed ${row.shareKey.slice(0, 8)}: ${String(err)}`);
        }
      }

      let due: WaitingRow[];
      if (only) {
        const target = all.find((r) => r.shareKey === only);
        // A forced retry ignores both the interval and the backoff, which is
        // the whole of "Retry now". It still respects status and expiry.
        due =
          target && isLoopStatus(target.status) && !isExpired(target.status, target.lastUpdatedAt, now)
            ? [target]
            : [];
      } else {
        due = selectDueRows(all, now);
      }

      const checkable = due.filter((r) => !busy(r.shareKey));
      if (checkable.length === 0) return 0;

      const answers = await deps.lookup(checkable.map((r) => r.shareKey));
      const byKey = new Map(answers.map((a) => [a.key.toLowerCase(), a]));
      const at = deps.now();

      let found = 0;
      for (const row of checkable) {
        const answer = byKey.get(row.shareKey.toLowerCase());
        const hit = answer?.found === true;
        // Recorded for every row actually asked about, found or not: this moves
        // the backoff, and a missing answer must not read as empty.
        if (answer) {
          try {
            await deps.onChecked(row.shareKey, hit, at);
          } catch (err) {
            log("warn", `loop onChecked failed ${row.shareKey.slice(0, 8)}: ${String(err)}`);
          }
        }
        if (hit) {
          found++;
          await handleFound(row);
        }
      }
      log("info", `loop round: checked=${checkable.length} found=${found}`);
      return found;
    } finally {
      roundRunning = false;
    }
  }

  function schedule(tickMs: number) {
    timer = setTimer(() => {
      void round().finally(() => {
        if (started) schedule(tickMs);
      });
    }, tickMs);
  }

  return {
    runOnce: () => round(),
    start(tickMs = TICK_MS) {
      if (started) return;
      started = true;
      // Run immediately rather than waiting out the first tick: the common
      // entry is a foreground transition, and the user is looking at the list.
      void round().finally(() => {
        if (started) schedule(tickMs);
      });
    },
    stop() {
      started = false;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
    },
    async retryNow(shareKey) {
      const k = String(shareKey || "").toLowerCase();
      if (!k) return false;
      try {
        await deps.onBackoffReset?.(k);
      } catch (err) {
        log("warn", `loop backoff reset failed ${k.slice(0, 8)}: ${String(err)}`);
      }
      return (await round(k)) > 0;
    },
    isRunning: () => started,
  };
}
