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
import { IS_DEBUG_BUILD } from "../lib/devGate";
import { evaluateFreeze } from "../lib/freezeDetect";
import { recordFreeze } from "./backgroundHealthStorage";
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
  /** Bring an inactive drive back online (joins swarm, announces). */
  activateDrive: (driveId: string) => Promise<{
    ok: boolean;
    error?: string;
    driveId?: string;
    shareLink?: string;
    key?: string;
  }>;
  /** Take an active drive offline without destroying its data. */
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
 * Cadence of the RN-side control heartbeat. Deliberately the
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
  const [activeDriveIds, setActiveDriveIds] = useState<Set<string>>(new Set());
  const [inactiveDriveIds, setInactiveDriveIds] = useState<Set<string>>(new Set());
  const [failedHydrationIds, setFailedHydrationIds] = useState<Set<string>>(new Set());

  const logId = useRef(0);
  /**
   * The in-memory ring (120 lines, no timestamps, no
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

  const upsertTransfer = useCallback(
    (driveId: string, update: TransferUpdate) => {
      setTransfers((prev) =>
        upsertTransferReducer(prev, driveId, update, originFor)
      );
    },
    [originFor]
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
   * Recover received files the engine wrote to disk but RN never
   * recorded. Fetches the drive list fresh rather than reading the `drives`
   * state, so a resume that races the state update still reconciles against
   * the engine's current truth.
   *
   * Event-driven on purpose. RN's `setInterval` was measured frozen for the
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
      const ticks = obj?.status?.aliveTicks;
      const intervalMs = obj?.status?.aliveTickMs;
      if (typeof ticks !== "number" || typeof intervalMs !== "number") return null;
      return { ticks, intervalMs };
    } catch {
      return null;
    }
  }, []);

  const markBackgrounded = useCallback(async () => {
    const reading = await readAliveTicks();
    freezeMarkRef.current = reading
      ? { at: Date.now(), ticks: reading.ticks }
      : null;
  }, [readAliveTicks]);

  const checkForFreeze = useCallback(async () => {
    const mark = freezeMarkRef.current;
    freezeMarkRef.current = null;
    if (!mark) return;
    const reading = await readAliveTicks();
    if (!reading) return;

    const verdict = evaluateFreeze({
      elapsedMs: Date.now() - mark.at,
      ticksAtBackground: mark.ticks,
      ticksNow: reading.ticks,
      tickIntervalMs: reading.intervalMs,
    });

    if (!verdict.frozen) return;
    await recordFreeze(verdict.elapsedMs, verdict.frozenFraction);
    debugLog(
      "warn",
      "rn.freeze",
      `frozen ${(verdict.frozenFraction * 100).toFixed(0)}% of ${verdict.elapsedMs}ms ` +
        `backgrounded (ticks ${verdict.observedTicks}/${verdict.expectedTicks})`
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

  const clearTransfer = useCallback((driveId: string) => {
    const id = String(driveId || "").trim();
    if (!id) return;
    setTransfers((prev) => prev.filter((t) => t.driveId !== id));
    hostedIdsRef.current.delete(id);
    receivedIdsRef.current.delete(id);
  }, []);

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

            // Log lines from the Bare worklet. Handled first —
            // it's the highest-frequency event type once debugging is on,
            // and it must never fall through into the UI state machine.
            if (evt.type === "log") {
              logFromBackend(evt);
              return;
            }
            // Worklet liveness heartbeat. Handled next to `log`
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
              if (IS_DEBUG_BUILD) {
                debugLog(
                  "info",
                  "rn.heartbeat",
                  `worklet n=${evt.n ?? "?"} worklet-at=${evt.at ?? "?"} rn-at=${Date.now()}`
                );
              // Found by a 2-minute device run: RN's setInterval
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
                // This forced a disk write every 2 s while
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
                  // Flip on first progress event. The UI uses
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
                  if (delta > 0) void addSent(delta);
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
              // Hydration spans both active and inactive
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
              // Must stay handled: when it was not, a path-traversal
              // rejection vanished silently.
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

                  return {
                    ...prev,
                    peerIds,
                    peersConnected: nextPeersConnected,
                    percent: shouldFinalize ? 100 : prev.percent,
                    completed: shouldFinalize ? true : prev.completed,
                    lastEventAt: Date.now(),
                  };
                });
              }
              return;
            }
            if (evt.type === "download-peer-disconnected") {
              appendLog("Sender disconnected");
              if (evt.driveId) {
                upsertTransfer(evt.driveId, (prev) => ({
                  ...prev,
                  peerIds: [],
                  peersConnected: 0,
                  lastEventAt: Date.now(),
                }));
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
        // The worklet boots with debug logging off. Push the
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
        // Boot-time recovery. Runs after refreshDrives so the
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
   * Own the debug-logging lifecycle from the one provider that
   * spans the whole app. `initDebugLog()` is idempotent and, while the
   * flag is off, costs exactly one subscription — no timer, no buffer, no
   * file handle. Every flag change is mirrored into the worklet so the two
   * realms are never instrumented asymmetrically.
   */
  useEffect(() => {
    initDebugLog();
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
   * The RN-side CONTROL heartbeat. Same 2 s cadence as the
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

  // Stall detector. Hosted transfers can stay in
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
        void refreshSwarm();
        // The foreground transition is the moment to recover
        // anything the engine finished while we were away — including a
        // download whose RN-side write never completed because the process
        // was killed mid-chain.
        void reconcileReceived("foreground");
        void checkForFreeze();
        startInterval();
      } else {
        stopInterval();
        // Snapshot on the way out. Still alive at this point, so the status
        // call succeeds; once frozen there would be nothing to ask.
        if (next === "background") void markBackgrounded();
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      stopInterval();
      sub.remove();
    };
  }, [ready, refreshSwarm, reconcileReceived, checkForFreeze, markBackgrounded]);

  useEffect(() => {
    const STALL_MS = 30_000;
    const intervalId = setInterval(() => {
      const now = Date.now();
      setTransfers((prev) => {
        let mutated = false;
        const next = prev.map((t) => {
          if (t.completed) return t;
          if (!t.progressEverReceived) return t;
          if (now - t.lastEventAt < STALL_MS) return t;
          // SILENT WATCHDOG #2. After 30 s of no events a
          // hosted transfer silently declares itself complete and a
          // received one silently flips to "stalled". Both were invisible;
          // both are prime suspects in "said Sent but nothing arrived".
          const idleMs = now - t.lastEventAt;
          if (t.origin === "hosted") {
            mutated = true;
            debugLog(
              "warn",
              "rn.watchdog",
              `stall watchdog drive=${t.driveId} HOSTED → completed after ${idleMs}ms idle ` +
                `(percent=${t.percent} bytes=${t.bytesTransferred}/${t.totalBytes ?? "?"} peers=${t.peersConnected})`
            );
            return { ...t, completed: true, lastEventAt: now };
          }
          if (t.origin === "received" && !t.stalled) {
            mutated = true;
            debugLog(
              "warn",
              "rn.watchdog",
              `stall watchdog drive=${t.driveId} RECEIVED → stalled after ${idleMs}ms idle ` +
                `(percent=${t.percent} bytes=${t.bytesTransferred}/${t.totalBytes ?? "?"} peers=${t.peersConnected})`
            );
            return { ...t, stalled: true, lastEventAt: now };
          }
          return t;
        });
        return mutated ? next : prev;
      });
    }, 5_000);
    return () => clearInterval(intervalId);
  }, []);

  /**
   * The suspend probe — lifecycle diagnostics only.
   *
   * bare-kit registers a module-scope AppState listener
   * (node_modules/react-native-bare-kit/index.js:332) that calls `suspend()`
   * on background. This records what actually happens: every AppState
   * transition and every worklet suspend/resume event, with timestamps and
   * a sequence number. React Native does not contractually define listener
   * invocation order, so the seq numbers are how the real order is
   * recovered rather than assumed.
   *
   * There is deliberately no counter-`resume()` here. Device runs showed
   * it made no difference in either direction — the worklet froze with it
   * on and off under battery restriction, and ran clean with it on and off
   * without. It was fighting SmartPower's process freeze, which `resume()`
   * has no bearing on.
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

      // Observe only. No counter-`resume()` fires here on `background`;
      // the transition line below is the whole payload.
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
