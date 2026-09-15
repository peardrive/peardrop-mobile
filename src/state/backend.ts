import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

import b4a from "b4a";
import RPC from "bare-rpc";
import { Worklet } from "react-native-bare-kit";
import RNFS from "react-native-fs";

import type {
  BackendEvent,
  BridgeStatus,
  DownloadResult,
  DriveRecord,
  OpenLinkResult,
  SharePathsResult,
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
  RPC_HYPERDRIVE_DOWNLOAD,
  RPC_HYPERDRIVE_STATUS,
  RPC_DRIVES_LIST,
  RPC_DRIVES_PAUSE,
  RPC_DRIVES_RESUME,
  RPC_TEST_FAKE_UPLOAD,
  RPC_REFRESH_SWARM,
  RPC_SET_DEBUG_LOGGING,
} from "../../rpc-commands.mjs";

import { invoke, sendOneWay, type FakeUploadOpts } from "../lib/rpc";
import {
  flush as flushDebugLog,
  initDebugLog,
  logFromBackend,
  logStructuredError,
  log as debugLog,
} from "../lib/debugLog";
import { subscribeDebugLogging } from "./debugLogStorage";
import { initDeviceIdentityLog } from "../lib/deviceIdentity";
import {
  describeActivity,
  isTransferActive,
  msUntilActivityCouldChange,
} from "../lib/transferActivity";
import {
  isForegroundServiceAvailable,
  isScreenOn,
  startForegroundService,
  stopForegroundService,
} from "../lib/foregroundService";
import { IS_DEBUG_BUILD } from "../lib/devGate";
import { parseAliveReading } from "../lib/aliveTicks";
import { evaluateFreeze } from "../lib/freezeDetect";
import { DEFAULT_STALL_MS, evaluateStall } from "../lib/transferStall";
import { recordFreeze, recordServiceWindow } from "./backgroundHealthStorage";
import { SERVICE_FREEZE_THRESHOLD } from "../lib/backgroundHealthModel";
import { gradeWindow, tickRatio } from "../lib/freezeGrade";
import { runReceivedReconcile } from "./reconcileReceivedRunner";
import type { EngineDriveLike } from "../lib/reconcileReceived";
import { addSent } from "./statsStorage";
import { haptics } from "../lib/haptics";
import { notifyTransferComplete } from "../lib/notifications";

import bundle from "../../app/app.bundle.mjs";

export type BackendAPI = {
  ready: boolean;
  status: string;
  logs: string[];
  hyperdriveStatus: BridgeStatus | null;
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
  sharePaths: (paths: string[], relPaths?: string[]) => Promise<SharePathsResult>;
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
  cancelTransfer: (
    driveId: string,
    opts?: { purge?: boolean }
  ) => Promise<{ ok: boolean; error?: string }>;
  clearTransfer: (driveId: string) => void;
  abortOpen: (
    driveId?: string
  ) => Promise<{ ok: boolean; aborted?: number; error?: string }>;
  /** bring an inactive drive back online (joins swarm, announces). */
  activateDrive: (driveId: string) => Promise<{
    ok: boolean;
    error?: string;
    driveId?: string;
    shareLink?: string;
    key?: string;
  }>;
  /** take an active drive offline without destroying its data. */
  deactivateDrive: (driveId: string) => Promise<{ ok: boolean; error?: string }>;
  refreshStatus: () => Promise<void>;
  refreshDrives: () => Promise<void>;
  refreshSwarm: () => Promise<void>;
};

const BackendContext = createContext<BackendAPI | null>(null);

/**
 * Max drive IDs we'll remember in either origin set. Belt-and-braces cap in
 * case a drive-stopped event never arrives (backend crash, RPC stall) — the
 * set would otherwise grow for the life of the app. 64 is comfortably above
 * realistic concurrent-drive counts.
 */
const DRIVE_ORIGIN_SET_MAX = 64;

/**
 * cadence of the RN-side control heartbeat. Deliberately the
 * same 2 s as the worklet's own tick (backend/backend.mjs) so the two
 * streams are read side by side without mental arithmetic.
 */
const RN_HEARTBEAT_INTERVAL_MS = 2000;

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

  // Origin tracking: authoritative way to tell if a drive is ours (hosted)
  // or came from someone else's share link (received). The backend doesn't
  // reliably distinguish these in events, so we record intent at call sites.
  const hostedIdsRef = useRef<Set<string>>(new Set());
  const receivedIdsRef = useRef<Set<string>>(new Set());
  /** Latest debugging-flag value, readable from the boot effect. */
  const debugEnabledRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("booting");
  const [logs, setLogs] = useState<string[]>([]);
  const [hyperdriveStatus, setHyperdriveStatus] = useState<BridgeStatus | null>(
    null
  );
  const [drives, setDrives] = useState<DriveRecord[]>([]);
  const [transfers, setTransfers] = useState<TransferSummary[]>([]);
  /**
   * a synchronously-current mirror of `transfers`, for readers
   * that cannot be React subscribers — specifically the AppState →
   * background handler, whose effect does not list `transfers` in its
   * dependency array and would otherwise close over a stale array.
   * Written ONLY by `commitTransfers` below.
   */
  const transfersRef = useRef<TransferSummary[]>([]);
  /**
   * whether the service was started for the CURRENT background
   * window. Phase 3 reads this to attribute a freeze — a freeze with no
   * service running is not evidence the mechanism failed, it is Android
   * behaving correctly toward an idle app.
   */
  const serviceStartedForWindowRef = useRef<boolean>(false);
  /**
   * completion-path persistence still in flight.
   *
   * Serialized rather than parallel so the stop path has a single thing to
   * await, and so two completions landing together cannot interleave their
   * read-modify-write of the lifetime stats blob.
   */
  const pendingStatsWriteRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * worst observed gap between worklet heartbeats in the current
   * background window.
   *
   * `evaluateFreeze` only sees two tick counts, so it cannot distinguish a
   * window that ticked steadily from one that stalled for two minutes and
   * then caught up — and the 0.5 threshold passed exactly such a run. This
   * is the missing shape of the distribution, reduced to the one number
   * worth carrying.
   *
   * Updated on every tick regardless of build: two number writes, far
   * cheaper than the debugLog call next to it, which IS gated.
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
   * the existing in-memory ring (120 lines, no timestamps, no
   * levels, gone on restart) stays exactly as it was for the dev-facing
   * `logs` array — and now also fans out to the file writer. That single
   * wrap gave all ~25 pre-existing call sites in this file real timestamps
   * and persistence for free.
   */
  const appendLog = useCallback((line: string) => {
    const id = ++logId.current;
    setLogs((p) => [`${id}: ${line}`, ...p].slice(0, 120));
    debugLog("info", "rn.backend", line);
  }, []);

  /** Structured-error variant — keeps category/cause/detail (B4). */
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
   * the ONLY way to write `transfers`.
   *
   * `transfersRef` must never drift from `transfers`. It is read
   * synchronously by the AppState → background handler to decide whether to
   * start the foreground service, and a stale read there produces a wrong
   * service decision that nothing downstream can detect — the service either
   * runs for an idle app or fails to run for a live transfer, and both look
   * like normal operation.
   *
   * So the ref is not synced at each call site, and not synced by an effect
   * (which lags by a commit, and a background transition can land inside that
   * lag). It is written inside the updater itself, which makes it correct the
   * instant the next value is computed — before React even commits — and
   * makes it structurally impossible for a mutation site to update one
   * without the other.
   *
   * `setTransfers` must not be called directly anywhere else. All three
   * historical call sites now route through here.
   */
  const commitTransfers = useCallback(
    (next: (prev: TransferSummary[]) => TransferSummary[]) => {
      setTransfers((prev) => {
        const value = next(prev);
        transfersRef.current = value;
        return value;
      });
    },
    []
  );

  const upsertTransfer = useCallback(
    (driveId: string, update: TransferUpdate) => {
      commitTransfers((prev) =>
        upsertTransferReducer(prev, driveId, update, originFor)
      );
    },
    [commitTransfers, originFor]
  );

  const refreshStatus = useCallback(async () => {
    try {
      const obj = await invoke(rpcRef.current, RPC_HYPERDRIVE_STATUS, {} as Record<string, never>);
      if (obj?.ok && obj.status) setHyperdriveStatus(obj.status);
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

  const sharePaths = useCallback(async (paths: string[], relPaths?: string[]) => {
    const res = await invoke(rpcRef.current, RPC_HYPERDRIVE_SHARE, { paths, relPaths });
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
      // Mark the drive as "received" preemptively. We do this even before
      // startDownload so any early peer events are attributed correctly.
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
   * recover received files the engine wrote to disk but RN never
   * recorded. Fetches the drive list fresh rather than reading the `drives`
   * state, so a resume that races the state update still reconciles against
   * the engine's current truth.
   *
   * Event-driven on purpose. 6H measured RN's `setInterval` frozen for the
   * whole of a backgrounded window, so a polling reconcile would only ever
   * run when the app was already in the foreground — exactly when the
   * foreground transition has already fired.
   */
  /**
   * Background-freeze detection.
   *
   * On the way out, snapshot the wall clock and the engine's liveness
   * counter. On the way back, ask for the counter again: wall-clock time
   * passes whether we ran or were frozen, so the difference between elapsed
   * time and ticks actually taken is the only available evidence.
   *
   * The status call is the same one the swarm refresh already makes, so this
   * adds no message traffic of its own.
   */
  const freezeMarkRef = useRef<{ at: number; ticks: number } | null>(null);

  /**
   * When the app most recently became foreground-active. Read by the stall
   * watchdog, which may not rule until a full uninterrupted foreground
   * window has elapsed — see src/lib/transferStall.ts for why.
   *
   * Seeded at mount: a fresh launch is a foreground start, and the guard
   * correctly suppresses the watchdog for its first 30 s, during which
   * nothing can legitimately have stalled anyway.
   */
  const foregroundSinceRef = useRef<number>(Date.now());

  const readAliveTicks = useCallback(async (): Promise<{
    ticks: number;
    intervalMs: number;
  } | null> => {
    try {
      const obj = await invoke(
        rpcRef.current,
        RPC_HYPERDRIVE_STATUS,
        {} as Record<string, never>
      );
      // Requires `started === true`, not just well-typed counters: a failed
      // engineInit leaves aliveTicks pinned at 0 while status calls keep
      // succeeding, which every long background window would then read as
      // 100% frozen. See src/lib/aliveTicks.ts.
      return parseAliveReading(obj?.status);
    } catch {
      return null;
    }
  }, []);

  /**
   * Every background/resume cycle emits exactly one paired trace: one line
   * here on the way out, one in `checkForFreeze` on the way back.
   *
   * Before this, four of the five outcomes on this path were silent — a
   * failed status RPC, a missing mark, a failed resume read and a clean run
   * all produced nothing at all, so "no freeze" and "never measured" were
   * indistinguishable in the log. Three runs of the 2026-09-06 session came
   * back silent and could not be read either way; they were the Autostart
   * runs, the ones that mattered.
   *
   * Deliberately NOT gated on IS_DEBUG_BUILD. `rn.freeze` already ships
   * ungated and `aliveTicks` ships in release, so the pair must work in any
   * build — especially since the gate has now demonstrably been false on a
   * device without saying so.
   */
  /**
   * the service lifecycle decision for one background window.
   *
   * Called synchronously from the AppState → background handler. Reads
   * `transfersRef` (never `transfers`, which that effect closes over stale)
   * and the one predicate in `transferActivity.ts`.
   *
   * The decision is logged WHATEVER it is. A reader of an exported log must
   * be able to reconstruct why the service did or did not run for a given
   * window without inferring it backwards from the service's own outcome
   * lines — which are absent exactly when the service never started, i.e.
   * the case most in need of explanation.
   */
  const applyServiceForBackground = useCallback(() => {
    const now = Date.now();
    const list = transfersRef.current;
    const active = isTransferActive(list, now);
    debugLog(
      "warn",
      "rn.fgs",
      `background decision ${describeActivity(list, now)} ` +
        `service=${active ? "START" : "skip"} ` +
        `available=${isForegroundServiceAvailable()} at=${now}`
    );
    serviceStartedForWindowRef.current = active;
    if (active) void startForegroundService("appstate-background");
    return active;
  }, []);

  const markBackgrounded = useCallback(async () => {
    // reset the gap window alongside the tick mark, so the worst
    // gap reported at resume describes THIS background window and not a
    // stall from some earlier one.
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

    // attribute the window before ruling on it.
    //
    // Four states, not two. `service` says whether the mechanism was even
    // engaged — a freeze with no service running is Android correctly
    // freezing an idle app, not evidence that anything failed. `screen`
    // separates a locked window from an on-screen one, which are different
    // tests of the same mechanism; every measurement in this project's
    // record that mattered was taken screen-locked.
    const serviceRunning = serviceStartedForWindowRef.current;
    serviceStartedForWindowRef.current = false;
    const screenOn = await isScreenOn();
    const attribution =
      `${serviceRunning ? "service-running" : "no-service"}/` +
      `${screenOn === null ? "screen-unknown" : screenOn ? "screen-on" : "screen-locked"}`;

    // The evidence behind the verdict, logged whether or not it froze. The
    // 0.5 threshold passed a run with a 115 s gap and a completion 49 s
    // late; a boolean alone cannot tell that apart from a clean window, so
    // the ratio and the worst gap go on every line.
    const gaps = heartbeatGapRef.current;
    const largestGapMs = Math.max(
      gaps.maxGapMs,
      gaps.lastAt > 0 ? Date.now() - gaps.lastAt : 0
    );
    const ratio = tickRatio(verdict);
    const grade = gradeWindow(verdict, largestGapMs, reading.intervalMs);
    const evidence =
      `ticks ${verdict.observedTicks}/${verdict.expectedTicks} ` +
      `ratio=${ratio === null ? "n/a" : ratio.toFixed(3)} ` +
      `largest-gap=${largestGapMs}ms`;

    if (!verdict.frozen) {
      // `reason` distinguishes a genuine clean run from a window too short
      // to judge and from an engine restart — all three were previously the
      // same silence.
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
      // streak. `too-short` and `insufficient-signal` grade to null and
      // prove nothing either way, so they must neither add nor clear.
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
        // back-fill propagates through `broadcastChange()` without any
        // extra refresh here.
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

  const activateDrive = useCallback(async (driveId: string) => {
    const id = String(driveId || "").trim();
    if (!id) return { ok: false, error: "driveId is required" };
    const res = await invoke(rpcRef.current, RPC_DRIVES_RESUME, { driveId: id });
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
      // via commitTransfers, so the ref the service decision reads
      // loses the drive at the same instant the state does. A removed
      // transfer can be the last active one, which makes this a stop trigger.
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
        // bare-kit's IPC is duck-compatible with what bare-rpc expects but
        // the two packages don't share a TypeScript interface, so we cast.
        const rpc = new RPC(IPC as unknown as ConstructorParameters<typeof RPC>[0], (req) => {
          try {
            if (req.command !== RPC_EVENT) return;
            if (!req.data) return;
            const evt = JSON.parse(b4a.toString(req.data as unknown as Uint8Array)) as BackendEvent;

            // log lines from the Bare worklet. Handled first —
            // it's the highest-frequency event type once debugging is on,
            // and it must never fall through into the UI state machine.
            if (evt.type === "log") {
              logFromBackend(evt);
              return;
            }
            // worklet liveness heartbeat. Handled next to `log`
            // for the same reason — high frequency while debugging is on,
            // and it must never reach the UI state machine. No state is
            // touched and no render is triggered; the log line IS the
            // product.
            //
            // Two clocks on one line, deliberately. `worklet-at` is the
            // worklet's own stamp at emit; `rn-at` is ours at receive. A
            // gap in `worklet-at` means the engine stopped. Continuous
            // `worklet-at` values arriving with bunched `rn-at` values
            // means the engine kept running and the IPC queued — a
            // different answer, and indistinguishable with one clock.
            //
            // Gated to debug builds. The `return` sits OUTSIDE the
            // gate so a release build still swallows the event rather than
            // letting it fall through the UI state machine — the engine
            // keeps emitting ticks whenever debug logging is on, including
            // in release (see the report's "still shipping" note).
            if (evt.type === "worklet-tick") {
              // track the worst inter-tick gap. Ungated and
              // before the debug branch — the freeze attribution needs this
              // in every build, and it costs two number writes.
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
              // Sprint 6H, found by the 2-min device run: RN's setInterval
              // is driven by the Choreographer, which Android halts while
              // the app is backgrounded — debugLog's own 1 s flush timer
              // included. Entries then sit in memory until foreground, and
              // an OS kill during the background window destroys exactly
              // the evidence this probe exists to collect.
              //
              // A timer cannot fix a frozen-timer problem. This callback is
              // native-driven and demonstrably still runs while
              // backgrounded, so it is the only 2 s clock available — drive
              // the drain from it. Foreground is left alone: the existing
              // flush timer already covers it, and flushing per tick there
              // would be pure churn.
                // this forced a disk write every 2 s while
                // backgrounded. Diagnostic only — it must not reach users,
                // so it lives inside the dev-build gate.
                if (AppState.currentState !== "active") void flushDebugLog();
              }
              return;
            }
            if (evt.type === "listening") {
              setStatus("listening");
              appendLog("Backend listening.");
              return;
            }
            if (evt.type === "error") {
              setStatus("error");
              appendLog(`Error: ${evt.message}`);
              return;
            }
            if (evt.type === "upload-progress") {
              appendLog(`Progress ${evt.percent ?? "?"}%`);
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
                  // Intentionally do NOT mark completed here, even at 100%.
                  // Completion must come from an explicit upload-complete
                  // event so the UI can safely clamp at 99 until then.
                  completed: prev.completed,
                  // flip on first progress event. The UI uses
                  // this to distinguish "connected but no data flowing"
                  // from "data is moving" — the engine's percent itself
                  // is unreliable on hosted transfers because UDX sockets
                  // don't expose `bytesWritten` like Node net.Socket, so
                  // the tracker's bytes-counter often reads 0 forever.
                  progressEverReceived: true,
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
                // Tally lifetime sent bytes only for drives we host. Every
                // upload-complete represents one peer finishing its copy,
                // so each fires once per receiver; summing totalBytes gives
                // a coarse but accurate "data shared" counter. Received
                // drives surface the same event, but we handle those via
                // addReceived at download completion.
                if (hostedIdsRef.current.has(evt.driveId)) {
                  const delta =
                    typeof evt.totalBytes === "number" ? evt.totalBytes : 0;
                  // tracked rather than fired-and-forgotten.
                  // `upload-complete` is the event that flips the activity
                  // predicate false and triggers the service stop, so this
                  // write and the freeze window overlap. The stop path awaits
                  // this chain before releasing the service.
                  if (delta > 0) {
                    pendingStatsWriteRef.current = pendingStatsWriteRef.current
                      .then(() => addSent(delta))
                      .catch(() => {});
                  }
                }
                // Pulse a success haptic at the moment a transfer wraps.
                // This fires for both hosts (a peer finished pulling our
                // drive) and receivers (we finished pulling a drive); both
                // are legit moments for positive feedback.
                haptics.success();
                // When the app is backgrounded, nudge the user with a local
                // notification. notifyTransferComplete() is a no-op when the
                // app is in the foreground or permissions were denied.
                const isHosted = hostedIdsRef.current.has(evt.driveId);
                void notifyTransferComplete({
                  title: isHosted ? "Share delivered" : "Download complete",
                  body: isHosted
                    ? "A peer finished pulling your share."
                    : "Your files are ready in Receive.",
                });
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
              // hydration now spans both active and inactive
              // drives, and either origin. The state field tells us which
              // set the drive belongs in.
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
                // The drive is gone; drop it from the origin sets so we
                // don't misattribute any late/stray events that happen to
                // reuse this driveId in a future session.
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
              // previously emitted by the engine and
              // handled nowhere — a path-traversal rejection vanished.
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
                  return {
                    ...prev,
                    totalBytes:
                      typeof evt.totalBytes === "number"
                        ? evt.totalBytes
                        : prev.totalBytes,
                    peerIds,
                    peersConnected: peerIds.length,
                    lastEventAt: Date.now(),
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

                  // Stuck-at-0% safety net: the backend's 1 Hz upload
                  // tracker can miss transfers that finish faster than its
                  // tick, and never emits upload-complete on real shares.
                  // When the last peer on a hosted drive disconnects and
                  // we had at least one peer connected, treat the transfer
                  // as delivered so the bar doesn't sit at 0% forever.
                  // False positives (peer dropped before any real bytes
                  // flowed) are rare and the user can still dismiss.
                  const isHosted = prev.origin === "hosted";
                  const hadPeer =
                    prev.peersConnected > 0 || prev.peerIds.length > 0;
                  const shouldFinalize =
                    isHosted &&
                    !prev.completed &&
                    hadPeer &&
                    nextPeersConnected === 0;

                  if (shouldFinalize) {
                    // SILENT WATCHDOG #1. This jumps a
                    // hosted transfer straight to 100% on a heuristic —
                    // "last peer left and we'd seen at least one, so it
                    // probably finished". When it's wrong the user reports
                    // "it said Sent but nothing arrived", and there was
                    // previously nothing in any log to explain it.
                    debugLog(
                      "warn",
                      "rn.watchdog",
                      `peer-disconnect finalize drive=${evt.driveId ?? "?"} — forcing percent=100 ` +
                        `(heuristic: hosted, had peers, now 0). Was percent=${prev.percent} ` +
                        `bytes=${prev.bytesTransferred}/${prev.totalBytes ?? "?"} ` +
                        `progressEverReceived=${prev.progressEverReceived}`
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
                    // stamp only on the FALLING edge to zero. Two
                    // peers dropping to one is not the last peer leaving, and
                    // restamping there would extend the grace window every
                    // time a peer churns.
                    lastPeerLeftAt:
                      nextPeersConnected === 0 && prev.peersConnected > 0
                        ? at
                        : prev.lastPeerLeftAt,
                  };
                });
              }
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
                    // same falling-edge rule as peer-disconnected.
                    lastPeerLeftAt:
                      prev.peersConnected > 0 || prev.peerIds.length > 0
                        ? at
                        : prev.lastPeerLeftAt,
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
        appendLog("Worklet ready; starting LISTEN…");
        // the worklet boots with debug logging off. Push the
        // persisted flag down now, and on every later change, so backend
        // instrumentation matches the RN side from the first event.
        void invoke(rpcRef.current, RPC_SET_DEBUG_LOGGING, {
          enabled: debugEnabledRef.current,
          // The worklet realm has no build-type constant, so the heartbeat's dev-only
          // gate is pushed down from here. `enabled` stays user-facing.
          heartbeat: IS_DEBUG_BUILD,
        }).catch(() => {});
        sendOneWay(rpcRef.current, RPC_LISTEN);
        await refreshStatus();
        await refreshDrives();
        // boot-time recovery. Runs after refreshDrives so the
        // engine has hydrated its manifest and DRIVES_LIST reports real
        // localFiles rather than an empty pre-hydration list.
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
    // `reconcileReceived` is stable (its only dep, appendLog, is a
    // `useCallback(…, [])`), so listing it cannot retrigger this effect —
    // which matters here, because a retrigger would tear down and restart
    // the worklet.
  }, [
    appendLog,
    appendErrorLog,
    refreshDrives,
    refreshStatus,
    upsertTransfer,
    reconcileReceived,
  ]);

  /**
   * own the debug-logging lifecycle from the one provider that
   * spans the whole app. `initDebugLog()` is idempotent and, while the
   * flag is off, costs exactly one subscription — no timer, no buffer, no
   * file handle. Every flag change is mirrored into the worklet so the two
   * realms are never instrumented asymmetrically.
   */
  useEffect(() => {
    initDebugLog();
    // the device-identity line, on the rising edge of the same
    // flag. Registered AFTER initDebugLog so `log()` is already live when it
    // fires — subscribers run in registration order, and applyEnabled sets
    // its enabled flag before its first await. Ungated, like the build line:
    // an exported log has to say which device produced it.
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
   * the RN-side CONTROL heartbeat. Same 2 s cadence as the
   * worklet's, talks to nothing, and that is the whole point.
   *
   * Without it a worklet-tick gap is ambiguous: the worklet may have been
   * suspended, or Android may have frozen/throttled the RN JS thread so
   * that nothing on this side ran to receive the ticks. Those look
   * identical from the worklet stream alone. This interval runs on the
   * same JS thread and the same timer machinery as the receive handler, so
   * if it gaps too, the RN side stopped and the worklet stream says
   * nothing about the worklet.
   *
   * Note it also indirectly reports on the log writer: debugLog's flush
   * timer is another setInterval on this thread, so a gap here means the
   * flush timer gapped as well (see the Phase 4 note in the report).
   *
   * Gated on the same flag as Phase 1 — no timer at all while debugging
   * is off. `subscribeDebugLogging` replays the current value on
   * subscribe, so the initial state is handled without a separate read.
   *
   * Additionally gated to debug builds, and the gate sits ABOVE the
   * `subscribeDebugLogging` call deliberately — in a release build this
   * registers no listener at all, not merely a listener that declines to
   * start a timer. "Off means genuinely off", as the debug-logging
   * subsystem already requires of itself.
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

  // / HH.3: stall detector. Hosted transfers can stay in
  // "Sending…" forever because the receiver continues seeding the drive
  // back into the swarm — `socket.on("close")` never fires on the
  // sender's side, so the existing peer-disconnect safety net at line
  // ~435-461 never triggers. Received transfers can stall mid-download
  // if the sender drops without a clean disconnect.
  //
  // Once a transfer has had at least one upload-progress event AND no
  // further events for >30 s, we treat it as done:
  //  - hosted → mark completed=true (the sender did their part; auto-clear
  //    via Phase R kicks in 12 s after that, leaving "Sent" briefly
  //    visible).
  //  - received → keep completed=false but set `stalled=true` so the UI
  //    can surface a "couldn't finish" toast and let the user dismiss.
  //
  // Runs at 5 s cadence — enough granularity for the 30 s threshold
  // without burning CPU. The interval lives independently of the worklet
  // boot effect so it survives across re-renders.
  // AppState-driven swarm refresh.
  //  - On background → active: fire one immediate refresh so a returning user
  //    sees announces propagate quickly.
  //  - While active: a 90 s heartbeat keeps DHT presence fresh without
  //    burning battery in the background. 90 s is a starting point — short
  //    enough to feel responsive after Wi-Fi roams, long enough that it
  //    won't trigger throttling on aggressive battery-saver OSes (HyperOS).
  //    Tunable; revisit if real-world testing shows peers dropping faster.
  //  - On active → background: clear the interval. Background tick adds
  //    nothing because the OS may suspend us anyway, and a freshly-resumed
  //    app will catch up on the next active transition.
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
        // Restart the stall watchdog's clock. The timer that drives it was
        // halted for the whole background window, so every in-flight
        // transfer's `lastEventAt` is stale through no fault of its own;
        // without this the first tick after resume rules on all of them.
        foregroundSinceRef.current = Date.now();
        // stop trigger #1 — the app is visible again, so the
        // service has nothing left to protect. Unconditional: cheap when it
        // was never started, and the OS may have stopped it behind our back
        // (onTimeout does exactly that), so "we think it isn't running" is
        // not a reason to skip the call.
        void stopForegroundService("appstate-active");
        void refreshSwarm();
        // the foreground transition is the moment to recover
        // anything the engine finished while we were away — including a
        // download whose RN-side write never completed because the process
        // was killed mid-chain.
        void reconcileReceived("foreground");
        void checkForFreeze();
        startInterval();
      } else {
        stopInterval();
        if (next === "background") {
          // START TRIGGER. Synchronous and first — this is the
          // last moment the process is reliably executing, and the predicate
          // is deliberately I/O-free so it cannot be defeated by a freeze
          // that lands mid-decision. `markBackgrounded` below awaits an RPC
          // and is allowed to fail; this must not.
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
      // Cheap pre-check: while the app has not been foreground long enough,
      // no transfer can be ruled on, so skip the state update entirely
      // rather than mapping the list to produce no change.
      if (now - foregroundSince < DEFAULT_STALL_MS) return;
      // via commitTransfers. This watchdog flips `completed` and
      // `stalled`, both of which the activity predicate reads, so the ref
      // must move with it.
      commitTransfers((prev) => {
        let mutated = false;
        const next = prev.map((t) => {
          // SILENT WATCHDOG #2. After 30 s of no events a
          // hosted transfer silently declares itself complete and a
          // received one silently flips to "stalled". Both were invisible;
          // both are prime suspects in "said Sent but nothing arrived".
          //
          // The decision itself now lives in src/lib/transferStall.ts,
          // which additionally refuses to rule until the app has been
          // foregrounded for the whole threshold — a backgrounded window
          // freezes this timer, so without that guard every resume
          // falsified every in-flight transfer.
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
   * STOP TRIGGERS #2 and #3 — the predicate going false while the
   * app is still backgrounded.
   *
   * #2 is the last active transfer completing. That arrives as a `transfers`
   * change (upload-complete, the peer-disconnect finalize, the stall
   * watchdog, or a drive being cleared), so this effect's dependency on
   * `transfers` catches it.
   *
   * #3 is the idle-host grace window expiring, which is the one transition
   * that happens on a clock rather than an event. `msUntilActivityCouldChange`
   * says when, and the timeout below re-runs the same evaluation then.
   *
   * Only runs when the service was actually started for this window — an app
   * that never started one has nothing to release, and calling stop on every
   * transfer change in the foreground would be pure noise.
   */
  useEffect(() => {
    if (!serviceStartedForWindowRef.current) return;
    if (AppState.currentState === "active") return;

    const evaluate = () => {
      const now = Date.now();
      const list = transfersRef.current;
      if (isTransferActive(list, now)) return false;
      debugLog(
        "warn",
        "rn.fgs",
        `releasing service — ${describeActivity(list, now)} at=${now}`
      );
      serviceStartedForWindowRef.current = false;
      // let the completion write land before the service goes.
      // The predicate went false BECAUSE a transfer completed, so that
      // event's storage write is in flight right now, and releasing the
      // service is what lets the OS freeze us mid-write.
      void (async () => {
        await pendingStatsWriteRef.current;
        await stopForegroundService("predicate-false");
      })();
      return true;
    };

    if (evaluate()) return;

    const wait = msUntilActivityCouldChange(transfersRef.current, Date.now());
    if (wait === null) return;
    // +250 ms so the timer fires just past the boundary rather than on it,
    // where `now - lastPeerLeftAt < GRACE` would still be true by a
    // millisecond and the service would be held until the next event.
    const timer = setTimeout(evaluate, wait + 250);
    return () => clearTimeout(timer);
  }, [transfers]);

  /**
   * the suspend probe — lifecycle diagnostics only.
   *
   * bare-kit registers a module-scope AppState listener
   * (node_modules/react-native-bare-kit/index.js:332) that calls `suspend()`
   * on background. This records what actually happens: every AppState
   * transition and every worklet suspend/resume event, with timestamps and
   * a sequence number. React Native does not contractually define listener
   * invocation order, so the seq numbers are how the real order is
   * recovered rather than assumed.
   *
   * the counter-`resume()` this used to perform is GONE. Device
   * runs on 2026-08-24 showed it made no difference in either direction —
   * the worklet froze with it on and off under battery restriction, and ran
   * clean with it on and off without. It was fighting SmartPower's process
   * freeze, which `resume()` has no bearing on. Its Settings toggle and
   * storage module went with it.
   *
   * Gated to debug builds instead of a persisted toggle. In a
   * release build the flag is false, so the body below is
   * unreachable and stripped — no AppState listener, no worklet event
   * subscriptions, no storage read.
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

      // Observe only. Sprint 6M removed the counter-`resume()` that used to
      // fire here on `background`; the transition line below is the whole
      // remaining payload.
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
      drives,
      activeDriveIds,
      inactiveDriveIds,
      failedHydrationIds,
      transfers,
      sharePaths,
      openLink,
      startDownload,
      runFakeUploadTest,
      cancelTransfer,
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
      cancelTransfer,
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
