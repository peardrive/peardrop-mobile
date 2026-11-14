/** One model for a received share: every surface renders from this and nothing else. */
// One percentage, from held bytes plus the active file's own, so header, file row and list row agree by construction.

import {
  describeShareState,
  type ShareStateInput,
  type ShareStateView,
} from "../vendor/pearkit/ShareState/shareState";
import { PAUSE_REASONS, type PauseReason } from "./rowLifecycle";
import { applyRowFloor, floorSignature, type RowFloor } from "./rowFloor";
import { isExpired, type WaitingStatus } from "./waitingStatus";

/** How long a lookup's "found" answer is treated as current. */
export const SENDER_ONLINE_WINDOW_MS = 90_000;

/** How long the last peer must be gone before the row pauses. */
// Deliberately much shorter than the engine's per-file stall: the engine is deciding whether to fail a file, this is deciding what to tell the user, and those want different patience.
export const PEER_LOSS_PAUSE_MS = 5_000;

export type ViewFile = {
  readonly name: string;
  readonly size: number;
  readonly isDownloaded: boolean;
  /** Where the saved file is on disk, when it is saved. */
  // Carried through the model rather than looked up beside it, so the picker's thumbnail and its open action read the same path the row does.
  readonly localPath?: string | null;
  /** Bytes of this file already replicated, persisted so they outlive the attempt that pulled them. */
  readonly partialBytes?: number;
};

export type ShareRecordLike = {
  readonly status: WaitingStatus;
  readonly selection?: readonly string[];
  readonly missing?: readonly string[];
  readonly files: readonly ViewFile[];
  readonly lastUpdatedAt: number;
  readonly pauseReason?: string;
  /** The waiting loop's own bookkeeping, declared here so one record has one type; the model reads the answer through its lookup argument instead. */
  // Leaving them off is what made the agreement test unable to build an input, which was a fair signal the shape was incomplete rather than minimal.
  readonly lastCheckedAt?: number;
  readonly emptyChecks?: number;
};

export type TransferSnapshot = {
  readonly peersConnected?: number | null;
  /** The engine's silence verdict, which outranks everything below it. */
  // A frozen writer holds a peer count of 1 with zero bytes for about 18 s, so the peer count alone claims a sender that has gone; the engine decides from byte progress in time to matter.
  readonly engineStalled?: boolean | null;
  readonly engineSilenceMs?: number | null;
  /** When the last peer left, or null if none was ever observed leaving. */
  readonly lastPeerLeftAt?: number | null;
  /** The file being piped now. Null between files and after the loop. */
  readonly activeKey?: string | null;
  readonly activeBytes?: number | null;
  readonly activeTotal?: number | null;
};

export type ViewFileState =
  | "unselected"
  | "selected"
  | "inProgress"
  | "done"
  | "gone";

/** `cancel` is the red x. `doneMark` is the green tick and is not tappable. */
export type ViewControl = "checkbox" | "cancel" | "doneMark" | "none";

export type ShareViewFile = {
  readonly name: string;
  readonly size: number;
  readonly state: ViewFileState;
  /** Only for `inProgress`. Same byte source as `overallPct`. */
  readonly pct: number | null;
  readonly control: ViewControl;
  /** Meaningful for `checkbox` only. */
  readonly checked: boolean;
  /** Set only on `done`. What the picker opens and thumbnails. Clause 6. */
  readonly localPath: string | null;
};

export type ShareView = {
  readonly status: WaitingStatus | "expired";
  readonly senderOnline: boolean;
  /** The universal state: the word, its colour, the bar and the pause button, the same in every app. */
  readonly state: ShareStateView;
  /** `state.label`. The list row's one line. */
  readonly rowLine: string;
  readonly header: string;
  readonly hint: string | null;
  readonly button: { readonly label: string; readonly enabled: boolean } | null;
  readonly overallPct: number | null;
  readonly files: readonly ShareViewFile[];
  /** Whether the model wants the row paused. Reported rather than applied, because the reducer is the only writer of a status, and nothing renders from this. */
  readonly shouldPause: boolean;
  /** The hold this render decided, to be threaded back in on the next one, returned rather than stored so the model stays pure. */
  readonly hold: FlapHold;
  /** The floor this render decided, threaded back the same way. */
  readonly floor: RowFloor;
};

export type ShareViewInput = {
  readonly record: ShareRecordLike;
  readonly transfer?: TransferSnapshot | null;
  readonly lookup?: { readonly found: boolean; readonly at: number } | null;
  readonly now: number;
  /** What the surfaces were last told, and when. */
  // A value the caller threads through rather than a module variable, so two surfaces sharing one guard agree by construction and a test can drive a flap sequence without a clock.
  readonly hold?: FlapHold | null;
  /** The highest percentage this row has shown for this selection. Threaded like `hold`. */
  readonly floor?: RowFloor | null;
  /** The person pressed Stop sharing on this finished copy. A finished copy is Active otherwise. */
  readonly sharingOff?: boolean;
};

/** How long a decided `senderOnline` / status word is held before it may flip. */
export const FLAP_WINDOW_MS = 8_000;

export type FlapHold = {
  readonly senderOnline: boolean;
  readonly status: WaitingStatus | "expired";
  readonly at: number;
};

/** The anti-flap rule: a decided value is held for the window and the signal ignored until it expires. */
// Not a debounce, which would delay the first change too, and a finished grab is terminal and never held.
export function nextHold(
  hold: FlapHold | null | undefined,
  candidate: { senderOnline: boolean; status: WaitingStatus | "expired" },
  now: number,
): FlapHold {
  if (!hold || !Number.isFinite(hold.at)) {
    return { ...candidate, at: now };
  }
  const unchanged =
    hold.senderOnline === candidate.senderOnline && hold.status === candidate.status;
  if (unchanged) return hold;
  // Terminal states and the states a user action produces are never held: the
  // user just acted, and showing them their own tap 8 s late reads as a bug.
  const immediate =
    candidate.status === "done" ||
    candidate.status === "stopped" ||
    candidate.status === "expired" ||
    hold.status === "ready" ||
    // Resume is the person's own tap too: a paused row answers at once.
    hold.status === "stopped";
  if (immediate) return { ...candidate, at: now };
  if (now - hold.at < FLAP_WINDOW_MS) return hold;
  return { ...candidate, at: now };
}

/** The toast on tapping Grab, and its fuse. Kept here because this module owns every other string the row and the picker show, and two copy modules is how they came to disagree. */
export const GRAB_QUEUED_TOAST = "Queued. Downloads start when the sender is ready.";
export const GRAB_TOAST_DELAY_MS = 2000;

/** The after-grab hint. One line, every after-grab state. */
export const AFTER_GRAB_HINT = "Tick files to add them. They download automatically.";
export const DONE_HINT = "Tick more files to grab them.";

function norm(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

function usable(n: unknown): number {
  // Validated where it enters. `NaN` is a number and poisons every sum and
  // every comparison downstream — the shape of the `NaN` freeze verdict.
  if (!Number.isFinite(n as number)) return 0;
  return Math.max(0, n as number);
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Bytes as a short label for the Grab button, local so this module stays a leaf and the button's rounding stays its own question. */
function shortBytes(bytes: number): string {
  const b = usable(bytes);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Is the sender reachable? Two independent signals, either enough: a peer attached to the live session, or a lookup that recently found an announcer. */
// Neither is connectivity detection — a host that is off still cannot be told from discovery that has not finished — so the copy says offline only about a sender it looked for and did not find.
function isSenderOnline(input: ShareViewInput): boolean {
  // The engine's silence verdict first: a peer attached and sending nothing is the case the peer count gets wrong.
  if (input.transfer?.engineStalled === true) return false;
  if (usable(input.transfer?.peersConnected) > 0) return true;
  const lookup = input.lookup;
  if (!lookup || !lookup.found) return false;
  if (!Number.isFinite(lookup.at)) return false;
  return input.now - lookup.at <= SENDER_ONLINE_WINDOW_MS;
}

/** Validated against the reducer's exported list, because the hand-maintained copy it replaces had been mangled by a rename sweep into a duplicate and a missing entry. */
function storedReason(raw: unknown): PauseReason | null {
  return typeof raw === "string" && (PAUSE_REASONS as readonly string[]).includes(raw)
    ? (raw as PauseReason)
    : null;
}


/** The few words for a download that cannot carry on until the person does something. */
export function attentionNote(reason: PauseReason | null, gone: number): string | null {
  if (reason === "noSpace") return "Not enough space";
  if (reason === "cantWrite") return "Can't save files";
  if (reason === "filesGone") {
    const n = Math.max(1, gone);
    return `${n} ${plural(n, "file", "files")} no longer shared`;
  }
  return null;
}

/**
 * Which of the universal states a received share is in. Only this app knows that; the word, the
 * colour and the bar for each state come from Pearkit, so the phone and the desktop agree.
 *
 * - Nothing here says "paused" unless the person paused it. A download that lost its sender is
 *   Waiting, and it becomes Starting the moment the sender is found again.
 * - A finished copy is Active. It is Inactive only when the person switched its sharing off.
 */
export function receivedShareState(input: {
  status: WaitingStatus | "expired";
  senderOnline: boolean;
  reason: PauseReason | null;
  /** 0 to 100 of the chosen files, or null when nothing is chosen. */
  pct: number | null;
  /** Chosen files the share no longer has. */
  goneChosen: number;
  /** Nothing chosen and nothing saved: a row that only ever waited. */
  nothingHere: boolean;
  sharingOff: boolean;
}): ShareStateInput {
  const { status, senderOnline, reason, pct } = input;
  switch (status) {
    case "expired":
      return { kind: "inactive" };
    case "waiting":
      // Only the link is here. There is nothing to count yet.
      return { kind: "waiting" };
    case "ready":
      return { kind: "choose" };
    case "queued":
      return { kind: senderOnline ? "starting" : "waiting", percent: pct };
    case "downloading":
      return { kind: "downloading", percent: pct ?? 0 };
    case "paused": {
      const note = attentionNote(reason, input.goneChosen);
      if (note) return { kind: "attention", note };
      // No reason left on the record means the sender was found again and the download is about
      // to move. The same when the sender can be seen right now.
      return { kind: reason === null || senderOnline ? "starting" : "waiting", percent: pct };
    }
    case "stopped":
      // The person paused it. It stays put until they press Resume.
      return { kind: "paused", percent: pct };
    case "done":
      if (input.nothingHere || input.sharingOff) return { kind: "inactive" };
      return { kind: "active" };
  }
}

/** Chosen files the share does not have. */
function goneCount(
  record: ShareRecordLike,
  selection: ReadonlySet<string>,
): number {
  let n = 0;
  for (const raw of record.missing ?? []) {
    if (selection.has(norm(raw))) n++;
  }
  return n;
}

/** The model. */
/** What the record already holds for one file, so a live figure is not added on top of it. */
function storedPartialFor(record: ShareRecordLike, key: string | null): number {
  if (!key) return 0;
  for (const f of record.files) {
    if (norm(f.name) !== key) continue;
    return Math.min(usable(f.partialBytes), usable(f.size));
  }
  return 0;
}

export function shareView(input: ShareViewInput): ShareView {
  const { record, transfer, now } = input;
  const expired = isExpired(record.status, record.lastUpdatedAt, now);
  /** The raw reading, then the held one; everything below renders from the held pair. */
  // The surfaces are handed the same hold and the model is pure, so agreement about whether the sender is there is structural rather than a timing coincidence.
  const rawStatus: WaitingStatus | "expired" = expired ? "expired" : record.status;
  const rawSenderOnline = isSenderOnline(input);
  const hold = nextHold(
    input.hold,
    { senderOnline: rawSenderOnline, status: rawStatus },
    now,
  );
  const status = hold.status;
  const senderOnline = hold.senderOnline;

  const selection = new Set((record.selection ?? []).map(norm));
  const gone = new Set((record.missing ?? []).map(norm));
  /** The active file, from the engine's own key rather than guessed from the order, which is wrong the moment the engine skips an entry or the manifest reorders. */
  // A stopped row has to keep the percentage it reached, so it is inside this gate; leaving it out made the line read zero.
  const activeKey =
    (status === "downloading" || status === "paused" || status === "stopped") &&
    transfer?.activeKey
      ? norm(transfer.activeKey)
      : null;
  const activeBytes = usable(transfer?.activeBytes);
  const activeTotal = usable(transfer?.activeTotal);

  // On disk, plus the active file's own bytes, and nothing else.
  // The per-download wire figure is deliberately excluded: it spans every file an attempt touched, so adding it to the held sizes double-counts anything that completed in the same attempt.
  let selectedTotal = 0;
  let heldBytes = 0;
  let filesDone = 0;
  /** Bytes of selected files that are part-replicated, from the record rather than the engine,
   *  whose figure is per-attempt and goes to zero when one ends. */
  let partialBytes = 0;
  for (const f of record.files) {
    const key = norm(f.name);
    if (!selection.has(key)) continue;
    const size = usable(f.size);
    selectedTotal += size;
    if (f.isDownloaded) {
      heldBytes += size;
      filesDone++;
    } else {
      partialBytes += Math.min(usable(f.partialBytes), size);
    }
  }

  const activeIsSelected = !!activeKey && selection.has(activeKey);
  const activePct =
    activeIsSelected && activeTotal > 0
      ? clampPct((Math.min(activeBytes, activeTotal) / activeTotal) * 100)
      : activeIsSelected
        ? 0
        : null;

  let overallPct: number | null = null;
  if (selection.size > 0) {
    if (selectedTotal > 0) {
      // The live figure only where it has overtaken what is stored for the same file; the wire
      // figure stays excluded, because it spans files already counted in `heldBytes`.
      const live = activeIsSelected ? Math.min(activeBytes, activeTotal) : 0;
      const activeStored = activeIsSelected ? storedPartialFor(record, activeKey) : 0;
      const fresh = partialBytes + Math.max(0, live - activeStored);
      overallPct = clampPct(((heldBytes + Math.min(fresh, selectedTotal - heldBytes)) / selectedTotal) * 100);
    } else {
      // No usable sizes anywhere. The file count is the only honest
      // denominator left; a coarse figure beats 0% for a half-finished grab.
      overallPct = clampPct((filesDone / selection.size) * 100);
    }
  }
  if (status === "done") overallPct = 100;
  // The floor is applied last, over the finished figure, and is keyed to this selection and its
  // total so a changed share never inherits the previous one's high-water mark.
  const floored = applyRowFloor(
    input.floor,
    floorSignature(record.selection, selectedTotal),
    overallPct,
  );
  overallPct = floored.pct;

  /** The single-file identity, enforced here rather than hoped for: with one selected file the share is that file, so the two numbers must be the same number. */
  // The arithmetic is algebraically identical only while the two totals agree, and they come from the record and the engine; when they disagree the record wins, because that is what the row, the button and storage already agree on.
  const singleSelected = selection.size === 1;
  const fileOverride =
    singleSelected && overallPct !== null && activePct !== null ? overallPct : null;

  // ---- per-file rows -----------------------------------------------------
  const files: ShareViewFile[] = record.files.map((f) => {
    const key = norm(f.name);
    const size = usable(f.size);
    const selected = selection.has(key);

    if (gone.has(key)) {
      return {
        name: f.name,
        size,
        state: "gone",
        pct: null,
        control: "none",
        checked: false,
        localPath: null,
      };
    }
    if (f.isDownloaded) {
      return {
        name: f.name,
        size,
        state: "done",
        pct: null,
        control: "doneMark",
        checked: true,
        localPath: f.localPath ?? null,
      };
    }
    if (selected && key === activeKey) {
      return {
        name: f.name,
        size,
        state: "inProgress",
        pct: fileOverride ?? activePct ?? 0,
        // The red x, never a checkbox. Invariant 5.
        control: "cancel",
        checked: true,
        localPath: null,
      };
    }
    return {
      name: f.name,
      size,
      state: selected ? "selected" : "unselected",
      pct: null,
      control: "checkbox",
      checked: selected,
      localPath: null,
    };
  });

  // ---- the 5 s peer-loss rule -------------------------------------------
  const leftAt = transfer?.lastPeerLeftAt;
  /** Two independent reasons to pause, and the engine's is the one that fires on a real network. */
  // The peer-loss rule needs a disconnect event, measured about 18 s late against a frozen writer; the engine's silence verdict arrives far sooner and needs no socket event at all.
  const shouldPause =
    status === "downloading" &&
    (transfer?.engineStalled === true ||
      (usable(transfer?.peersConnected) === 0 &&
        typeof leftAt === "number" &&
        Number.isFinite(leftAt) &&
        now - leftAt >= PEER_LOSS_PAUSE_MS));

  // ---- copy --------------------------------------------------------------
  const pct = overallPct ?? 0;
  const reason = storedReason(record.pauseReason);
  const selectedBytes = Math.max(0, selectedTotal - heldBytes);

  const nothingHere = selection.size === 0 && !record.files.some((f) => f.isDownloaded);
  const state = describeShareState(
    receivedShareState({
      status,
      senderOnline,
      reason,
      pct: overallPct,
      goneChosen: goneCount(record, selection),
      nothingHere,
      sharingOff: input.sharingOff === true,
    }),
  );
  // The list row says the state and nothing else. The window with the files says a little more.
  const rowLine = state.label;
  let header = state.label;
  let hint: string | null = null;
  let button: { label: string; enabled: boolean } | null = null;

  switch (status) {
    case "expired":
      header = "Stopped waiting.";
      break;

    case "waiting":
      header = "Sender offline. Files appear when they're back.";
      break;

    case "ready":
      header = senderOnline
        ? "Sender online. Choose files to grab."
        : "Sender offline. Choose files now; they download when the sender is back.";
      // The only status with a button.
      button = {
        label: `Grab ${selection.size} (${shortBytes(selectedBytes)})`,
        enabled: selection.size > 0,
      };
      break;

    case "queued":
    case "paused":
      if (state.kind === "waiting") {
        header = pct > 0 ? `Waiting for the sender · ${pct}%` : "Waiting for the sender";
      } else if (state.kind === "starting") {
        header = "Sender found. Starting";
      }
      hint = AFTER_GRAB_HINT;
      break;

    case "downloading":
      // The file count appears only above one file, because a count of one reads worse than no count.
      if (selection.size > 1) header = `${state.label} · ${filesDone} of ${selection.size} saved`;
      hint = AFTER_GRAB_HINT;
      break;

    case "stopped":
      // The person paused this one. Nothing apologises and nothing retries; Resume is the only way on.
      hint = AFTER_GRAB_HINT;
      break;

    case "done":
      // Nothing held and no selection is a row that stopped waiting; calling it saved would claim a file that never arrived.
      header = nothingHere ? "Stopped waiting." : "All chosen files saved.";
      hint = DONE_HINT;
      break;
  }

  return {
    status,
    senderOnline,
    state,
    rowLine,
    header,
    hint,
    button,
    overallPct,
    files,
    shouldPause,
    hold,
    floor: floored.floor,
  };
}
