export type DriveStateValue = "active" | "inactive" | "creating" | "seeking" | "failed";
export type DriveOrigin = "hosted" | "received";

export type BackendEvent =
  | { type: "listening" }
  | { type: "connected"; direction: string }
  | { type: "error"; message: string }
  | { type: "debug"; where?: string; msg?: string }
  /**
   * A log line from the Bare worklet realm. The worklet never writes the
   * log file itself — two realms appending to one path with no lock tears
   * it — so it ships lines here and RN feeds its single writer.
   */
  | {
      type: "log";
      level?: "debug" | "info" | "warn" | "error";
      tag?: string;
      msg?: string;
      at?: number;
    }
  | {
      type: "upload-progress";
      driveId?: string;
      peerId?: string;
      percent?: number;
      bytesTransferred?: number;
      totalBytes?: number;
      driveSize?: number;
      totalSentBytes?: number;
    }
  | {
      type: "upload-complete";
      driveId?: string;
      peerId?: string;
      totalBytes?: number;
      duration?: number;
      driveSize?: number;
      totalSentBytes?: number;
    }
  /**
   * The user stopped this transfer: not a failure and not a completion. A
   * separate member rather than a flag on `upload-complete`, because a flag
   * is one forgotten check away from congratulating a user on a transfer
   * they just stopped. `filesKept` is what landed before the cancel; it is
   * not always zero and the UI must not imply that it is.
   */
  | {
      type: "transfer-cancelled";
      driveId?: string;
      direction?: "upload" | "download";
      filesKept?: number;
      totalBytes?: number;
      duration?: number;
    }
  /**
   * How a receive ended. Its own member rather than a field on
   * `upload-complete`, which has several producers with disjoint payloads,
   * so a flag would read `undefined` on whichever one was not updated.
   * `partial` is not a success: a user told "complete" will not go looking
   * for the rest. Every field is optional, because a worklet bundle older
   * than the JS is a real runtime state — readers gate on
   * `outcome === "complete"` and fail closed.
   */
  | {
      type: "download-outcome";
      driveId?: string;
      outcome?: "complete" | "partial" | "failed";
      /** Files actually written to disk. */
      filesKept?: number;
      /** Files that were asked for and did not arrive. */
      filesFailed?: number;
      totalBytes?: number;
      duration?: number;
    }
  | { type: "drive-created"; driveId?: string; shareLink?: string }
  | {
      type: "drive-hydrated";
      driveId?: string;
      shareLink?: string;
      key?: string;
      state?: DriveStateValue;
      origin?: DriveOrigin;
    }
  | {
      type: "drive-activated";
      driveId?: string;
      shareLink?: string;
      key?: string;
    }
  | { type: "drive-deactivated"; driveId?: string }
  | { type: "drive-hydration-failed"; driveId?: string; error?: string }
  | { type: "drive-stopped"; driveId?: string; purged?: boolean }
  | { type: "peer-connected"; driveId?: string; peerId?: string; shareName?: string; totalBytes?: number }
  /**
   * `delivered` means at least one peer finished, never that the active
   * peer set is empty — that reading lets a hosted row claim completion
   * when a peer who downloaded nothing walks away. Several producers emit
   * this event and only the hosted one can know, so the field is optional
   * and `undefined` must read as not delivered: gate on `=== true`, which
   * also makes a JS-newer-than-bundle install fail closed.
   */
  | {
      type: "peer-disconnected";
      driveId?: string;
      peerId?: string;
      delivered?: boolean;
      deliveredPeers?: number;
    }
  | { type: "download-peer-disconnected"; driveId?: string }
  /**
   * Emitted when a peer-supplied key fails the path-traversal guard. Typed
   * here and logged, because a security-relevant event must not be
   * silently discarded.
   */
  | { type: "peer-rejected"; driveId?: string; cause?: string; key?: string }
  /**
   * Worklet liveness heartbeat, emitted on a fixed interval while the
   * heartbeat is enabled and by nothing else. `n` is a monotonic counter
   * within one run and `at` is the worklet's own clock. Both matter: RN
   * stamps its receive time alongside, and continuous worklet stamps
   * arriving bunched is a different answer from gapped worklet stamps.
   */
  | { type: "worklet-tick"; n?: number; at?: number }
  /**
   * The worklet's wake for an expired idle-host grace. A hosted share whose
   * last peer left holds the foreground service for that window, and only
   * the worklet keeps time while the app is backgrounded, so the engine
   * times it on its alive ticker. It carries no verdict: RN re-runs its own
   * predicate on receipt, so a wake for a drive already released does
   * nothing. Every field optional — an older worklet emits nothing here,
   * which must read as no wake rather than as an error.
   */
  | { type: "host-idle-grace-elapsed"; driveId?: string; idleMs?: number; at?: number };

/**
 * The canonical drive-file shape: one concept, one type. Several shapes spell
 * `name` while meaning different things, and mixing them breaks size lookups.
 * `key` addresses the drive and keeps its leading `/`; never render it.
 * `displayName` is for humans. The engine holds a mirror; the two move together.
 */
export type DriveFileRef = {
  /** The drive entry key, leading `/` included. Addresses; never rendered. */
  key: string;
  /** What a human sees. Renders; never addresses. */
  displayName: string;
  /** Declared bytes from the share manifest. */
  size: number;
};

/**
 * The persisted shape. `name` here is the display name and `storagePath`
 * is `key` with its leading `/` stripped — see `DriveFileRef` for why that
 * is a trap worth naming.
 */
export type DriveFileEntry = {
  /** @deprecated The DISPLAY name. Canonical field: `displayName`. */
  name: string;
  /** @deprecated `key` without its leading `/`. Canonical field: `key`. */
  storagePath?: string;
  size?: number;
  /** The canonical key. Written on every entry this build produces. */
  key?: string;
  /** The canonical display name. Written on every entry produced here. */
  displayName?: string;
};

export type DriveLocalFile = {
  name: string;
  path: string;
  size: number;
};

export type DriveRecord = {
  id: string;
  key?: string;
  shareLink?: string;
  name?: string;
  state?: DriveStateValue;
  origin?: DriveOrigin;
  isUpload?: boolean;
  totalBytes?: number;
  files?: DriveFileEntry[];
  /** Local on-disk paths for downloaded files, present only on a received
   *  drive. This is what lets the UI offer to open a file elsewhere. */
  localFiles?: DriveLocalFile[];
  /**
   * The user explicitly re-shared this received copy. Written when a
   * received drive that holds every file in its manifest is activated with
   * `serve: true`. This is persisted intent, not live swarm state: at boot,
   * a received drive gets a swarm only if it is reshared and complete, and
   * then as a server. Whether it is announcing right now is `mode`, which
   * is what the link and QR affordances key off. Optional only so an older
   * reply parses.
   */
  reshared?: boolean;
  createdAt?: number;
  lastActivityAt?: number;
};

export type BridgeStatus = {
  stub?: boolean;
  baseDir?: string | null;
  started?: boolean;
  activeCount?: number;
  pendingOpen?: number;
  /**
   * Engine liveness counter, incremented on a fixed interval inside the
   * worklet. Only advances while the process is actually executing, so
   * comparing it against elapsed wall-clock time is what distinguishes
   * "backgrounded" from "frozen by the OS".
   */
  aliveTicks?: number;
  /** Cadence of the above, in ms. Reported so RN needn't hardcode it. */
  aliveTickMs?: number;
  /**
   * The manifest file exists but the engine could not read it, after
   * retries: it is running on an empty placeholder, every manifest write is
   * refused, and share creation and receive are rejected. The UI blocks
   * those actions while this holds, and it clears when a later load
   * succeeds. `undefined` means an older worklet, never an unchecked state.
   */
  manifestUnavailable?: boolean;
  /**
   * The largest gap in ms between two firings of the worklet's alive ticker
   * since the engine started. Monotonic and never reset, so it describes
   * the whole process lifetime and not one background window: use it for a
   * log line, never as a grading input.
   */
  maxTickGapMs?: number;
  /**
   * The freeze grader's gap input: every inter-tick gap of two intervals or
   * more, oldest first and capped in the engine. Window-scope it against
   * the tick count taken when the window opened, which is what
   * `largestWorkletTickGapMs` does — read it from there, never re-derive
   * it. An empty array positively states that no such gap was seen, and is
   * the normal state of a healthy device; `undefined` says the worklet does
   * not report the field at all.
   */
  tickGaps?: TickGap[];
};

/** One entry of `BridgeStatus.tickGaps`, produced only by the engine. */
export type TickGap = {
  /** The `aliveTicks` value that closed this gap. */
  tick: number;
  /** Wall-clock milliseconds between the two tick firings. */
  gapMs: number;
};

export type SharePathsResult = {
  ok: boolean;
  error?: string;
  driveId?: string;
  shareLink?: string;
  key?: string;
};

/**
 * What a drive's swarm is actually doing. `"server"` announces, so another
 * device can find it from the link — the only mode in which a link is worth
 * copying. `"client"` dials out and advertises nothing: enough to grab,
 * useless to a receiver holding the link. `"none"` is a live session with
 * no swarm at all, the normal state of a received drive after boot, so it
 * cannot announce blobs it never fetched.
 */
export type DriveSwarmMode = "server" | "client" | "none";

/**
 * The result of activating a drive, stating the swarm mode it set up. The
 * mode has to be on the wire: boot hydration leaves every received drive
 * registered with no swarm, so a reply that only said `ok` would report
 * success for a drive announcing nothing. `already` is true only when the
 * swarm was already in the requested mode and the call did no work; `mode`
 * is the mode afterwards and `previousMode` what was found. Link and QR
 * affordances gate on `mode === "server"`, never on a stored intent and
 * never on `ok` alone.
 */
export type DriveActivateResult = {
  ok: boolean;
  error?: string;
  driveId?: string;
  shareLink?: string;
  key?: string;
  /** The swarm mode in force when this call returned. */
  mode?: DriveSwarmMode;
  /** The mode the session was in when the call arrived. */
  previousMode?: DriveSwarmMode;
  /** What the caller asked for, after the origin-derived default was applied. */
  requestedMode?: DriveSwarmMode;
  /**
   * True ONLY when `previousMode === requestedMode` — the session already
   * existed and was already in the mode asked for, so nothing was changed.
   * Never a statement that the drive is merely "already open".
   */
  already?: boolean;
  /** True when the existing session's Corestore was reused rather than reopened. */
  reusedSession?: boolean;
  /**
   * Why a `serve: true` request did not produce a server swarm.
   * `"incomplete"` means the drive does not hold every file in its
   * manifest, and a copy that cannot serve its files must not advertise
   * itself as a source; the drive was still activated, so `ok` is true.
   * Read it only to choose the message — the gate is still `mode`.
   */
  serveRefused?: "incomplete" | null;
};

export type OpenLinkResult = {
  ok: boolean;
  error?: string;
  driveId?: string;
  /**
   * `name` is the drive entry key here, not a display name — see
   * `DriveFileRef`. `key` is the canonical spelling of the same value and
   * is present on every entry this build returns.
   */
  files?: { name: string; displayName?: string; size?: number; key?: string }[];
  shareName?: string | null;
  totalBytes?: number;
  /**
   * True only when the engine parsed the share's manifest off the drive: the
   * listing fallback can populate `files` with no manifest at all. Required so a
   * site that forgets it is a compile error, but the engine is not typechecked,
   * so a value crossing the RPC may be `undefined` and readers gate on `=== true`.
   */
  hasManifest: boolean;
  /** Set when the share's manifest declares more files than the entry cap
   *  allows, so the UI can say how many of how many are shown. */
  truncated?: { available: number; shown: number };
};

export type DownloadResult = {
  ok: boolean;
  error?: string;
  /**
   * the user cancelled part-way. `ok` stays true — the call did
   * what was asked — so this is the ONLY way a caller can tell a cancelled
   * grab from a complete one. `files` carries whatever finished first.
   */
  cancelled?: boolean;
  files?: { name: string; path: string; size: number }[];
  failed?: { key: string; error: string }[];
  totalBytes?: number;
  duration?: number;
  destDir?: string;
};

export type TransferDirection = "upload" | "download" | "unknown";
export type TransferOrigin = "hosted" | "received" | "unknown";

export type TransferSummary = {
  driveId: string;
  /**
   * Who owns the drive on this device: "hosted" was created here and peers
   * connecting are downloading from it, "received" came from a share link.
   * The authoritative grouping signal for the two sides of the UI.
   */
  origin: TransferOrigin;
  /** Derived from `origin`, which is what new readers should prefer. */
  direction: TransferDirection;
  percent: number | null;
  bytesTransferred: number;
  totalBytes: number | null;
  driveSize: number | null;
  totalSentBytes: number;
  peersConnected: number;
  peerIds: string[];
  /** True only on explicit upload-complete (never implied by percent ≥ 100). */
  completed: boolean;
  /**
   * The user stopped this one. Sits alongside `completed` rather than
   * replacing it, because a cancelled transfer is over and every "this is
   * over" reader keys off that field. `cancelled` says how it ended, so the
   * paths that celebrate and the paths that apologise can both opt out.
   */
  cancelled: boolean;
  /**
   * How many files were already on disk when the cancel landed, or `null`
   * when that is not known. `null` is a real value and not a placeholder
   * for 0: a locally-settled cancel has no event behind it and so no count,
   * and reading a missing count as zero prints "nothing saved" over files
   * that are on disk. Only ever written alongside `cancelled: true`, so
   * readers gate on that rather than on this being non-null.
   */
  filesKept: number | null;
  /**
   * How a receive ended, and the counts behind it. Written only by the
   * `download-outcome` handler, so it is `undefined` on every hosted
   * transfer and on any received one still running. It is the only thing
   * separating a grab where every file landed from one where every file
   * failed, since `completed: true` is set for both. Not folded into
   * `filesKept`, whose contract is that readers gate on `cancelled`.
   * Readers treat `undefined` as not known, which a hosted row always is.
   */
  downloadOutcome?: {
    outcome: "complete" | "partial" | "failed";
    /** Files written to disk. */
    kept: number;
    /** Files that were asked for and did not arrive. */
    failed: number;
  };
  /**
   * True once at least one progress event has been processed, which
   * separates "connected but nothing flowing" from "data is moving"
   * without trusting the engine's unreliable percent. It also gates the
   * stall detector, so a slow start is not read as a stall.
   */
  progressEverReceived: boolean;
  /**
   * True when a received transfer that had been progressing has gone quiet
   * past the stall threshold. It fires the could-not-finish toast once and
   * then stays true, so lingering on the same stuck card does not re-fire
   * it. Hosted transfers do not use this flag: the same detector flips
   * them straight to `completed: true`.
   */
  stalled: boolean;
  lastEventAt: number;
  /**
   * When `peersConnected` last fell to zero, or null if it never has. Feeds
   * the idle-host grace window. `lastEventAt` is deliberately not reused:
   * every event bumps it, so it cannot tell a peer that left nine minutes
   * ago from something unrelated two seconds ago, and that difference is
   * whether the foreground service is released or held.
   */
  lastPeerLeftAt: number | null;
};
