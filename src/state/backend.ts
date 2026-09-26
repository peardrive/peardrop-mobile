import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  type AppStateStatus,
  DeviceEventEmitter,
} from "react-native";

import b4a from "b4a";
import RPC from "bare-rpc";
import { Worklet } from "react-native-bare-kit";
import RNFS from "react-native-fs";

import type {
  BackendEvent,
  BridgeStatus,
  DownloadResult,
  DriveActivateResult,
  DriveRecord,
  OpenLinkResult,
  SharePathsResult,
  TickGap,
  TransferOrigin,
  TransferSummary,
} from "./types";
import {
  baseTransfer,
  upsertTransfer as upsertTransferReducer,
  type TransferUpdate,
} from "./transfers";

import {
  RPC_EVENT,
  RPC_LISTEN,
  RPC_HYPERDRIVE_SHARE,
  RPC_HYPERDRIVE_STOP,
  RPC_HYPERDRIVE_OPEN,
  RPC_HYPERDRIVE_ABORT,
  RPC_HYPERDRIVE_CANCEL,
  RPC_HYPERDRIVE_DOWNLOAD,
  RPC_HYPERDRIVE_STATUS,
  RPC_DRIVES_LIST,
  RPC_DRIVES_PAUSE,
  RPC_DRIVES_RESUME,
  RPC_TEST_FAKE_UPLOAD,
  RPC_TEST_FAKE_DOWNLOAD,
  RPC_REFRESH_SWARM,
  RPC_SET_DEBUG_LOGGING,
} from "../../rpc-commands.mjs";

import {
  invoke,
  sendOneWay,
  type FakeUploadOpts,
  type FakeDownloadOpts,
  type FakeDownloadResult,
} from "../lib/rpc";
import { upsertShare } from "./receivedSharesStorage";
import {
  flush as flushDebugLog,
  initDebugLog,
  logChangeGated,
  logFromBackend,
  logStructuredError,
  parseWorkletBundleId,
  setWorkletBundleId,
  log as debugLog,
} from "../lib/debugLog";
import { awaitDebugLogging, subscribeDebugLogging } from "./debugLogStorage";
import { initDeviceIdentityLog } from "../lib/deviceIdentity";
import {
  activeTransfers,
  decideServiceTransition,
  describeActivity,
  IDLE_HOST_GRACE_MS,
  IDLE_HOST_GRACE_WAKE_PAD_MS,
  isTransferActive,
  msUntilActivityCouldChange,
  nextLastPeerLeftAt,
} from "../lib/transferActivity";
import {
  drainPendingCancel,
  EVENT_CANCEL_ALL,
  isForegroundServiceAvailable,
  isScreenOn,
  startForegroundService,
  stopForegroundService,
  updateServiceProgress,
} from "../lib/foregroundService";
import {
  classifyNotificationPost,
  describeTransferNotification,
  type LastPost,
} from "../lib/notificationProgress";
import { IS_DEBUG_BUILD } from "../lib/devGate";
import { parseAliveReading } from "../lib/aliveTicks";
import { evaluateFreeze } from "../lib/freezeDetect";
import { DEFAULT_STALL_MS, evaluateStall } from "../lib/transferStall";
import { recordFreeze, recordServiceWindow } from "./backgroundHealthStorage";
import { SERVICE_FREEZE_THRESHOLD } from "../lib/backgroundHealthModel";
import { tickRatio } from "../lib/freezeGrade";
import { decideFreezeWindow } from "./freezeWindowPolicy";
import { runReceivedReconcile } from "./reconcileReceivedRunner";
import type { EngineDriveLike } from "../lib/reconcileReceived";
import { addSent } from "./statsStorage";
import { haptics } from "../lib/haptics";
import { notifyTransferComplete } from "../lib/notifications";

import bundle from "../../app/app.bundle.mjs";

/**
 * Content hash of the packed worklet, parsed once at module load. It is what
 * tells a fresh RN bundle running over a stale worklet from a matched pair.
 * The artifact is a compile-time import, so the value cannot change during a
 * session.
 */
export const WORKLET_BUNDLE_ID: string | null = parseWorkletBundleId(
  bundle as unknown as string
);
// Set at module scope rather than in an effect: the log writer needs it before
// the first effect can run.
setWorkletBundleId(WORKLET_BUNDLE_ID);

/**
 * The engine status reply, plus the identity of the bundle it is running.
 * `BridgeStatus` is what the worklet says about itself; `workletBundleId` is
 * what RN knows about the code it handed over. The pairing is the point —
 * either half alone is not a complete build statement.
 */
export type WorkletStatus = BridgeStatus & { workletBundleId?: string };

export type BackendAPI = {
  ready: boolean;
  status: string;
  logs: string[];
  /**
   * The engine status reply, carrying `workletBundleId` alongside what the
   * worklet says about itself.
   */
  hyperdriveStatus: WorkletStatus | null;
  /**
   * True when the engine cannot read the manifest and is running on an empty
   * placeholder: it refuses every manifest write, and share creation and
   * receive fail. The UI blocks those two actions. This is where the RN side
   * reads that state — do not re-derive it.
   */
  manifestUnavailable: boolean;
  /**
   * Content hash of the packed worklet. Read it here and do not re-derive it:
   * a second reader of `app/app.bundle.mjs` can be fresh while the running
   * worklet is stale, which is the trap this value exists to detect. `null`
   * means the header could not be parsed. Never a guess.
   */
  workletBundleId: string | null;
  /** Unified list of every drive the engine knows about (active + inactive,
   *  hosted + received). Source of truth for the main page list. */
  drives: DriveRecord[];
  /** driveIds whose engine sessions are currently active (announcing). */
  activeDriveIds: Set<string>;
  /** driveIds the engine knows about but isn't announcing. */
  inactiveDriveIds: Set<string>;
  /** driveIds whose hydration failed (corestore missing, corrupted, etc.). */
  failedHydrationIds: Set<string>;
  transfers: TransferSummary[];
  /**
   * `shareName` travels to the receiver. Omit it and the engine generates a
   * default name instead.
   */
  sharePaths: (
    paths: string[],
    relPaths?: string[],
    shareName?: string,
  ) => Promise<SharePathsResult>;
  openLink: (link: string) => Promise<OpenLinkResult>;
  startDownload: (payload: {
    driveId: string;
    destDir?: string;
    fileName?: string;
    fileNames?: string[];
  }) => Promise<DownloadResult>;
  runFakeUploadTest: (
    opts?: FakeUploadOpts & { simulate?: "hosted" | "received" }
  ) => Promise<{
    ok: boolean;
    driveId?: string;
    error?: string;
  }>;
  /** simulated receive. Debug builds only. */
  runFakeDownloadTest: (opts?: FakeDownloadOpts) => Promise<FakeDownloadResult>;
  /** Stop and destroy. This is the delete path — see the implementation. */
  cancelTransfer: (
    driveId: string,
    opts?: { purge?: boolean }
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * stop an in-flight transfer, keeping the share and the bytes
   * already written. This is what a Cancel button calls.
   */
  cancelInFlight: (driveId: string) => Promise<{
    ok: boolean;
    error?: string;
    unwinding?: boolean;
    alreadyInactive?: boolean;
  }>;
  clearTransfer: (driveId: string) => void;
  abortOpen: (
    driveId?: string
  ) => Promise<{ ok: boolean; aborted?: number; error?: string }>;
  /**
   * Bring an inactive drive back online. Hosted drives announce, received
   * drives join client-only, and `{ serve: true }` is the explicit opt-in that
   * makes a received copy announce. Only `mode === "server"` means a peer can
   * find it; `already` means the swarm was already in the requested mode.
   */
  activateDrive: (
    driveId: string,
    opts?: { serve?: boolean }
  ) => Promise<DriveActivateResult>;
  /** take an active drive offline without destroying its data. */
  deactivateDrive: (driveId: string) => Promise<{ ok: boolean; error?: string }>;
  refreshStatus: () => Promise<void>;
  refreshDrives: () => Promise<void>;
  refreshSwarm: () => Promise<void>;
};

const BackendContext = createContext<BackendAPI | null>(null);

/**
 * Cap on drive IDs held in either origin set, in case a drive-stopped event
 * never arrives and the set would otherwise grow for the life of the app. 64
 * is comfortably above realistic concurrent-drive counts.
 */
const DRIVE_ORIGIN_SET_MAX = 64;

/**
 * Cadence of the RN-side control heartbeat. Deliberately the same interval as
 * the worklet's own tick, so the two streams can be read side by side.
 */
const RN_HEARTBEAT_INTERVAL_MS = 2000;

/**
 * The freeze grader's gap input, and the only place it is derived. An entry
 * whose `tick` is above the mark closed inside the window. Returns `null`,
 * never `0`, when no `tickGaps` arrived at all: not measured is a different
 * claim from measured and no gap seen, which is `0`.
 */
export function largestWorkletTickGapMs(
  tickGaps: TickGap[] | undefined,
  sinceTick: number
): number | null {
  if (!Array.isArray(tickGaps)) return null;
  let largest = 0;
  for (const entry of tickGaps) {
    if (!entry) continue;
    // `Number.isFinite` because NaN is a number, and a NaN reaching a
    // threshold comparison manufactures a clean verdict. Validate at entry.
    if (!Number.isFinite(entry.tick) || !Number.isFinite(entry.gapMs)) continue;
    if (entry.tick <= sinceTick) continue;
    if (entry.gapMs > largest) largest = entry.gapMs;
  }
  return largest;
}

function rememberDriveOrigin(set: Set<string>, driveId: string): void {
  if (!driveId) return;
  if (set.has(driveId)) return;
  set.add(driveId);
  if (set.size > DRIVE_ORIGIN_SET_MAX) {
    // Set iteration order is insertion order, so the first value is the
    // oldest entry. Evict it to keep the cap.
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export function BackendProvider({ children }: { children: React.ReactNode }) {
  const workletRef = useRef<InstanceType<typeof Worklet> | null>(null);
  const rpcRef = useRef<InstanceType<typeof RPC> | null>(null);

  // Origin tracking: the authoritative way to tell a hosted drive from one
  // received via a link. Backend events do not reliably distinguish them.
  const hostedIdsRef = useRef<Set<string>>(new Set());
  const receivedIdsRef = useRef<Set<string>>(new Set());
  /**
   * Drive ids belonging to a simulated download. Read only by the
   * foreground-service decision line, so an exported log can never show a
   * real-looking receive that was synthetic.
   */
  const simulatedDriveIdsRef = useRef<Set<string>>(new Set());
  /** Latest debugging-flag value, readable from the boot effect. */
  const debugEnabledRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("booting");
  const [logs, setLogs] = useState<string[]>([]);
  const [hyperdriveStatus, setHyperdriveStatus] = useState<WorkletStatus | null>(
    null
  );
  const [drives, setDrives] = useState<DriveRecord[]>([]);
  const [transfers, setTransfers] = useState<TransferSummary[]>([]);
  /**
   * A synchronously-current mirror of `transfers`, for readers that cannot be
   * React subscribers — the AppState background handler would otherwise close
   * over a stale array. Written only by `commitTransfers` below.
   */
  const transfersRef = useRef<TransferSummary[]>([]);
  /**
   * Whether the service was started for the current background window. A
   * freeze with no service running is not evidence the mechanism failed; it
   * is Android behaving correctly toward an idle app.
   */
  const serviceStartedForWindowRef = useRef<boolean>(false);
  /**
   * Mirror of `drives` for the notification's name lookup. Same reason as
   * `transfersRef`: the feed runs inside `commitTransfers`, which cannot be a
   * React subscriber. Written beside the single `setDrives` call.
   */
  const drivesRef = useRef<DriveRecord[]>([]);
  /**
   * What was last pushed to the ongoing notification, and when. Null means
   * nothing posted in this service window, so the first update of the next
   * window always posts instead of being suppressed as a duplicate.
   */
  const lastNotificationRef = useRef<LastPost | null>(null);
  /**
   * Completion-path persistence still in flight. Serialized so the stop path
   * has a single thing to await, and so two completions landing together
   * cannot interleave their read-modify-write of the lifetime stats blob.
   */
  const pendingStatsWriteRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * Worst observed gap between worklet heartbeats in the current background
   * window. Tick counts alone cannot tell a steadily-ticking window from one
   * that stalled and then caught up. Updated in every build: two number
   * writes, far cheaper than the gated log call beside it.
   */
  const heartbeatGapRef = useRef<{ lastAt: number; maxGapMs: number }>({
    lastAt: 0,
    maxGapMs: 0,
  });
  const [activeDriveIds, setActiveDriveIds] = useState<Set<string>>(new Set());
  const [inactiveDriveIds, setInactiveDriveIds] = useState<Set<string>>(new Set());
  const [failedHydrationIds, setFailedHydrationIds] = useState<Set<string>>(new Set());

  const logId = useRef(0);
  /**
   * The in-memory ring behind the dev-facing `logs` array, fanned out to the
   * file writer so every call site in this file gets timestamps and
   * persistence from the one wrap.
   */
  const appendLog = useCallback((line: string) => {
    const id = ++logId.current;
    setLogs((p) => [`${id}: ${line}`, ...p].slice(0, 120));
    debugLog("info", "rn.backend", line);
  }, []);

  /**
   * A state transition, on a tag the ring protects. Identical to `appendLog`
   * except for the tag: `rn.backend` has too many hot call sites to be a
   * priority tag, so the `setStatus` transitions get their own and the
   * must-survive set can be classified by tag. Drive-level lines are not.
   */
  const appendStateLog = useCallback((line: string) => {
    const id = ++logId.current;
    setLogs((p) => [`${id}: ${line}`, ...p].slice(0, 120));
    debugLog("info", "rn.state", line);
  }, []);

  /** Structured-error variant — keeps category, cause and detail. */
  const appendErrorLog = useCallback(
    (context: string, err: unknown) => {
      const id = ++logId.current;
      setLogs((p) => [`${id}: ${context}`, ...p].slice(0, 120));
      logStructuredError("rn.backend", context, err);
    },
    []
  );

  const originFor = useCallback((driveId: string): TransferOrigin => {
    if (hostedIdsRef.current.has(driveId)) return "hosted";
    if (receivedIdsRef.current.has(driveId)) return "received";
    return "unknown";
  }, []);

  /**
   * The only way to write `transfers`. The ref is written inside the updater,
   * not at call sites and not in an effect, because the AppState background
   * handler reads it synchronously to decide the foreground service and a
   * stale read there is undetectable. Never call `setTransfers` elsewhere.
   */
  /**
   * Resolve a display name for a drive, or null. Best-effort by design: the
   * manifest does not carry a received drive while its download is in flight,
   * so `describeTransferNotification` reads correctly without it.
   */
  const driveDisplayName = useCallback((driveId: string): string | null => {
    const record = drivesRef.current.find((d) => d.id === driveId);
    if (!record) return null;
    const named = typeof record.name === "string" ? record.name.trim() : "";
    if (named) return named;
    // A single-file share reads better as its file than as its drive.
    const files = record.files;
    if (Array.isArray(files) && files.length === 1) {
      const only = files[0]?.name;
      if (typeof only === "string" && only.trim()) return only.trim();
    }
    return null;
  }, []);

  /**
   * Push the current transfer set to the ongoing notification. Engine-driven
   * and never on a timer: RN timers record no ticks at all while backgrounded,
   * so a timer-fed notification would stop updating exactly when it is the
   * only thing the user can see. Engine callbacks keep running because the
   * foreground service keeps the process scheduled.
   */
  const pushNotification = useCallback(
    (list: TransferSummary[]) => {
      const now = Date.now();
      const content = describeTransferNotification(list, now, driveDisplayName);
      // Both exits are recorded, change-gated on the decision plus the content:
      // this runs once per transfer mutation, so an ungated line would flood
      // the log it exists to make readable. The gate still forces one line per
      // heartbeat window, so a quiet stretch reads as quiet, not as nothing.
      if (!content) {
        logChangeGated(
          "info",
          "rn.notify",
          "notify",
          "suppressed-empty",
          `posted=suppressed-empty (nothing active to describe) transfers=${list.length}`,
          now
        );
        return;
      }
      const decision = classifyNotificationPost(
        lastNotificationRef.current,
        content,
        now
      );
      logChangeGated(
        "info",
        "rn.notify",
        "notify",
        `${decision}|${content.title}|${content.text}|${content.percent}|${content.cancelLabel}`,
        `posted=${decision} title=${JSON.stringify(content.title)} ` +
          `text=${JSON.stringify(content.text)} percent=${content.percent} ` +
          `cancel=${JSON.stringify(content.cancelLabel)}`,
        now
      );
      if (decision !== "posted") return;
      lastNotificationRef.current = { at: now, content };
      void updateServiceProgress(
        content.title,
        content.text,
        content.percent,
        // The Cancel action's label travels with the content it describes, so
        // the button and the title cannot disagree about how many it stops.
        content.cancelLabel
      );
    },
    [driveDisplayName]
  );

  const commitTransfers = useCallback(
    (next: (prev: TransferSummary[]) => TransferSummary[]) => {
      setTransfers((prev) => {
        const value = next(prev);
        transfersRef.current = value;
        // Hung inside the updater beside the ref write: this is the one place
        // every transfer mutation passes through, so no future call site can
        // forget the feed. A StrictMode second pass is dropped as identical.
        pushNotification(value);
        return value;
      });
    },
    [pushNotification]
  );

  const upsertTransfer = useCallback(
    (driveId: string, update: TransferUpdate) => {
      commitTransfers((prev) =>
        upsertTransferReducer(prev, driveId, update, originFor)
      );
    },
    [commitTransfers, originFor]
  );

  /**
   * Mark a transfer as stopped by the user. One function for both callers, so
   * a cancelled row has a single shape. `completed: true` because it is over,
   * `cancelled: true` beside it so the celebratory path can opt out.
   * `lastPeerLeftAt: null` is the load-bearing one: a non-null stamp holds the
   * foreground service through the idle-host grace window, and the swarm is
   * already destroyed, so nothing can reconnect. Only the service predicate
   * reads that field; if anything else starts to, this write becomes wrong.
   */
  const markCancelled = useCallback(
    /**
     * Pass `null` — never 0 — when there is no count: the locally-settled
     * path has no event behind it, and a zero there would tell the user
     * "nothing saved" about files that are on disk.
     */
    (driveId: string, filesKept: number | null = null) => {
      upsertTransfer(driveId, (prev) => ({
        ...prev,
        completed: true,
        cancelled: true,
        filesKept,
        stalled: false,
        peersConnected: 0,
        peerIds: [],
        lastPeerLeftAt: null,
        lastEventAt: Date.now(),
      }));
    },
    [upsertTransfer]
  );

  const refreshStatus = useCallback(async () => {
    try {
      const obj = await invoke(rpcRef.current, RPC_HYPERDRIVE_STATUS, {} as Record<string, never>);
      if (obj?.ok && obj.status) {
        // Merged onto the status reply so a consumer cannot read one without
        // the other. Omitted when unparsed: a wrong attribution is worse.
        setHyperdriveStatus(
          WORKLET_BUNDLE_ID
            ? { ...obj.status, workletBundleId: WORKLET_BUNDLE_ID }
            : obj.status
        );
      }
    } catch (err: unknown) {
      appendErrorLog(`status: ${String((err as Error)?.message || err)}`, err);
    }
  }, [appendErrorLog]);

  const refreshDrives = useCallback(async () => {
    try {
      const obj = await invoke(rpcRef.current, RPC_DRIVES_LIST, {} as Record<string, never>);
      if (obj?.ok && Array.isArray(obj.drives)) {
        const list = obj.drives as DriveRecord[];
        setDrives(list);
        // Beside the only `setDrives` in the file, for the same reason
        // `transfersRef` is written inside `commitTransfers`.
        drivesRef.current = list;
        // Reconcile state sets against the engine's authoritative manifest.
        const nextActive = new Set<string>();
        const nextInactive = new Set<string>();
        for (const d of list) {
          if (!d.id) continue;
          if (d.state === "active") nextActive.add(d.id);
          else if (d.state === "inactive") nextInactive.add(d.id);
          // Re-seed origin sets so unsolicited events on hydrated drives
          // route to the correct origin bucket.
          if (d.origin === "received") rememberDriveOrigin(receivedIdsRef.current, d.id);
          else rememberDriveOrigin(hostedIdsRef.current, d.id);
        }
        setActiveDriveIds(nextActive);
        setInactiveDriveIds(nextInactive);
        debugLog(
          "debug",
          "rn.drives",
          `refreshDrives: ${list.length} drives, active=${nextActive.size} inactive=${nextInactive.size}`
        );
      }
    } catch (err: unknown) {
      appendErrorLog(`drives: ${String((err as Error)?.message || err)}`, err);
    }
  }, [appendErrorLog]);

  const sharePaths = useCallback(async (
    paths: string[],
    relPaths?: string[],
    // The name the user chose. Goes to the engine at creation, so it reaches
    // the wire and the receiver rather than only local storage.
    shareName?: string,
  ) => {
    const res = await invoke(rpcRef.current, RPC_HYPERDRIVE_SHARE, {
      paths,
      relPaths,
      shareName,
    });
    if (res?.ok && res.driveId) {
      rememberDriveOrigin(hostedIdsRef.current, res.driveId);
      // Seed a hosted transfer so the Share tab can show the bundle card
      // immediately, before any peer connects.
      upsertTransfer(res.driveId, () => baseTransfer(res.driveId!, "hosted"));
    }
    return res;
  }, [upsertTransfer]);

  const openLink = useCallback(async (link: string) => {
    const res = await invoke(rpcRef.current, RPC_HYPERDRIVE_OPEN, { link: link.trim() });
    if (res?.ok && res.driveId) {
      // Marked "received" before startDownload so any early peer events are
      // attributed to the right origin.
      rememberDriveOrigin(receivedIdsRef.current, res.driveId);
    }
    return res;
  }, []);

  const startDownload = useCallback(
    async (payload: {
      driveId: string;
      destDir?: string;
      fileName?: string;
      fileNames?: string[];
    }) => {
      if (payload?.driveId) {
        rememberDriveOrigin(receivedIdsRef.current, payload.driveId);
        upsertTransfer(payload.driveId, (prev) => ({
          ...prev,
          origin: "received",
          direction: "download",
        }));
      }
      return invoke(rpcRef.current, RPC_HYPERDRIVE_DOWNLOAD, payload);
    },
    [upsertTransfer]
  );

  const abortOpen = useCallback(async (driveId?: string) => {
    return invoke(rpcRef.current, RPC_HYPERDRIVE_ABORT, driveId ? { driveId } : {});
  }, []);

  /**
   * Recover received files the engine wrote to disk but RN never recorded.
   * Fetches the drive list fresh so a resume that races the state update
   * still reconciles against the engine's current truth. Event-driven: RN's
   * timers are frozen for the whole of a backgrounded window.
   */
  /**
   * Background-freeze detection. On the way out, snapshot the wall clock and
   * the engine's liveness counter; on the way back, ask again. Wall-clock
   * time passes whether the process ran or was frozen, so the difference
   * between elapsed time and ticks taken is the only available evidence.
   */
  const freezeMarkRef = useRef<{ at: number; ticks: number } | null>(null);

  /**
   * When the app most recently became foreground-active. The stall watchdog
   * may not rule until a full uninterrupted foreground window has elapsed.
   * Seeded at mount, because a fresh launch is a foreground start.
   */
  const foregroundSinceRef = useRef<number>(Date.now());

  const readAliveTicks = useCallback(async (): Promise<{
    ticks: number;
    intervalMs: number;
    /**
     * The worklet's own inter-tick gap record, carried through untouched.
     * `undefined` means a worklet that does not report one.
     */
    tickGaps?: TickGap[];
    /** Since engine start, ms. For the log line only — not window-scoped. */
    maxTickGapMs?: number;
  } | null> => {
    try {
      const obj = await invoke(
        rpcRef.current,
        RPC_HYPERDRIVE_STATUS,
        {} as Record<string, never>
      );
      // Requires `started === true`, not just well-typed counters: a failed
      // init pins the tick counter at 0 while status calls keep succeeding.
      const reading = parseAliveReading(obj?.status);
      if (!reading) return null;
      return {
        ...reading,
        tickGaps: obj?.status?.tickGaps,
        maxTickGapMs: obj?.status?.maxTickGapMs,
      };
    } catch {
      return null;
    }
  }, []);

  /**
   * Every background/resume cycle emits exactly one paired trace: one line on
   * the way out, one in `checkForFreeze` on the way back. Without both, "no
   * freeze" and "never measured" are the same silence in an exported log.
   * Not gated on build type — the pair must work in a release APK too.
   */
  /**
   * The service lifecycle decision for one background window. Reads
   * `transfersRef`, never `transfers`, which the calling effect closes over
   * stale, and the one predicate in `transferActivity.ts`. The decision is
   * logged either way: the service's own outcome lines are absent exactly
   * when it never started, which is the case most in need of explanation.
   */
  const applyServiceForBackground = useCallback((trigger = "appstate-background") => {
    const now = Date.now();
    const list = transfersRef.current;
    const active = isTransferActive(list, now);
    // Printed unconditionally: `simulated=0` on a real run is as load-bearing
    // as `simulated=1`, or a log reader cannot tell the two runs apart.
    const simulatedCount = list.filter((t) =>
      simulatedDriveIdsRef.current.has(t.driveId)
    ).length;
    debugLog(
      "warn",
      "rn.fgs",
      `background decision ${describeActivity(list, now)} ` +
        `simulated=${simulatedCount} ` +
        `service=${active ? "START" : "skip"} ` +
        // Two triggers can reach this line, and an exported log has to say
        // which one ran: they are different measurements of one mechanism.
        `trigger=${trigger} ` +
        `available=${isForegroundServiceAvailable()} at=${now}`
    );
    serviceStartedForWindowRef.current = active;
    if (active) {
      // A fresh window starts with no post history, so the first update is
      // never suppressed as a duplicate of a notification already gone.
      lastNotificationRef.current = null;
      void startForegroundService(trigger).then(() => {
        // Prime the content immediately, chained onto the start rather than
        // fired beside it: `updateServiceProgress` is a no-op until the
        // service is believed running.
        pushNotification(transfersRef.current);
      });
    }
    return active;
  }, [pushNotification]);

  /**
   * The release half, as one stable function. `useCallback(…, [])` is
   * required: the boot effect's dep array lists it, and a changing identity
   * there restarts the worklet, so this body reads only refs and module-level
   * imports. It can only ever release — guarded on
   * `serviceStartedForWindowRef`, so a caller wrong about there being a
   * service does nothing, which is what makes it safe to call from an engine
   * event. Returns whether it released.
   */
  const releaseServiceIfInactive = useCallback((trigger: string): boolean => {
    if (!serviceStartedForWindowRef.current) return false;
    const now = Date.now();
    const list = transfersRef.current;
    if (isTransferActive(list, now)) {
      // Held, and the log says for how long and what is expected to end it: a
      // long hold must read as either waiting out a grace window or stuck.
      const wait = msUntilActivityCouldChange(list, now);
      debugLog(
        "warn",
        "rn.fgs",
        `service held — ${describeActivity(list, now)} trigger=${trigger} ` +
          `graceEndsInMs=${wait ?? "n/a"} wakeRealm=worklet at=${now}`
      );
      return false;
    }
    debugLog(
      "warn",
      "rn.fgs",
      `releasing service — ${describeActivity(list, now)} trigger=${trigger} at=${now}`
    );
    serviceStartedForWindowRef.current = false;
    // Let the completion write land before the service goes: the predicate
    // went false because a transfer completed, and its write is in flight.
    void (async () => {
      await pendingStatsWriteRef.current;
      await stopForegroundService("predicate-false");
      // See the twin on the appstate-active path.
      lastNotificationRef.current = null;
    })();
    return true;
  }, []);

  const markBackgrounded = useCallback(async () => {
    // Reset the gap window alongside the tick mark, so the gap reported at
    // resume describes this background window and not an earlier stall.
    heartbeatGapRef.current = { lastAt: Date.now(), maxGapMs: 0 };
    const reading = await readAliveTicks();
    freezeMarkRef.current = reading
      ? { at: Date.now(), ticks: reading.ticks }
      : null;
    debugLog(
      "warn",
      "rn.freeze",
      reading
        ? `mark taken ticks=${reading.ticks} tickMs=${reading.intervalMs} at=${Date.now()}`
        : `mark FAILED at=${Date.now()} — engine status unreachable, ` +
            `this background window CANNOT be judged`
    );
  }, [readAliveTicks]);

  const checkForFreeze = useCallback(async () => {
    const mark = freezeMarkRef.current;
    freezeMarkRef.current = null;
    if (!mark) {
      debugLog(
        "warn",
        "rn.freeze",
        "no mark on resume — the background window was never measured"
      );
      return;
    }
    const reading = await readAliveTicks();
    if (!reading) {
      debugLog(
        "warn",
        "rn.freeze",
        `resume read FAILED after ${Date.now() - mark.at}ms backgrounded — ` +
          `verdict unavailable`
      );
      return;
    }

    const verdict = evaluateFreeze({
      elapsedMs: Date.now() - mark.at,
      ticksAtBackground: mark.ticks,
      ticksNow: reading.ticks,
      tickIntervalMs: reading.intervalMs,
    });

    // Attribute the window before ruling on it: a freeze with no service
    // running is Android freezing an idle app, and a screen-locked window is
    // a different test of the mechanism from an on-screen one.
    const serviceRunning = serviceStartedForWindowRef.current;
    serviceStartedForWindowRef.current = false;
    const screenOn = await isScreenOn();
    const attribution =
      `${serviceRunning ? "service-running" : "no-service"}/` +
      `${screenOn === null ? "screen-unknown" : screenOn ? "screen-on" : "screen-locked"}`;

    // The evidence behind the verdict, logged whether or not it froze: a
    // boolean alone cannot tell a stalled window from a clean one, so the
    // ratio and the worst gap go on every line.
    const gaps = heartbeatGapRef.current;
    const largestGapMs = Math.max(
      gaps.maxGapMs,
      gaps.lastAt > 0 ? Date.now() - gaps.lastAt : 0
    );
    /**
     * The same quantity, measured by the party that was actually running.
     * `largestGapMs` above is built from tick events the worklet emits only
     * when RN asked for a heartbeat, which it does only in a debug build, so
     * in a release APK it is always 0. `null` means no field, which is not
     * `0`. Logged on every freeze verdict, frozen or not.
     */
    const workletGapMs = largestWorkletTickGapMs(reading.tickGaps, mark.ticks);
    const ratio = tickRatio(verdict);
    /**
     * The grader is fed `workletGapMs`, not `largestGapMs`, which is always 0
     * in a release APK and would decide the gap clause on a quantity nobody
     * measured. The null is passed through, never coerced to 0: that would
     * manufacture a healthy grade out of an absent measurement. `frozen` does
     * not depend on the gap at all. The policy lives in
     * `freezeWindowPolicy.ts` because this function is unreachable from jest.
     */
    const decision = decideFreezeWindow(
      verdict,
      workletGapMs,
      reading.intervalMs
    );
    const grade = decision.grade;
    const evidence =
      `ticks ${verdict.observedTicks}/${verdict.expectedTicks} ` +
      `ratio=${ratio === null ? "n/a" : ratio.toFixed(3)} ` +
      `largest-gap=${largestGapMs}ms ` +
      `worklet-gap=${workletGapMs === null ? "n/a" : `${workletGapMs}ms`} ` +
      `worklet-max-gap=${
        reading.maxTickGapMs === undefined ? "n/a" : `${reading.maxTickGapMs}ms`
      } ` +
      // Appended, never replacing a field: the ungraded reasons mean very
      // different things about the device.
      `ungraded-reason=${decision.ungradedReason ?? "n/a"}`;

    if (!verdict.frozen) {
      // `reason` distinguishes a genuine clean run from a window too short to
      // judge and from an engine restart.
      debugLog(
        "info",
        "rn.freeze",
        `not frozen (${verdict.reason}) ticks ${verdict.observedTicks}/${verdict.expectedTicks} ` +
          `over ${verdict.elapsedMs}ms backgrounded`
      );
      debugLog(
        "info",
        "rn.freeze.attr",
        `${attribution} grade=${grade ?? "ungraded"} reason=${verdict.reason} ` +
          `${evidence} elapsed=${verdict.elapsedMs}ms`
      );
      // Only a graded window with the service actually running moves the
      // streak; an ungraded one proves nothing, so it neither adds nor clears.
      if (serviceRunning && grade) {
        const next = await recordServiceWindow(grade);
        debugLog(
          grade === "healthy" ? "info" : "warn",
          "rn.freeze.attr",
          grade === "healthy"
            ? `service healthy window — streak reset to ${next.serviceFreezeStreak}`
            : `service ${grade} window — streak ${next.serviceFreezeStreak}/${SERVICE_FREEZE_THRESHOLD}` +
              (next.fallbackTriggeredAt > 0 ? " — FALLBACK TRIGGERED" : "")
        );
      }
      return;
    }
    /**
     * The grading floor governs the record, not only the grade. A window
     * below it cannot tell a freeze from a tick landing the wrong side of the
     * boundary, and `freezeCount` is persisted, outlives the session and
     * survives every reset, so it must not be polluted by one.
     */
    if (!decision.recordFreeze) {
      // Logged, not silent: an ungraded freeze that writes nothing is the
      // outcome most likely to be misread as a bug later.
      debugLog(
        "warn",
        "rn.freeze",
        `frozen ${(verdict.frozenFraction * 100).toFixed(0)}% of ${verdict.elapsedMs}ms ` +
          `backgrounded — NOT RECORDED, window ungraded ` +
          `(${decision.ungradedReason ?? "unknown"}). OD-2: a window this short ` +
          `cannot tell a freeze from a tick landing the wrong side of the boundary. ` +
          `${evidence}`
      );
      debugLog(
        "warn",
        "rn.freeze.attr",
        `${attribution} grade=ungraded reason=${verdict.reason} ` +
          `${evidence} elapsed=${verdict.elapsedMs}ms`
      );
      return;
    }
    await recordFreeze(verdict.elapsedMs, verdict.frozenFraction);
    debugLog(
      "warn",
      "rn.freeze",
      `frozen ${(verdict.frozenFraction * 100).toFixed(0)}% of ${verdict.elapsedMs}ms ` +
        `backgrounded (ticks ${verdict.observedTicks}/${verdict.expectedTicks})`
    );
    debugLog(
      "warn",
      "rn.freeze.attr",
      `${attribution} grade=${grade ?? "ungraded"} reason=${verdict.reason} ` +
        `${evidence} elapsed=${verdict.elapsedMs}ms`
    );
    if (!serviceRunning) {
      // Explicit, because silence here would be indistinguishable from a bug.
      debugLog(
        "info",
        "rn.freeze.attr",
        "no-service freeze — streak untouched (an idle app being frozen is not a fault)"
      );
      return;
    }
    if (!grade) return;
    const next = await recordServiceWindow(grade);
    debugLog(
      "warn",
      "rn.freeze.attr",
      `service ${grade} window — streak ${next.serviceFreezeStreak}/${SERVICE_FREEZE_THRESHOLD}` +
        (next.fallbackTriggeredAt > 0 ? " — FALLBACK TRIGGERED" : "")
    );
  }, [readAliveTicks]);

  const reconcileReceived = useCallback(
    async (reason: string) => {
      try {
        const obj = await invoke(
          rpcRef.current,
          RPC_DRIVES_LIST,
          {} as Record<string, never>
        );
        if (!obj?.ok || !Array.isArray(obj.drives)) return;
        const recovered = await runReceivedReconcile(
          obj.drives as EngineDriveLike[],
          reason
        );
        // The Received list subscribes to receivedFilesStorage, so the
        // back-fill propagates without an extra refresh here.
        if (recovered > 0) appendLog(`Recovered ${recovered} received file(s).`);
      } catch {
        // runReceivedReconcile already logs its own failures; a failure to
        // even fetch the drive list is not worth a second error line.
      }
    },
    [appendLog]
  );

  const refreshSwarm = useCallback(async () => {
    try {
      await invoke(rpcRef.current, RPC_REFRESH_SWARM, {} as Record<string, never>);
    } catch (err: unknown) {
      appendErrorLog(`refresh-swarm: ${String((err as Error)?.message || err)}`, err);
    }
  }, [appendErrorLog]);

  const runFakeUploadTest = useCallback(
    async (opts?: FakeUploadOpts & { simulate?: "hosted" | "received" }) => {
      const { simulate = "hosted", ...wireOpts } = opts || {};
      const res = await invoke(rpcRef.current, RPC_TEST_FAKE_UPLOAD, wireOpts);
      if (res?.ok && res.driveId) {
        if (simulate === "received") {
          rememberDriveOrigin(receivedIdsRef.current, res.driveId);
        } else {
          rememberDriveOrigin(hostedIdsRef.current, res.driveId);
        }
      }
      return res;
    },
    []
  );

  /**
   * Start a simulated download. Does the two things a real grab does, in the
   * same order and through the same functions: the engine writes a received
   * manifest entry, and `upsertShare` records the share. Skip either and the
   * simulation produces a transfer that renders on no row at all.
   */
  const runFakeDownloadTest = useCallback(
    async (opts?: FakeDownloadOpts) => {
      const res = await invoke(
        rpcRef.current,
        RPC_TEST_FAKE_DOWNLOAD,
        (opts ?? {}) as FakeDownloadOpts
      );
      if (!res?.ok || !res.driveId || !res.shareKey) return res;

      rememberDriveOrigin(receivedIdsRef.current, res.driveId);
      // Tracked so the foreground-service decision line can say the run was
      // synthetic: no exported log may show a real receive that was simulated.
      simulatedDriveIdsRef.current.add(res.driveId);

      const now = Date.now();
      try {
        await upsertShare({
          shareKey: res.shareKey.toLowerCase(),
          shareLink: res.shareLink ?? `peardrop://${res.shareKey}`,
          // The simulated receive is the one path exercisable without a second
          // phone, so it records the same facts a real one does.
          driveId: res.driveId,
          shareName: opts?.shareName ?? "Simulated receive",
          firstSeenAt: now,
          lastUpdatedAt: now,
          files: (res.files ?? []).map((f: { name: string; size: number }) => ({
            name: f.name,
            path: f.name,
            size: f.size,
            isDownloaded: false,
          })),
        });
      } catch (err: unknown) {
        appendErrorLog("fake-download: upsertShare failed", err);
      }

      debugLog(
        "warn",
        "rn.simulate",
        `fake-download started drive=${res.driveId} shareKey=${res.shareKey.slice(0, 12)}… ` +
          `bytes=${res.totalBytes ?? "?"} holdAtPercent=${res.holdAtPercent ?? 0} ` +
          `durationMs=${res.durationMs ?? "?"} — SIMULATED, no network, no disk`
      );

      await refreshDrives();
      return res;
    },
    [appendErrorLog, refreshDrives]
  );

  /**
   * Stop and destroy a drive. This is the delete path — `purge` defaults to
   * true, which removes the corestore. Not the right call for a Cancel
   * button: use `cancelInFlight`, because cancelling an upload through this
   * function deletes the user's share. Every caller here is a real removal.
   */
  const cancelTransfer = useCallback(
    async (driveId: string, opts?: { purge?: boolean }) => {
      const id = String(driveId || "").trim();
      if (!id) return { ok: false, error: "driveId is required" };
      return invoke(rpcRef.current, RPC_HYPERDRIVE_STOP, {
        driveId: id,
        purge: opts?.purge !== false,
      });
    },
    []
  );

  /**
   * Stop a transfer that is happening right now, keeping the share and any
   * bytes already on disk. No optimistic local state is written: only the
   * engine knows whether a cancel caught anything, so its event moves the UI.
   * The one exception is `alreadyInactive`, where no event is coming.
   */
  const cancelInFlight = useCallback(
    async (driveId: string) => {
      const id = String(driveId || "").trim();
      if (!id) return { ok: false, error: "driveId is required" };
      debugLog("warn", "rn.cancel", `cancel requested drive=${id} at=${Date.now()}`);
      const res = await invoke(rpcRef.current, RPC_HYPERDRIVE_CANCEL, { driveId: id });
      debugLog(
        "warn",
        "rn.cancel",
        `cancel reply drive=${id} ok=${res?.ok} unwinding=${!!res?.unwinding} ` +
          `alreadyInactive=${!!res?.alreadyInactive}`
      );
      // No `transfer-cancelled` is coming, so settle the row here — marked
      // the same way the event marks it, so the UI has one shape to read.
      if (res?.ok && res.alreadyInactive) {
        // No `filesKept`: the engine is saying nothing counted anything, and
        // `null` makes the row read "Stopped" instead of inventing a number.
        markCancelled(id);
      }
      return res;
    },
    [markCancelled]
  );

  /**
   * Cancel every transfer that is currently active. A foreground service may
   * own one notification and it carries no driveId, so its button cannot
   * target a single transfer. The set comes from `activeTransfers`, the same
   * predicate that held the service, so the button cancels exactly the set
   * the notification describes. Reads `transfersRef`, not `transfers`: this
   * runs from a native callback outside the render cycle.
   */
  const cancelAllActive = useCallback(
    async (reason: string) => {
      const now = Date.now();
      const list = transfersRef.current;
      const active = activeTransfers(list, now);
      debugLog(
        "warn",
        "rn.cancel",
        `cancel-all (${reason}) — ${describeActivity(list, now)} at=${now}`
      );
      if (active.length === 0) return;
      await Promise.all(
        active.map(({ index }) => {
          const driveId = list[index]?.driveId;
          return driveId ? cancelInFlight(driveId) : Promise.resolve(undefined);
        })
      );
    },
    [cancelInFlight]
  );

  /**
   * `cancelAllActive` behind a ref. The AppState effect that drains a queued
   * cancel also owns the swarm refresh interval, so listing the function in
   * its deps would buy a swarm-refresh storm for every identity change. The
   * ref leaves those deps alone while still calling the current function.
   */
  const cancelAllActiveRef = useRef(cancelAllActive);
  cancelAllActiveRef.current = cancelAllActive;

  /**
   * The notification's Cancel action arriving from the native side — the one
   * native-to-JS push in this app. `DeviceEventEmitter` is the matching
   * receiver for `emitDeviceEvent`, so no native module instance is involved
   * and nothing can be null at subscribe time. This is an event, not a
   * timer, so it does not depend on the interval timers that die in the
   * background.
   */
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(EVENT_CANCEL_ALL, () => {
      void cancelAllActive("notification-action");
    });
    return () => sub.remove();
  }, [cancelAllActive]);

  /**
   * `opts.serve` is the explicit announce opt-in. Omit it and the engine
   * applies its origin-derived default: hosted announces, received stays
   * client-only. Read `res.mode`, never `res.ok` alone — `ok: true` only
   * means a live session, while `mode === "server"` means it can be found.
   */
  const activateDrive = useCallback(async (driveId: string, opts?: { serve?: boolean }) => {
    const id = String(driveId || "").trim();
    if (!id) return { ok: false, error: "driveId is required" };
    // The payload widening is asserted here because the RPC payload types do
    // not yet carry `serve`. The wire is JSON and the worklet already reads
    // it, so this is a typing gap and not a behaviour gap.
    const serve = opts?.serve;
    const payload = (
      serve === undefined ? { driveId: id } : { driveId: id, serve }
    ) as { driveId: string };
    const res = await invoke(rpcRef.current, RPC_DRIVES_RESUME, payload);
    if (res?.ok) {
      rememberDriveOrigin(hostedIdsRef.current, id);
      setActiveDriveIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setInactiveDriveIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    return res;
  }, []);

  const deactivateDrive = useCallback(async (driveId: string) => {
    const id = String(driveId || "").trim();
    if (!id) return { ok: false, error: "driveId is required" };
    const res = await invoke(rpcRef.current, RPC_DRIVES_PAUSE, { driveId: id });
    if (res?.ok) {
      setActiveDriveIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setInactiveDriveIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
    return res;
  }, []);

  const clearTransfer = useCallback(
    (driveId: string) => {
      const id = String(driveId || "").trim();
      if (!id) return;
      // Via commitTransfers, so the ref the service decision reads loses the
      // drive at the same instant the state does; this can be a stop trigger.
      commitTransfers((prev) => prev.filter((t) => t.driveId !== id));
      hostedIdsRef.current.delete(id);
      receivedIdsRef.current.delete(id);
    },
    [commitTransfers]
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const storagePath = RNFS.DocumentDirectoryPath;
        const worklet = new Worklet();
        worklet.start("/app.bundle", bundle, [storagePath]);

        const { IPC } = worklet;
        // bare-kit's IPC is duck-compatible with what bare-rpc expects, but
        // the two packages share no TypeScript interface, hence the cast.
        const rpc = new RPC(IPC as unknown as ConstructorParameters<typeof RPC>[0], (req) => {
          try {
            if (req.command !== RPC_EVENT) return;
            if (!req.data) return;
            const evt = JSON.parse(b4a.toString(req.data as unknown as Uint8Array)) as BackendEvent;

            // Log lines from the Bare worklet. Handled first: the highest
            // frequency, and they must never reach the UI state machine.
            if (evt.type === "log") {
              logFromBackend(evt);
              return;
            }
            // Worklet liveness heartbeat, handled next for the same reason.
            // Two clocks on one line: a gap in the worklet's own stamp means
            // the engine stopped, while continuous stamps arriving bunched
            // mean the engine ran and the IPC queued. The `return` sits
            // outside the debug gate so a release build still swallows the
            // event instead of letting it reach the UI state machine.
            if (evt.type === "worklet-tick") {
              // Track the worst inter-tick gap. Ungated and before the debug
              // branch: the freeze attribution needs this in every build.
              {
                const at = Date.now();
                const gaps = heartbeatGapRef.current;
                if (gaps.lastAt > 0) {
                  const gap = at - gaps.lastAt;
                  if (gap > gaps.maxGapMs) gaps.maxGapMs = gap;
                }
                gaps.lastAt = at;
              }
              if (IS_DEBUG_BUILD) {
                debugLog(
                  "info",
                  "rn.heartbeat",
                  `worklet n=${evt.n ?? "?"} worklet-at=${evt.at ?? "?"} rn-at=${Date.now()}`
                );
              // Android halts RN's interval timers while the app is
              // backgrounded, the log writer's own flush timer included, so
              // entries sit in memory and an OS kill destroys the evidence
              // this probe collects. A timer cannot fix a frozen-timer
              // problem: this callback is native-driven and still runs, so
              // the drain rides it. Foreground keeps its own flush timer.
                // A forced disk write on every tick while backgrounded.
                // Diagnostic only, so it stays inside the dev-build gate.
                if (AppState.currentState !== "active") void flushDebugLog();
              }
              return;
            }
            if (evt.type === "listening") {
              setStatus("listening");
              appendStateLog("Backend listening.");
              return;
            }
            if (evt.type === "error") {
              setStatus("error");
              appendStateLog(`Error: ${evt.message}`);
              return;
            }
            if (evt.type === "upload-progress") {
              // Only the log line is gated, never the event: this fires up to
              // 10 Hz on a download and an unconditional line per event
              // destroys the retained ring. The event still sets
              // `lastEventAt`, which feeds the stall watchdog and the ongoing
              // notification, and suppressing it would make an attached idle
              // peer indistinguishable from a stalled one. Gated on driveId
              // and percent, not bytes, which change on every event.
              logChangeGated(
                "info",
                "rn.progress",
                `progress:${evt.driveId ?? "unknown"}`,
                `${evt.percent ?? "?"}`,
                `progress drive=${evt.driveId ?? "unknown"} percent=${evt.percent ?? "?"} ` +
                  `bytes=${evt.bytesTransferred ?? "?"} total=${evt.totalBytes ?? "?"}`
              );
              if (evt.driveId) {
                upsertTransfer(evt.driveId, (prev) => ({
                  ...prev,
                  percent:
                    typeof evt.percent === "number" ? evt.percent : prev.percent,
                  bytesTransferred:
                    typeof evt.bytesTransferred === "number"
                      ? evt.bytesTransferred
                      : prev.bytesTransferred,
                  totalBytes:
                    typeof evt.totalBytes === "number"
                      ? evt.totalBytes
                      : prev.totalBytes,
                  driveSize:
                    typeof evt.driveSize === "number"
                      ? evt.driveSize
                      : prev.driveSize,
                  totalSentBytes:
                    typeof evt.totalSentBytes === "number"
                      ? evt.totalSentBytes
                      : typeof evt.bytesTransferred === "number"
                        ? evt.bytesTransferred
                        : prev.totalSentBytes,
                  // Not marked completed here, even at 100%: completion comes
                  // from an explicit event, so the UI can clamp at 99.
                  completed: prev.completed,
                  // Flips on first progress event, because the engine's
                  // percent is unreliable on hosted transfers: this is what
                  // separates "connected" from "data is moving".
                  progressEverReceived: true,
                  // Any progress clears `stalled`. Without this the
                  // watchdog's flag outlives every later progress event and
                  // the row reads "Stopped — tap to retry" while bytes are
                  // landing. The clear belongs here, the one place that
                  // already knows bytes arrived, and it is unconditional:
                  // the event itself is the evidence.
                  stalled: false,
                  lastEventAt: Date.now(),
                }));
              }
              return;
            }
            if (evt.type === "upload-complete") {
              appendLog(
                `Done ${evt.totalBytes != null ? `${evt.totalBytes} B` : ""} (${
                  evt.duration ?? "?"
                } ms)`
              );
              if (evt.driveId) {
                // Tally lifetime sent bytes only for hosted drives: each
                // upload-complete is one peer finishing its copy, so the sum
                // is a coarse but accurate data-shared counter. Received
                // drives are counted at download completion instead.
                if (hostedIdsRef.current.has(evt.driveId)) {
                  const delta =
                    typeof evt.totalBytes === "number" ? evt.totalBytes : 0;
                  // Tracked rather than fired and forgotten: this event flips
                  // the activity predicate false and triggers the service
                  // stop, and that path awaits the chain before releasing.
                  if (delta > 0) {
                    pendingStatsWriteRef.current = pendingStatsWriteRef.current
                      .then(() => addSent(delta))
                      .catch(() => {});
                  }
                }
                // The receive path is not handled here: it emits
                // `download-outcome`, and one terminal branch must decide a
                // grab's success. The haptic and the notification are
                // hosted-only. A non-hosted drive reaching this means the
                // packed worklet is older than this JS, so it is logged
                // loudly while the row below still settles.
                const isHosted = hostedIdsRef.current.has(evt.driveId);
                if (isHosted) {
                  // Pulse a success haptic at the moment a hosted transfer
                  // wraps: a peer finished pulling our drive.
                  haptics.success();
                  // A local nudge while backgrounded; a no-op in the
                  // foreground or when permission was denied.
                  void notifyTransferComplete({
                    title: "Share delivered",
                    body: "A peer finished pulling your share.",
                  });
                } else {
                  debugLog(
                    "warn",
                    "rn.event",
                    `upload-complete for a NON-HOSTED drive=${evt.driveId} — the receive path ` +
                      `moved to download-outcome (D-07). This means the packed worklet is older ` +
                      `than this JS; re-run npm run bundle:backend.`
                  );
                }
                upsertTransfer(evt.driveId, (prev) => ({
                  ...prev,
                  percent: 100,
                  bytesTransferred:
                    typeof evt.totalBytes === "number"
                      ? evt.totalBytes
                      : prev.bytesTransferred,
                  totalBytes:
                    typeof evt.totalBytes === "number"
                      ? evt.totalBytes
                      : prev.totalBytes,
                  driveSize:
                    typeof evt.driveSize === "number"
                      ? evt.driveSize
                      : prev.driveSize ??
                        (typeof evt.totalBytes === "number"
                          ? evt.totalBytes
                          : null),
                  totalSentBytes:
                    typeof evt.totalSentBytes === "number"
                      ? evt.totalSentBytes
                      : typeof evt.totalBytes === "number"
                        ? evt.totalBytes
                        : prev.totalSentBytes,
                  completed: true,
                  lastEventAt: Date.now(),
                }));
              }
              return;
            }
            /**
             * The receive path's terminal event, not routed through the
             * `upload-complete` handler: that one fires a success haptic
             * unconditionally and this has three outcomes. `completed: true`
             * on all three, since the transfer is over either way and every
             * "this is over" reader keys off that field; `downloadOutcome`
             * says how it ended. `percent` reaches 100 only on `complete`.
             * An unrecognised outcome fails closed to `failed`.
             */
            if (evt.type === "download-outcome") {
              const outcome =
                evt.outcome === "complete" || evt.outcome === "partial"
                  ? evt.outcome
                  : "failed";
              const kept =
                typeof evt.filesKept === "number" && Number.isFinite(evt.filesKept)
                  ? evt.filesKept
                  : 0;
              const failed =
                typeof evt.filesFailed === "number" && Number.isFinite(evt.filesFailed)
                  ? evt.filesFailed
                  : 0;
              appendLog(
                `Download ${outcome} — ${kept} saved, ${failed} not saved (${
                  evt.duration ?? "?"
                } ms)`
              );
              debugLog(
                outcome === "complete" ? "info" : "warn",
                "rn.download",
                `download-outcome drive=${evt.driveId ?? "?"} outcome=${outcome} ` +
                  `kept=${kept} failed=${failed} bytes=${evt.totalBytes ?? 0} ` +
                  `duration=${evt.duration ?? "?"}ms`
              );
              if (evt.driveId) {
                // Positive feedback only where it is earned: a partial grab is
                // a soft failure, and the haptic is the first thing noticed.
                if (outcome === "complete") haptics.success();
                else if (outcome === "partial") haptics.warning();
                else haptics.error();
                // Copy rules: no "check your network", no claim that a link
                // expires. These say what happened and nothing about why, and
                // they name no route — grabbed files land in the main list,
                // and a notification must not name a destination the app
                // cannot reach.
                void notifyTransferComplete(
                  outcome === "complete"
                    ? {
                        title: "Download complete",
                        body: "Your files are saved — they're in your list.",
                      }
                    : outcome === "partial"
                      ? {
                          title: "Some files did not arrive",
                          body: `${kept} of ${kept + failed} saved. Open PearDrop to see what landed.`,
                        }
                      : {
                          title: "Nothing was saved",
                          body: "The share stopped before any files arrived.",
                        }
                );
                upsertTransfer(evt.driveId, (prev) => ({
                  ...prev,
                  percent: outcome === "complete" ? 100 : prev.percent,
                  bytesTransferred:
                    typeof evt.totalBytes === "number"
                      ? evt.totalBytes
                      : prev.bytesTransferred,
                  completed: true,
                  stalled: false,
                  downloadOutcome: { outcome, kept, failed },
                  lastEventAt: Date.now(),
                }));
              }
              return;
            }
            if (evt.type === "drive-created") {
              appendLog(`Drive created: ${evt.shareLink || evt.driveId || ""}`);
              if (evt.driveId) {
                rememberDriveOrigin(hostedIdsRef.current, evt.driveId);
                const driveId = evt.driveId;
                setActiveDriveIds((prev) => {
                  if (prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.add(driveId);
                  return next;
                });
              }
              refreshDrives().catch(() => {});
              return;
            }
            if (evt.type === "drive-hydrated") {
              // Hydration spans both active and inactive drives and either
              // origin; the state field says which set the drive belongs in.
              appendLog(`Drive hydrated: ${evt.shareLink || evt.driveId || ""}`);
              if (evt.driveId) {
                const driveId = evt.driveId;
                const evtState = evt.state ?? "active";
                const evtOrigin = evt.origin ?? "hosted";
                if (evtOrigin === "received") {
                  rememberDriveOrigin(receivedIdsRef.current, driveId);
                } else {
                  rememberDriveOrigin(hostedIdsRef.current, driveId);
                }
                if (evtState === "active") {
                  setActiveDriveIds((prev) => {
                    if (prev.has(driveId)) return prev;
                    const next = new Set(prev);
                    next.add(driveId);
                    return next;
                  });
                  setInactiveDriveIds((prev) => {
                    if (!prev.has(driveId)) return prev;
                    const next = new Set(prev);
                    next.delete(driveId);
                    return next;
                  });
                } else {
                  setInactiveDriveIds((prev) => {
                    if (prev.has(driveId)) return prev;
                    const next = new Set(prev);
                    next.add(driveId);
                    return next;
                  });
                  setActiveDriveIds((prev) => {
                    if (!prev.has(driveId)) return prev;
                    const next = new Set(prev);
                    next.delete(driveId);
                    return next;
                  });
                }
                setFailedHydrationIds((prev) => {
                  if (!prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.delete(driveId);
                  return next;
                });
              }
              refreshDrives().catch(() => {});
              return;
            }
            if (evt.type === "drive-activated") {
              appendLog(`Drive activated: ${evt.driveId ?? ""}`);
              if (evt.driveId) {
                const driveId = evt.driveId;
                setActiveDriveIds((prev) => {
                  if (prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.add(driveId);
                  return next;
                });
                setInactiveDriveIds((prev) => {
                  if (!prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.delete(driveId);
                  return next;
                });
              }
              refreshDrives().catch(() => {});
              return;
            }
            if (evt.type === "drive-deactivated") {
              appendLog(`Drive deactivated: ${evt.driveId ?? ""}`);
              if (evt.driveId) {
                const driveId = evt.driveId;
                setActiveDriveIds((prev) => {
                  if (!prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.delete(driveId);
                  return next;
                });
                setInactiveDriveIds((prev) => {
                  if (prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.add(driveId);
                  return next;
                });
              }
              refreshDrives().catch(() => {});
              return;
            }
            if (evt.type === "drive-hydration-failed") {
              appendLog(
                `Drive hydration failed: ${evt.driveId ?? ""} (${evt.error ?? "unknown"})`
              );
              if (evt.driveId) {
                const driveId = evt.driveId;
                setFailedHydrationIds((prev) => {
                  if (prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.add(driveId);
                  return next;
                });
              }
              return;
            }
            if (evt.type === "transfer-cancelled") {
              // Not routed through the `upload-complete` handler above: that
              // one fires a success haptic and posts a completion
              // notification, which is the wrong thing to tell a user who
              // just stopped the transfer. `keptCount` is the honest value,
              // `null` when the engine sent no count, so the row can tell
              // "nothing saved" apart from "not reported".
              const keptCount =
                typeof evt.filesKept === "number" && Number.isFinite(evt.filesKept)
                  ? evt.filesKept
                  : null;
              const kept = evt.filesKept ?? 0;
              appendLog(
                `Transfer cancelled${evt.driveId ? `: ${evt.driveId}` : ""}` +
                  (kept > 0 ? ` (kept ${kept})` : "")
              );
              debugLog(
                "warn",
                "rn.cancel",
                `transfer-cancelled drive=${evt.driveId ?? "?"} ` +
                  `direction=${evt.direction ?? "?"} filesKept=${kept} ` +
                  `bytes=${evt.totalBytes ?? 0} at=${Date.now()}`
              );
              if (evt.driveId) markCancelled(evt.driveId, keptCount);
              refreshDrives().catch(() => {});
              return;
            }
            if (evt.type === "drive-stopped") {
              appendLog(`Drive stopped: ${evt.driveId ?? ""}`);
              if (evt.driveId) {
                const driveId = evt.driveId;
                upsertTransfer(driveId, (prev) => ({
                  ...prev,
                  completed: true,
                  peersConnected: 0,
                  peerIds: [],
                  lastEventAt: Date.now(),
                }));
                // The drive is gone; drop it from the origin sets so late or
                // stray events on a reused driveId are not misattributed.
                hostedIdsRef.current.delete(driveId);
                receivedIdsRef.current.delete(driveId);
                setActiveDriveIds((prev) => {
                  if (!prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.delete(driveId);
                  return next;
                });
                setInactiveDriveIds((prev) => {
                  if (!prev.has(driveId)) return prev;
                  const next = new Set(prev);
                  next.delete(driveId);
                  return next;
                });
              }
              refreshDrives().catch(() => {});
              refreshStatus().catch(() => {});
              return;
            }
            if (evt.type === "peer-rejected") {
              appendLog(
                `Peer rejected a file (${evt.cause ?? "unknown"})${evt.driveId ? ` on ${evt.driveId}` : ""}`
              );
              debugLog(
                "error",
                "rn.security",
                `peer-rejected drive=${evt.driveId ?? "?"} cause=${evt.cause ?? "?"} key=${JSON.stringify(evt.key ?? "")}`
              );
              return;
            }
            if (evt.type === "peer-connected") {
              appendLog(
                `Peer connected${evt.peerId ? ` (${evt.peerId})` : ""}${evt.driveId ? ` on ${evt.driveId}` : ""}`
              );
              if (evt.driveId) {
                upsertTransfer(evt.driveId, (prev) => {
                  const peerId = String(evt.peerId || "").trim();
                  const peerIds =
                    peerId && !prev.peerIds.includes(peerId)
                      ? [...prev.peerIds, peerId]
                      : prev.peerIds;
                  const at = Date.now();
                  return {
                    ...prev,
                    totalBytes:
                      typeof evt.totalBytes === "number"
                        ? evt.totalBytes
                        : prev.totalBytes,
                    peerIds,
                    peersConnected: peerIds.length,
                    lastEventAt: at,
                    /**
                     * All three peer handlers share `nextLastPeerLeftAt`: one
                     * writer for the one reader. Without a stamp here, a
                     * departure outlives the peer re-attaching and ages
                     * toward the idle-host grace while bytes flow.
                     */
                    lastPeerLeftAt: nextLastPeerLeftAt({
                      prevPeersConnected: prev.peersConnected,
                      prevPeerIdCount: prev.peerIds.length,
                      nextPeersConnected: peerIds.length,
                      prevLastPeerLeftAt: prev.lastPeerLeftAt,
                      at,
                    }),
                  };
                });
              }
              return;
            }
            if (evt.type === "peer-disconnected") {
              appendLog(
                `Peer disconnected${evt.peerId ? ` (${evt.peerId})` : ""}${evt.driveId ? ` on ${evt.driveId}` : ""}`
              );
              if (evt.driveId) {
                upsertTransfer(evt.driveId, (prev) => {
                  const peerId = String(evt.peerId || "").trim();
                  const peerIds = peerId
                    ? prev.peerIds.filter((id) => id !== peerId)
                    : prev.peerIds.slice(
                        0,
                        Math.max(0, prev.peerIds.length - 1)
                      );
                  const nextPeersConnected = peerIds.length;

                  // Stuck-at-0% safety net: the upload tracker can miss
                  // transfers that finish faster than its tick, so a hosted
                  // drive losing its last peer settles rather than sitting at
                  // 0% forever.
                  const isHosted = prev.origin === "hosted";
                  const hadPeer =
                    prev.peersConnected > 0 || prev.peerIds.length > 0;
                  /**
                   * "The last peer left" is not "the share was delivered":
                   * the engine keeps a per-drive record of peers that
                   * finished and ships it on this event. `=== true` and not
                   * a truthiness test, because most producers omit the field
                   * and an absent one must mean no. The `isHosted` guard must
                   * not be relaxed — this event fires on the receive path
                   * too, and every sender drop would finalise a download.
                   */
                  const shouldFinalize =
                    isHosted &&
                    !prev.completed &&
                    hadPeer &&
                    nextPeersConnected === 0 &&
                    evt.delivered === true;

                  if (shouldFinalize) {
                    // This jumps a hosted transfer to 100% on a heuristic, so
                    // it is logged: when it is wrong the user reports "it
                    // said Sent but nothing arrived" and nothing explains it.
                    debugLog(
                      "warn",
                      "rn.watchdog",
                      `peer-disconnect finalize drive=${evt.driveId ?? "?"} — forcing percent=100 ` +
                        `(hosted, had peers, now 0, engine reports delivered=${evt.delivered} ` +
                        `deliveredPeers=${evt.deliveredPeers ?? "?"}). Was percent=${prev.percent} ` +
                        `bytes=${prev.bytesTransferred}/${prev.totalBytes ?? "?"} ` +
                        `progressEverReceived=${prev.progressEverReceived}`
                    );
                  } else if (
                    isHosted &&
                    !prev.completed &&
                    hadPeer &&
                    nextPeersConnected === 0
                  ) {
                    // Logged so the non-finalising case is visible rather
                    // than a silent absence: only "a peer finished" failed.
                    debugLog(
                      "warn",
                      "rn.watchdog",
                      `peer-disconnect NOT finalized drive=${evt.driveId ?? "?"} — last peer left ` +
                        `but the engine reports delivered=${evt.delivered} ` +
                        `deliveredPeers=${evt.deliveredPeers ?? "?"}. The share was not delivered ` +
                        `(D-09). percent stays ${prev.percent}`
                    );
                  }

                  const at = Date.now();
                  return {
                    ...prev,
                    peerIds,
                    peersConnected: nextPeersConnected,
                    percent: shouldFinalize ? 100 : prev.percent,
                    completed: shouldFinalize ? true : prev.completed,
                    lastEventAt: at,
                    // Stamp only on the falling edge to zero: two peers
                    // dropping to one is not the last peer leaving, and
                    // restamping there extends the grace window on churn.
                    // The rule lives in `nextLastPeerLeftAt` so all three
                    // peer handlers share one writer and it is reachable
                    // from jest, which this file is not.
                    lastPeerLeftAt: nextLastPeerLeftAt({
                      prevPeersConnected: prev.peersConnected,
                      prevPeerIdCount: prev.peerIds.length,
                      nextPeersConnected,
                      prevLastPeerLeftAt: prev.lastPeerLeftAt,
                      at,
                    }),
                  };
                });
              }
              return;
            }
            /**
             * The worklet's wake. Only the worklet keeps time while the app
             * is backgrounded, so the idle-host grace is measured on its
             * alive ticker and arrives here as an event. It is a wake, not a
             * verdict: the decision stays with `releaseServiceIfInactive`,
             * which does nothing when there is no service to release, and
             * that is what makes it safe to act on.
             */
            if (evt.type === "host-idle-grace-elapsed") {
              debugLog(
                "warn",
                "rn.fgs",
                `worklet idle-grace wake drive=${evt.driveId ?? "?"} ` +
                  `idleMs=${evt.idleMs ?? "?"} engineAt=${evt.at ?? "?"} ` +
                  `at=${Date.now()}`
              );
              releaseServiceIfInactive("worklet-idle-grace");
              return;
            }
            if (evt.type === "download-peer-disconnected") {
              appendLog("Sender disconnected");
              if (evt.driveId) {
                upsertTransfer(evt.driveId, (prev) => {
                  const at = Date.now();
                  return {
                    ...prev,
                    peerIds: [],
                    peersConnected: 0,
                    lastEventAt: at,
                    // The same falling-edge rule as peer-disconnected, and
                    // the same function. The engine emits this right after a
                    // `peer-disconnected` for the same socket close, so the
                    // window the first event opened must not be restarted.
                    lastPeerLeftAt: nextLastPeerLeftAt({
                      prevPeersConnected: prev.peersConnected,
                      prevPeerIdCount: prev.peerIds.length,
                      nextPeersConnected: 0,
                      prevLastPeerLeftAt: prev.lastPeerLeftAt,
                      at,
                    }),
                  };
                });
              }
              return;
            }
          } catch (err: unknown) {
            appendLog(`Event error: ${String((err as Error)?.message || err)}`);
          }
        });

        workletRef.current = worklet;
        rpcRef.current = rpc;

        if (cancelled) return;
        setReady(true);
        setStatus("ready");
        appendStateLog("Worklet ready; starting LISTEN…");
        // The worklet boots with debug logging off, and the order here is the
        // point: resolve the persisted flag, await the worklet's reply so the
        // flag is set in that realm, and only then send `RPC_LISTEN`. Listen
        // is what starts the engine, and the worklet drops every line until
        // the flag arrives, so its boot prologue would never be written. The
        // flag read is bounded — listening must not be hostage to storage.
        const persistedDebug = await awaitDebugLogging();
        if (cancelled) return;
        debugEnabledRef.current = persistedDebug;
        try {
          await invoke(rpcRef.current, RPC_SET_DEBUG_LOGGING, {
            enabled: persistedDebug,
            // The worklet realm has no build-type constant, so the heartbeat
            // gate is pushed down: ticks need both `enabled` and `heartbeat`.
            heartbeat: IS_DEBUG_BUILD,
          });
        } catch {
          // A failed handshake must not stop the engine from listening — that
          // would trade a missing log line for a dead app.
        }
        if (cancelled) return;
        // The worklet needs the grace duration to expire the idle-host window
        // in its own realm, and this call starts the engine, so it is the one
        // place the number can arrive before any peer can leave. Taken from
        // `transferActivity.ts` and never a literal here: RN is the single
        // producer, so the engine's sweep and RN's predicate cannot disagree
        // about when the window ends.
        sendOneWay(rpcRef.current, RPC_LISTEN, {
          idleHostGraceMs: IDLE_HOST_GRACE_MS + IDLE_HOST_GRACE_WAKE_PAD_MS,
        });
        await refreshStatus();
        await refreshDrives();
        // Runs after refreshDrives so the engine has hydrated its manifest
        // and the drive list reports real local files.
        await reconcileReceived("boot");
      } catch (err: unknown) {
        setStatus("boot error");
        appendErrorLog(
          `BOOT: ${String((err as Error)?.stack || (err as Error)?.message || err)}`,
          err
        );
      }
    })();

    return () => {
      cancelled = true;
      // Best-effort drain before the worklet goes away, so anything
      // buffered from this session survives a teardown.
      void flushDebugLog();
      try {
        workletRef.current?.terminate?.();
      } catch {}
      workletRef.current = null;
      rpcRef.current = null;
    };
    // This dep array is a tripwire: a retrigger tears down and restarts the
    // worklet. Every entry is admissible only because its identity cannot
    // change independently — `reconcileReceived` and `appendStateLog` are
    // `useCallback(…, [])`, `releaseServiceIfInactive` reads only refs and
    // module-level imports, and `markCancelled`'s only dep is
    // `upsertTransfer`, which this array already lists. Anything added needs
    // that argument made explicitly; "probably stable" restarts the worklet
    // mid-transfer.
  }, [
    appendLog,
    appendStateLog,
    appendErrorLog,
    refreshDrives,
    refreshStatus,
    upsertTransfer,
    markCancelled,
    reconcileReceived,
    releaseServiceIfInactive,
  ]);

  /**
   * Own the debug-logging lifecycle from the one provider that spans the
   * whole app. `initDebugLog()` is idempotent and costs one subscription
   * while the flag is off. Every change is mirrored into the worklet so the
   * two realms are never instrumented asymmetrically.
   */
  useEffect(() => {
    initDebugLog();
    // Registered after initDebugLog so the log writer is live when the
    // device-identity line fires. Ungated: an exported log has to say which
    // device produced it.
    initDeviceIdentityLog();
    return subscribeDebugLogging((enabled) => {
      debugEnabledRef.current = enabled;
      if (!rpcRef.current) return;
      void invoke(rpcRef.current, RPC_SET_DEBUG_LOGGING, {
        enabled,
        heartbeat: IS_DEBUG_BUILD,
      }).catch(() => {});
    });
  }, []);

  /**
   * The RN-side control heartbeat. Same cadence as the worklet's, talks to
   * nothing, and that is the point: a worklet-tick gap alone cannot say
   * whether the worklet stopped or the RN thread did, and this interval runs
   * on the same thread and timer machinery as the receive handler. No timer
   * at all while debugging is off, and the build gate sits above the
   * subscribe call so a release build registers no listener whatsoever.
   */
  useEffect(() => {
    if (!IS_DEBUG_BUILD) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let n = 0;

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer) return;
      n = 0;
      timer = setInterval(() => {
        debugLog("info", "rn.heartbeat.control", `rn n=${++n} rn-at=${Date.now()}`);
      }, RN_HEARTBEAT_INTERVAL_MS);
    };

    const unsubscribe = subscribeDebugLogging((enabled) => {
      stop();
      if (enabled) start();
    });

    return () => {
      unsubscribe();
      stop();
    };
  }, []);

  // AppState-driven swarm refresh. On background → active, one immediate
  // refresh so a returning user sees announces propagate. While active, a
  // heartbeat keeps DHT presence fresh at an interval short enough to feel
  // responsive after a Wi-Fi roam and long enough not to provoke aggressive
  // battery-saver throttling. On active → background, clear the interval:
  // the OS may suspend the process anyway, and a resumed app catches up on
  // the next active transition.
  useEffect(() => {
    if (!ready) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        void refreshSwarm();
      }, 90_000);
    };
    const stopInterval = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    // Kick off immediately so a cold-start user has fresh announces by the
    // time their existing bundles finish hydrating.
    void refreshSwarm();
    startInterval();

    const onChange = (next: AppStateStatus) => {
      if (next === "active") {
        // Restart the stall watchdog's clock: its timer was halted for the
        // whole background window, so every `lastEventAt` is stale and the
        // first tick after resume would otherwise rule on all of them.
        foregroundSinceRef.current = Date.now();
        // A stop trigger: the app is visible again, so the service has
        // nothing left to protect. Unconditional, because the OS may have
        // stopped it already and a believed state is not a reason to skip.
        void stopForegroundService("appstate-active");
        // Claim a Cancel tap that could not be delivered live, so a press the
        // user made cannot evaporate. Ordered after the service stop: if the
        // transfers already finished, the active set is empty and nothing is
        // cancelled, which is the correct outcome.
        void drainPendingCancel().then((pending) => {
          if (pending) void cancelAllActiveRef.current("drained-on-resume");
        });
        // The notification goes with the service, so the post history that
        // described it is stale from here on.
        lastNotificationRef.current = null;
        void refreshSwarm();
        // The foreground transition is the moment to recover anything the
        // engine finished while the app was away, including a download whose
        // RN-side write was killed mid-chain.
        void reconcileReceived("foreground");
        void checkForFreeze();
        startInterval();
      } else {
        stopInterval();
        if (next === "background") {
          // The start trigger, synchronous and first: this is the last moment
          // the process is reliably executing, and the predicate is I/O-free
          // so a freeze landing mid-decision cannot defeat it.
          applyServiceForBackground();
          // Snapshot on the way out. Still alive at this point, so the status
          // call succeeds; once frozen there would be nothing to ask.
          void markBackgrounded();
        }
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      stopInterval();
      sub.remove();
    };
  }, [
    ready,
    refreshSwarm,
    reconcileReceived,
    checkForFreeze,
    markBackgrounded,
    applyServiceForBackground,
  ]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      const now = Date.now();
      const foregroundSince = foregroundSinceRef.current;
      // Cheap pre-check: nothing can be ruled on until the app has been
      // foreground long enough, so skip the state update entirely.
      if (now - foregroundSince < DEFAULT_STALL_MS) return;
      // Via commitTransfers: this watchdog flips `completed` and `stalled`,
      // both of which the activity predicate reads, so the ref must move too.
      commitTransfers((prev) => {
        let mutated = false;
        const next = prev.map((t) => {
          // After the threshold with no events, a hosted transfer declares
          // itself complete and a received one flips to stalled, so both are
          // logged. The decision lives in transferStall.ts, which refuses to
          // rule until the app has been foregrounded for the whole
          // threshold: this timer freezes while backgrounded, and without
          // that guard every resume would falsify every in-flight transfer.
          const verdict = evaluateStall({
            now,
            lastEventAt: t.lastEventAt,
            foregroundSince,
            completed: t.completed,
            progressEverReceived: t.progressEverReceived,
            stalled: t.stalled,
            origin: t.origin,
          });
          if (verdict === "none") return t;
          const idleMs = now - t.lastEventAt;
          const shape =
            `(percent=${t.percent} bytes=${t.bytesTransferred}/${t.totalBytes ?? "?"} ` +
            `peers=${t.peersConnected} foreground=${now - foregroundSince}ms)`;
          if (verdict === "hosted-complete") {
            mutated = true;
            debugLog(
              "warn",
              "rn.watchdog",
              `stall watchdog drive=${t.driveId} HOSTED → completed after ${idleMs}ms idle ${shape}`
            );
            return { ...t, completed: true, lastEventAt: now };
          }
          mutated = true;
          debugLog(
            "warn",
            "rn.watchdog",
            `stall watchdog drive=${t.driveId} RECEIVED → stalled after ${idleMs}ms idle ${shape}`
          );
          return { ...t, stalled: true, lastEventAt: now };
        });
        return mutated ? next : prev;
      });
    }, 5_000);
    return () => clearInterval(intervalId);
  }, [commitTransfers]);

  /**
   * The predicate going false while the app is still backgrounded, and the
   * start trigger for a transfer that begins while already backgrounded.
   * Both arrive as a `transfers` change, which this effect depends on, and a
   * transfers change is an engine event — engine-driven code is alive while
   * backgrounded, so neither half needs a timer. The decision is
   * `decideServiceTransition` in `transferActivity.ts`, not an `if` here:
   * start and stop are two halves of one pair, and that is the only form
   * jest can reach.
   */
  useEffect(() => {
    if (AppState.currentState === "active") return;

    if (!serviceStartedForWindowRef.current) {
      if (
        decideServiceTransition({
          appActive: false,
          serviceStartedForWindow: false,
          transfers: transfersRef.current,
          now: Date.now(),
        }) === "start"
      ) {
        applyServiceForBackground("transfer-started-while-backgrounded");
      }
      // Nothing to release and no grace window to wait out: the transfer that
      // just started is the event, and the next one re-runs this effect.
      return;
    }

    // Nothing in RN schedules the idle-host grace window. A timer for it
    // could only ever be armed while backgrounded, which is the one state in
    // which RN timers do not run, so the window would end on resume rather
    // than on time. The worklet times it on its own ticker and emits
    // `host-idle-grace-elapsed`, which the boot effect answers by calling
    // `releaseServiceIfInactive`. This effect keeps the event-driven half.
    releaseServiceIfInactive("transfers-changed");
  }, [transfers, applyServiceForBackground, releaseServiceIfInactive]);

  /**
   * The suspend probe — lifecycle diagnostics only. bare-kit registers its
   * own AppState listener that suspends the worklet on background; this
   * records every AppState transition and every suspend/resume with a
   * sequence number, because React Native does not define listener
   * invocation order. Gated to debug builds, so a release build registers no
   * listener and no subscriptions at all.
   */
  useEffect(() => {
    if (!IS_DEBUG_BUILD) return;
    if (!ready) return;

    let appStateSub: { remove: () => void } | null = null;
    let onWorkletSuspend: (() => void) | null = null;
    let onWorkletResume: (() => void) | null = null;
    let seq = 0;
    let lastState: AppStateStatus = AppState.currentState;

    const stamp = () => `seq=${++seq} at=${Date.now()}`;

    // `suspended` is a real getter on the worklet but isn't in bare-kit's
    // .d.ts, so read it defensively rather than casting the whole object.
    const suspendedFlag = (): string => {
      const v = (workletRef.current as unknown as { suspended?: boolean } | null)
        ?.suspended;
      return typeof v === "boolean" ? String(v) : "?";
    };

    const disarm = () => {
      if (appStateSub) {
        appStateSub.remove();
        appStateSub = null;
      }
      const worklet = workletRef.current;
      if (worklet && onWorkletSuspend) {
        try {
          worklet.off("suspend", onWorkletSuspend);
        } catch {}
      }
      if (worklet && onWorkletResume) {
        try {
          worklet.off("resume", onWorkletResume);
        } catch {}
      }
      onWorkletSuspend = null;
      onWorkletResume = null;
    };

    const arm = () => {
      const worklet = workletRef.current;
      debugLog(
        "warn",
        "rn.probe",
        `probe armed ${stamp()} appstate=${lastState} worklet=${worklet ? "present" : "null"}`,
      );

      onWorkletSuspend = () => {
        debugLog("warn", "rn.probe", `worklet event=suspend ${stamp()}`);
      };
      onWorkletResume = () => {
        debugLog("warn", "rn.probe", `worklet event=resume ${stamp()}`);
      };
      if (worklet) {
        try {
          worklet.on("suspend", onWorkletSuspend);
          worklet.on("resume", onWorkletResume);
        } catch {
          debugLog("error", "rn.probe", `worklet event subscribe failed ${stamp()}`);
        }
      }

      // Observe only: the transition line below is the whole payload.
      const onChange = (next: AppStateStatus) => {
        const prev = lastState;
        lastState = next;
        debugLog(
          "warn",
          "rn.probe",
          `appstate ${prev} -> ${next} ${stamp()} suspended=${suspendedFlag()}`,
        );
      };
      appStateSub = AppState.addEventListener("change", onChange);
    };

    arm();

    return () => {
      disarm();
    };
  }, [ready]);

  const value = useMemo<BackendAPI>(
    () => ({
      ready,
      status,
      logs,
      hyperdriveStatus,
      // Flat as well as nested on `hyperdriveStatus`, so a screen disabling a
      // button need not know the status reply's shape. Derived in exactly one
      // place — do not re-derive it. `=== true` is deliberate: an absent
      // value must read as "not blocked", never as a banner nobody can clear.
      manifestUnavailable: hyperdriveStatus?.manifestUnavailable === true,
      // A module-load constant, so it is deliberately not in this memo's dep
      // array: it cannot change during a session.
      workletBundleId: WORKLET_BUNDLE_ID,
      drives,
      activeDriveIds,
      inactiveDriveIds,
      failedHydrationIds,
      transfers,
      sharePaths,
      openLink,
      startDownload,
      runFakeUploadTest,
      runFakeDownloadTest,
      cancelTransfer,
      cancelInFlight,
      clearTransfer,
      abortOpen,
      activateDrive,
      deactivateDrive,
      refreshStatus,
      refreshDrives,
      refreshSwarm,
    }),
    [
      ready,
      status,
      logs,
      hyperdriveStatus,
      drives,
      activeDriveIds,
      inactiveDriveIds,
      failedHydrationIds,
      transfers,
      sharePaths,
      openLink,
      startDownload,
      runFakeUploadTest,
      runFakeDownloadTest,
      cancelTransfer,
      cancelInFlight,
      clearTransfer,
      abortOpen,
      activateDrive,
      deactivateDrive,
      refreshStatus,
      refreshDrives,
      refreshSwarm,
    ]
  );

  return React.createElement(BackendContext.Provider, { value }, children);
}

export function useBackend(): BackendAPI {
  const context = useContext(BackendContext);
  if (!context) throw new Error("useBackend must be used inside BackendProvider");
  return context;
}
