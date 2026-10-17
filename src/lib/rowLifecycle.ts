/** The one reducer and the only writer of a row status: every event handled in every status, with an exhaustiveness test. */
// Pure and import-free, so the suite reaches it; after a grab no status is an error, a failure is a pause that retries.

/** Every status a row may hold. `expired` is terminal and derived from time. */
export const ROW_STATUSES = [
  "waiting",
  "ready",
  "queued",
  "downloading",
  "paused",
  "stopped",
  "done",
  "expired",
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

/** The five a row may hold once files have been chosen. */
export const AFTER_GRAB_STATUSES = [
  "queued",
  "downloading",
  "paused",
  "stopped",
  "done",
] as const;
export type AfterGrabStatus = (typeof AFTER_GRAB_STATUSES)[number];

export function isAfterGrabStatus(s: RowStatus): s is AfterGrabStatus {
  return (AFTER_GRAB_STATUSES as readonly string[]).includes(s);
}

/** Statuses the waiting loop may pick up. `stopped` is deliberately absent:
 *  the user stopped it, and nothing but the user restarts it. */
export const AUTO_RETRY_STATUSES: readonly RowStatus[] = [
  "waiting",
  "ready",
  "queued",
  "paused",
];

/** Why a row is paused. */
// Two of them do not auto-retry, because retrying a full disk on a timer is a loop that cannot succeed; they wait for the user to confirm again.
export type PauseReason =
  | "senderOffline"
  | "stalled"
  | "appRestarted"
  | "noSpace"
  | "cantWrite"
  | "filesGone";

export const PAUSE_REASONS: readonly PauseReason[] = [
  "senderOffline",
  "stalled",
  "appRestarted",
  "noSpace",
  "cantWrite",
  "filesGone",
];

/** A paused row the loop must leave alone until the user acts. */
export function pauseNeedsUser(reason: PauseReason | null): boolean {
  return reason === "noSpace" || reason === "cantWrite";
}

/** A per-file problem retrying will not fix on its own. Shown on that file in
 *  the picker as one neutral line. Never on the row as an error. */
export type FileNote = "gone" | "noSpace" | "cantWrite";

export type RowLifecycleState = {
  readonly status: RowStatus;
  /** The drive entry keys the user confirmed. */
  readonly selection: readonly string[];
  /** Null unless `status === "paused"`. */
  readonly pauseReason: PauseReason | null;
  /** 0..100. Never decreases except on an explicit reset. */
  readonly pct: number;
  /** Selected files saved to disk. */
  readonly filesDone: number;
  /** Per-file notes, keyed by the drive entry key. */
  readonly fileNotes: Readonly<Record<string, FileNote>>;
  /** Timed retries spent on the current stall. Reset by any byte. */
  readonly stallRetries: number;
  /** True once the row has been deleted; every event is then inert. */
  readonly deleted: boolean;
};

/** The diff `SELECTION_CONFIRMED` carries, straight from the picker's draft. */
export type SelectionDiff = {
  /** Keys newly ticked. */
  readonly add?: readonly string[];
  /** Keys unticked while pending. */
  readonly remove?: readonly string[];
  /** The in-progress key the user marked with the x. Stopped on confirm. */
  readonly stop?: readonly string[];
};

export type RowLifecycleEvent =
  | { readonly type: "LINK_PASTED" }
  | { readonly type: "PASTE_NO_PEER" }
  | { readonly type: "LOOKUP_FOUND" }
  | { readonly type: "LOOKUP_EMPTY" }
  | { readonly type: "LIST_LOADED"; readonly files?: readonly string[] }
  | { readonly type: "LIST_CHANGED_UPSTREAM"; readonly gone?: readonly string[] }
  | { readonly type: "SELECTION_CONFIRMED"; readonly diff: SelectionDiff }
  | { readonly type: "FIRST_BYTE" }
  | { readonly type: "BYTES"; readonly pct: number; readonly filesDone?: number }
  | { readonly type: "STALLED"; readonly peersAttached?: boolean }
  | { readonly type: "RESUMED" }
  | { readonly type: "PEER_LOST" }
  | { readonly type: "FILE_DONE"; readonly file?: string; readonly filesDone?: number }
  | { readonly type: "ALL_DONE"; readonly filesDone?: number }
  | { readonly type: "FILE_GONE"; readonly file: string }
  | {
      readonly type: "LOCAL_WRITE_FAILED";
      readonly reason: "noSpace" | "cantWrite";
      readonly file?: string;
    }
  | { readonly type: "USER_STOP" }
  | { readonly type: "APP_BACKGROUND" }
  | { readonly type: "APP_FOREGROUND" }
  | { readonly type: "APP_RESTARTED" }
  /** The row says downloading and the engine has no session for it. */
  // Distinct from the restart event it shares a pause reason with: a log line blaming a restart for a drive stopped under a running app sends the next reader looking for a crash that did not happen.
  | { readonly type: "SESSION_LOST" }
  | { readonly type: "EXPIRY_TICK"; readonly expired: boolean }
  | { readonly type: "STOP_WAITING" }
  | { readonly type: "ROW_DELETED" }
  | { readonly type: "SAME_LINK_PASTED" };

export type RowLifecycleEventType = RowLifecycleEvent["type"];

/** Every event name, for the exhaustiveness test to iterate. */
export const ROW_EVENTS: readonly RowLifecycleEventType[] = [
  "LINK_PASTED",
  "PASTE_NO_PEER",
  "LOOKUP_FOUND",
  "LOOKUP_EMPTY",
  "LIST_LOADED",
  "LIST_CHANGED_UPSTREAM",
  "SELECTION_CONFIRMED",
  "FIRST_BYTE",
  "BYTES",
  "STALLED",
  "RESUMED",
  "PEER_LOST",
  "FILE_DONE",
  "ALL_DONE",
  "FILE_GONE",
  "LOCAL_WRITE_FAILED",
  "USER_STOP",
  "APP_BACKGROUND",
  "APP_FOREGROUND",
  "APP_RESTARTED",
  "SESSION_LOST",
  "EXPIRY_TICK",
  "STOP_WAITING",
  "ROW_DELETED",
  "SAME_LINK_PASTED",
];

export type RowLifecycleResult = {
  readonly state: RowLifecycleState;
  /** The one line every transition logs, and null when the event changed nothing, so a no-op cannot look like a transition in the export. */
  readonly log: string | null;
  /** Why this pair is a no-op, when it is one: a pair that moved nothing and gave no reason is an unhandled pair, which is what the exhaustiveness test exists to catch. */
  readonly inert: string | null;
};

export const STALL_RETRY_LIMIT = 3;

export function initialRowLifecycle(
  partial?: Partial<RowLifecycleState>,
): RowLifecycleState {
  return {
    status: "waiting",
    selection: [],
    pauseReason: null,
    pct: 0,
    filesDone: 0,
    fileNotes: {},
    stallRetries: 0,
    deleted: false,
    ...partial,
  };
}

function clampPct(n: unknown): number {
  // `Number.isFinite` first: `NaN` slips past every comparison and would freeze
  // the bar at whatever it last held while claiming to be live.
  if (!Number.isFinite(n as number)) return 0;
  return Math.max(0, Math.min(100, Math.round(n as number)));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const NOTE_REASON: Readonly<Record<FileNote, PauseReason>> = {
  gone: "filesGone",
  noSpace: "noSpace",
  cantWrite: "cantWrite",
};

/** A note names something actionable, so it outranks a generic pause reason. */
function reasonFor(state: RowLifecycleState, fallback: PauseReason): PauseReason {
  for (const key of state.selection) {
    const note = state.fileNotes[key];
    if (note) return NOTE_REASON[note];
  }
  return fallback;
}

/** Where a row lands when its selection empties: `done` if anything was saved,
 *  `ready` if nothing was. One rule, four callers. */
function settleEmptySelection(s: RowLifecycleState): RowLifecycleState {
  return {
    ...s,
    status: s.filesDone > 0 ? "done" : "ready",
    selection: [],
    pauseReason: null,
    stallRetries: 0,
  };
}

function pause(s: RowLifecycleState, reason: PauseReason): RowLifecycleState {
  return {
    ...s,
    status: "paused",
    pauseReason: reasonFor(s, reason),
    // The bar freezes at its value. The bytes are on disk and the engine
    // resumes from them, so resetting it would be a lie in the safe direction.
  };
}

/** One transition, returning the same state and an inert reason when nothing moved, so the exhaustiveness test can tell a deliberate no-op from a hole. */
export function rowLifecycle(
  state: RowLifecycleState,
  event: RowLifecycleEvent,
  ctx?: { readonly shareKey?: string },
): RowLifecycleResult {
  // A deleted row is inert for everything. Checked first so no later branch
  // has to remember it.
  if (state.deleted && event.type !== "ROW_DELETED") {
    return { state, log: null, inert: "the row is deleted" };
  }

  const out = step(state, event);
  if (typeof out === "string") return { state, log: null, inert: out };
  if (out === state) return { state, log: null, inert: "no change" };
  return {
    state: out,
    log: rowStateLine(state, out, event.type, ctx?.shareKey),
    inert: null,
  };
}

/** A transition, or a string saying why this pair is deliberately inert. */
function step(s: RowLifecycleState, e: RowLifecycleEvent): RowLifecycleState | string {
  switch (e.type) {
    // ---- before a list exists -------------------------------------------
    case "LINK_PASTED": {
      if (s.status === "waiting") return "already waiting on this link";
      return "a pasted link does not disturb a row that already has one";
    }

    case "PASTE_NO_PEER": {
      if (s.status === "waiting") return "already waiting";
      if (isAfterGrabStatus(s.status) || s.status === "expired") {
        return "a paste cannot un-grab a row";
      }
      return { ...s, status: "waiting" };
    }

    case "SAME_LINK_PASTED": {
      // The row exists, so nothing is created or changed; reported as inert rather than implied by silence.
      return "the row exists; the caller opens its picker";
    }

    case "LOOKUP_FOUND": {
      // News only for a waiting row. A queued row stays queued until a byte lands, which stopped a resumed row claiming progress.
      if (s.status === "waiting") return { ...s, status: "ready" };
      if (s.status === "paused" && pauseNeedsUser(s.pauseReason)) {
        return "this pause waits for the user, not the sender";
      }
      if (s.status === "paused") {
        if (s.pauseReason === null && s.stallRetries === 0) return "nothing to clear";
        // Clear the reason so the row stops blaming an absent sender, but hold
        // the status: a byte is what promotes it.
        return { ...s, pauseReason: null, stallRetries: 0 };
      }
      return "the sender being found changes no status here";
    }

    case "LOOKUP_EMPTY": {
      if (s.status === "downloading") {
        return "bytes are moving, so the lookup is out of date";
      }
      // The list stays valid even with the sender away - the files may already
      // be held - so the status holds and the copy reads the sender signal.
      return "the status holds; the copy says the sender is away";
    }

    case "LIST_LOADED": {
      if (s.status === "waiting") return { ...s, status: "ready" };
      return "the list is already known here";
    }

    case "LIST_CHANGED_UPSTREAM": {
      // Chosen files the host removed become notes and the rest carries on; new files appear unticked, which needs no status change.
      const gone = e.gone ?? [];
      const relevant = gone.filter((k) => s.selection.includes(k));
      if (relevant.length === 0) return "no chosen file was removed";
      const fileNotes = { ...s.fileNotes };
      for (const k of relevant) fileNotes[k] = "gone";
      const withNotes = { ...s, fileNotes };
      if (!isAfterGrabStatus(s.status)) return withNotes;
      if (s.status === "done" || s.status === "stopped") return withNotes;
      const left = s.selection.filter((k) => fileNotes[k] !== "gone");
      if (left.length === 0) return settleEmptySelection(withNotes);
      return pause(withNotes, "filesGone");
    }

    // ---- the user's one write -------------------------------------------
    case "SELECTION_CONFIRMED": {
      if (s.status === "expired") return "a row that stopped waiting is not resumable";
      const add = e.diff.add ?? [];
      const remove = e.diff.remove ?? [];
      const stop = e.diff.stop ?? [];
      const next = [
        ...s.selection.filter((k) => !remove.includes(k) && !stop.includes(k)),
        ...add.filter((k) => !s.selection.includes(k)),
      ];
      if (next.length === 0) {
        if (s.selection.length === 0) return "nothing was chosen and nothing changed";
        return settleEmptySelection(s);
      }
      /** Confirming always re-arms the row: it is the one gesture that restarts a stopped row and the one that clears the two pauses that do not auto-retry. */
      // A downloading row stays downloading, because the engine is already moving and the diff only widens or narrows what it fetches.
      if (s.status === "downloading") {
        if (sameList(s.selection, next)) return "the draft matched the selection";
        return { ...s, selection: next };
      }
      const cleared = { ...s.fileNotes };
      for (const k of [...remove, ...stop]) delete cleared[k];
      return {
        ...s,
        status: "queued",
        selection: next,
        pauseReason: null,
        stallRetries: 0,
        fileNotes: cleared,
      };
    }

    // ---- bytes -----------------------------------------------------------
    case "FIRST_BYTE": {
      if (s.status === "queued" || s.status === "paused") {
        return { ...s, status: "downloading", pauseReason: null, stallRetries: 0 };
      }
      if (s.status === "downloading") return "already downloading";
      if (s.status === "stopped") return "the user stopped this row";
      return "no grab is outstanding, so a byte is not ours";
    }

    case "BYTES": {
      if (s.status !== "downloading") return "bytes only move a downloading row";
      const pct = clampPct(e.pct);
      const filesDone =
        typeof e.filesDone === "number" ? Math.max(0, Math.round(e.filesDone)) : s.filesDone;
      if (pct === s.pct && filesDone === s.filesDone) return "no change";
      return { ...s, pct, filesDone, stallRetries: 0 };
    }

    case "RESUMED": {
      if (s.status === "paused") {
        return { ...s, status: "downloading", pauseReason: null, stallRetries: 0 };
      }
      if (s.status === "downloading") return "already downloading";
      return "a resume only lifts a pause";
    }

    // ---- the ways a download stops moving --------------------------------
    case "STALLED": {
      if (s.status !== "downloading") return "only a downloading row can stall";
      const reason: PauseReason = e.peersAttached === true ? "stalled" : "senderOffline";
      return {
        ...pause(s, reason),
        stallRetries: reason === "stalled" ? s.stallRetries + 1 : 0,
      };
    }

    case "PEER_LOST": {
      if (s.status !== "downloading") return "only a downloading row can lose its peer";
      return { ...pause(s, "senderOffline"), stallRetries: 0 };
    }

    case "APP_BACKGROUND": {
      // Backgrounding is not a pause: the foreground service holds the transfer, and a row written to paused here would report the app's state as the transfer's.
      return "the service holds the transfer; backgrounding is not a pause";
    }

    case "APP_FOREGROUND": {
      // The engine is the authority on return and the caller re-reads the live transfer; changing anything here prefers the stale row.
      return "the caller reconciles with the engine, not with this row";
    }

    case "APP_RESTARTED": {
      // In flight before the kill means no session, so it is honestly paused, and the reason reads reconnecting rather than blaming the sender.
      if (s.status === "downloading" || s.status === "queued") {
        return pause(s, "appRestarted");
      }
      return "a restart changes nothing for a row that was not in flight";
    }

    case "SESSION_LOST": {
      /** A row left downloading with no session is where the phantom progress lived; this makes a stranded row say something true. */
      // A queued row is excluded: it has no session by definition, so pausing it would invent a problem.
      if (s.status === "downloading") {
        return pause(s, "appRestarted");
      }
      return "only a row that claims to be downloading can have lost a session";
    }

    // ---- per-file outcomes ----------------------------------------------
    case "FILE_DONE": {
      if (s.status !== "downloading") return "a file can only land while downloading";
      const filesDone =
        typeof e.filesDone === "number"
          ? Math.max(0, Math.round(e.filesDone))
          : s.filesDone + 1;
      if (filesDone === s.filesDone) return "no change";
      return { ...s, filesDone };
    }

    case "ALL_DONE": {
      if (!isAfterGrabStatus(s.status)) return "nothing was being downloaded";
      const filesDone =
        typeof e.filesDone === "number"
          ? Math.max(0, Math.round(e.filesDone))
          : s.selection.length;
      if (s.status === "done" && filesDone === s.filesDone && s.pct === 100) {
        return "already done";
      }
      return {
        ...s,
        status: "done",
        pauseReason: null,
        pct: 100,
        filesDone,
        stallRetries: 0,
      };
    }

    case "FILE_GONE": {
      if (!e.file) return "no file named";
      if (s.fileNotes[e.file] === "gone") return "already noted";
      const fileNotes = { ...s.fileNotes, [e.file]: "gone" as FileNote };
      const withNote = { ...s, fileNotes };
      if (!s.selection.includes(e.file)) return withNote;
      if (!isAfterGrabStatus(s.status) || s.status === "done" || s.status === "stopped") {
        return withNote;
      }
      const left = s.selection.filter((k) => fileNotes[k] !== "gone");
      if (left.length === 0) return settleEmptySelection(withNote);
      return pause(withNote, "filesGone");
    }

    case "LOCAL_WRITE_FAILED": {
      // These two pause and do not auto-retry; the user confirming in the picker is the only thing that tries again.
      const note: FileNote = e.reason;
      const fileNotes = e.file ? { ...s.fileNotes, [e.file]: note } : s.fileNotes;
      const withNote = { ...s, fileNotes };
      if (!isAfterGrabStatus(s.status)) return "nothing is being written";
      if (s.status === "done" || s.status === "stopped") return withNote;
      return { ...pause(withNote, e.reason), stallRetries: 0 };
    }

    // ---- the user's other gestures ---------------------------------------
    case "USER_STOP": {
      // Scenario 6. The notification's Cancel, or a stop from the picker. No
      // auto-retry: `stopped` is absent from `AUTO_RETRY_STATUSES` on purpose.
      if (s.status === "stopped") return "already stopped";
      if (!isAfterGrabStatus(s.status)) return "nothing is running to stop";
      if (s.status === "done") return "the download already finished";
      return { ...s, status: "stopped", pauseReason: null, stallRetries: 0 };
    }

    case "STOP_WAITING": {
      // Stage 1's rule, unchanged: the row leaves the loop and keeps its files.
      if (s.status === "done" || s.status === "expired") return "already terminal";
      return { ...s, status: "done", selection: [], pauseReason: null, stallRetries: 0 };
    }

    case "ROW_DELETED": {
      // Marked inert so no late event can resurrect the row after the caller stops the session.
      if (s.deleted) return "already deleted";
      return { ...s, deleted: true };
    }

    case "EXPIRY_TICK": {
      // Only the statuses that are waiting can expire, and the saved files stay.
      if (!e.expired) return "the window has not elapsed";
      if (s.status !== "waiting" && s.status !== "queued" && s.status !== "paused") {
        return "this status has no waiting window";
      }
      return { ...s, status: "expired", pauseReason: null, stallRetries: 0 };
    }
  }
}

/** The transition line, with a fixed field order and spelling, because the export is grepped for it and a reordered line is one a script cannot read. */
export function rowStateLine(
  from: RowLifecycleState,
  to: RowLifecycleState,
  reason: RowLifecycleEventType,
  shareKey?: string,
): string {
  const key = String(shareKey || "").slice(0, 6) || "------";
  return (
    `rowstate key=${key} from=${from.status} to=${to.status} reason=${reason} ` +
    `files=${to.filesDone}/${to.selection.length} pct=${to.pct}`
  );
}

/** Does this paused row want a timed retry, or has it had its three? Only a stall: the offline case is the waiting loop's business, and the two that need the user are not retried at all. */
export function wantsTimedRetry(state: RowLifecycleState): boolean {
  return (
    state.status === "paused" &&
    state.pauseReason === "stalled" &&
    // `<=`, not `<`: the Nth stall carries `stallRetries === N`, and the third
    // stall is the one entitled to the third retry.
    state.stallRetries <= STALL_RETRY_LIMIT
  );
}

/** Whether the waiting loop may act on this row at all. */
export function autoRetries(state: RowLifecycleState): boolean {
  if (state.deleted) return false;
  if (!(AUTO_RETRY_STATUSES as readonly string[]).includes(state.status)) return false;
  if (state.status === "paused" && pauseNeedsUser(state.pauseReason)) return false;
  return true;
}
