import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import {
  NOTIFICATION_ACCENT,
  TRANSFER_CHANNEL_ID,
  ensureNotificationsReady,
  ensurePermission as ensureNotificationPermission,
} from "../lib/notifications";
import { useAppTheme } from "../state/ThemeContext";
import { THEME_ORDER, themes } from "../ui/themes";
import { loadStats, subscribeStats, type Stats } from "../state/statsStorage";
import { formatBytes, formatSimulateDelay } from "../lib/format";
import { useToast } from "../ui/Toast";
import type { AppTheme } from "../ui/themes";
import { useDebugLogging } from "../state/debugLogStorage";
import { useBackend } from "../state/backend";
import {
  SIMULATE_DELAY_OPTIONS,
  useSimulateDelay,
} from "../state/simulateDelayStorage";
import {
  buildExportBundle,
  clearLog,
  getLogSizes,
  shareBundle,
  log as debugLog,
} from "../lib/debugLog";
import {
  APP_VERSION,
  APP_VERSION_CODE,
  BUILD_TYPE,
  DEV_GATE_SOURCE,
  IS_DEBUGGABLE,
  IS_DEBUG_BUILD,
} from "../lib/devGate";
import {
  fallbackBrand,
  openFallbackSettings,
} from "../lib/openBackgroundSettings";
import {
  FALLBACK_ROW_ICON,
  FALLBACK_ROW_LABEL,
  fallbackCopyFor,
} from "../lib/fallbackCopy";
import {
  SERVICE_FREEZE_THRESHOLD,
  hasFallbackTriggered,
} from "../lib/backgroundHealthModel";
import {
  forceFallbackTriggered,
  resetBackgroundHealthForTesting,
  useBackgroundHealth,
} from "../state/backgroundHealthStorage";
import { runExportFlow, runManualReset } from "../lib/debugLogExport";
import { maxOnDiskBytes } from "../lib/debugLogFormat";
import { PROBE_TAG, runProbe } from "../lib/oemProbe";
import {
  isForcedTransferActive,
  setForcedTransferActive,
} from "../lib/transferActivity";
import {
  OEM_PROBE_CANDIDATES,
  shortTarget,
  type ProbeCandidate,
} from "../lib/oemProbeCandidates";
import { deviceIdentityRows } from "../lib/deviceIdentity";
import {
  isBackgroundStartArmed,
  isForegroundServiceAvailable,
  setBackgroundStartArmed,
  startForegroundService,
  stopForegroundService,
  subscribeBackgroundStart,
} from "../lib/foregroundServiceSpike";
import ConfirmModal from "../ui/ConfirmModal";
import NameShareModal from "../ui/NameShareModal";

/**
 * The simulated transfer's nominal length. 4 s is the engine's clamp floor
 * (`Math.max(4000, …)`), so this is the shortest run available.
 */
/**
 * How long a probe verdict stays on screen. Longer than the default because
 * it may be read on the way back from an OEM settings screen.
 */
const PROBE_TOAST_MS = 6_000;

const SIMULATE_DURATION_MS = 4_000;
/** Simulation tick. Completion can only land on a tick boundary. */
const SIMULATE_TICK_MS = 500;
/**
 * How long the simulation actually takes, which is shorter than the nominal
 * duration implies. One peer disconnects at `durationMs * 0.65`, leaving
 * nobody connected, so the next tick completes the run. Matching the offset
 * to that makes completion deterministic.
 */
const SIMULATE_RUN_MS =
  Math.ceil((SIMULATE_DURATION_MS * 0.65) / SIMULATE_TICK_MS) * SIMULATE_TICK_MS;

/**
 * The sustained simulate: a peer that stays connected for the whole run.
 * `earlyCompletePeers: 0` is the load-bearing argument — the engine reads it
 * with `??` and never `||`, so zero genuinely means "no peer disconnects
 * early" and removes the 0.65 disconnect. `startDelayMs: 0` attaches the
 * peer during the RPC. Sized long, since overrunning the window costs
 * nothing and finishing early loses the measurement.
 */
const SUSTAINED_DURATION_MS = 900_000;
/**
 * Coarser than the short simulate's tick. `tickMs` sets event granularity
 * only and total duration is independent of it, so this trades nothing but
 * log volume.
 */
const SUSTAINED_TICK_MS = 5_000;

/**
 * The simulated download's nominal length, matched to the upload so the two
 * rows compare directly in an exported log. The receive simulator advances
 * at a flat rate with no peer-weight divisor, so the label is the duration.
 */
const SUSTAINED_DOWNLOAD_MS = 900_000;
/** Same reasoning as SUSTAINED_TICK_MS: granularity only, 180 events. */
const SUSTAINED_DOWNLOAD_TICK_MS = 5_000;
/** A plausible receive size. Only ever a denominator — no bytes are moved. */
const SUSTAINED_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/**
 * The stall variant's onset. Inside the run window and well past the delay
 * the watchdog needs to flip `stalled`, so a backgrounded run sees both the
 * holding and the released state.
 */
const SIM_DOWNLOAD_STALL_AT_MS = 120_000;

/**
 * The generated build stamp, read from the native constant. `"unknown"`
 * rather than `""` when the constant is absent: an empty row is
 * indistinguishable from a build that has no stamp, and a build that cannot
 * name itself gets its reports attributed to the wrong one.
 */
const BUILD_STAMP: string =
  (NativeModules as { PeardropBuildInfo?: { buildStamp?: string } })
    .PeardropBuildInfo?.buildStamp || "unknown";

/**
 * The worklet bundle id, taken from the backend context and never re-derived
 * here: a second reader of the bundle can be fresh while the running worklet
 * is stale. Read structurally, so the row shows `unknown` rather than
 * breaking when the field is absent.
 */
function readWorkletBundleId(ctx: unknown): string {
  const raw = (ctx as { workletBundleId?: unknown } | null | undefined)
    ?.workletBundleId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "unknown";
}

/**
 * A short prefix of the hash. The full id goes in the export log header,
 * which is machine-read; this is the surface a person reads aloud, and the
 * prefix is enough to tell two packs apart.
 */
function shortBundleId(id: string): string {
  return id === "unknown" ? id : id.slice(0, 12);
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const {
    theme,
    themeId,
    preferredThemeId,
    mode,
    setThemeId,
    setMode,
  } = useAppTheme();
  const { show: showToast } = useToast();
  const backend = useBackend();
  const { runFakeUploadTest, runFakeDownloadTest } = backend;
  const workletBundleId = readWorkletBundleId(backend);
  const { delayMs, setDelayMs } = useSimulateDelay();
  const followSystem = mode === "system";
  const [stats, setStats] = useState<Stats>({
    sentBytes: 0,
    receivedBytes: 0,
    updatedAt: 0,
  });
  const [themeExpanded, setThemeExpanded] = useState(false);

  // ---------------------------------------------------------------
  // debug logging
  // ---------------------------------------------------------------
  const { enabled: debugEnabled, setEnabled: setDebugEnabled } = useDebugLogging();
  const [logBytes, setLogBytes] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);
  const [labelPromptOpen, setLabelPromptOpen] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel: string;
    tone: "destructive" | "primary";
  } | null>(null);
  // Resolver for the currently-open confirm. The export orchestrator wants
  // `confirmClear: () => Promise<boolean>`, and ConfirmModal is callback
  // based, so we bridge the two here.
  const confirmResolver = useRef<((v: boolean) => void) | null>(null);

  const askConfirm = useCallback(
    (spec: {
      title: string;
      body: string;
      confirmLabel: string;
      cancelLabel: string;
      tone: "destructive" | "primary";
    }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        confirmResolver.current = resolve;
        setConfirmSpec(spec);
      }),
    [],
  );

  const settleConfirm = useCallback((value: boolean) => {
    setConfirmSpec(null);
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    resolve?.(value);
  }, []);

  const refreshLogSize = useCallback(async () => {
    try {
      const sizes = await getLogSizes();
      setLogBytes(sizes.total);
    } catch {
      setLogBytes(0);
    }
  }, []);

  useEffect(() => {
    void refreshLogSize();
  }, [refreshLogSize, debugEnabled]);

  /**
   * Export: label prompt, bundle, share sheet, then the shared confirm.
   * The orchestrator owns the ordering guarantee that the log is cleared
   * only on an explicit confirmation; this callback supplies the side
   * effects and reports the outcome.
   */
  const onExportWithLabel = useCallback(
    async (label: string) => {
      setLabelPromptOpen(false);
      setExportBusy(true);
      try {
        const outcome = await runExportFlow(label, {
          buildBundle: buildExportBundle,
          share: shareBundle,
          confirmClear: () =>
            askConfirm({
              title: "Log shared?",
              // Android cannot report whether the share went through, so
              // the user is the source of truth and each button says so.
              body:
                "If the log reached its destination you can clear it to start fresh. " +
                "Not sure? Keep it — nothing is lost either way.",
              confirmLabel: "Clear it",
              cancelLabel: "Keep it",
              tone: "destructive",
            }),
          clearLog,
          log: (level, msg) => debugLog(level, "rn.export", msg),
        });

        if (!outcome.ok) {
          showToast(`Export failed at ${outcome.stage} — ${outcome.error}`, {
            kind: "error",
          });
        } else if (outcome.reason === "empty") {
          showToast("Nothing logged yet.");
        } else if (outcome.cleared) {
          showToast("Log shared and cleared.", { kind: "success" });
        } else {
          showToast("Log shared — kept on device.", { kind: "success" });
        }
      } finally {
        setExportBusy(false);
        void refreshLogSize();
      }
    },
    [askConfirm, showToast, refreshLogSize],
  );

  /** Manual reset — independent of export, destructive-tone confirm. */
  const onManualReset = useCallback(async () => {
    const result = await runManualReset({
      confirmClear: () =>
        askConfirm({
          title: "Clear logs?",
          body:
            "This clears the debug log and starts a fresh one. " +
            "The cleared copy is kept on the device as a backup.",
          confirmLabel: "Clear",
          cancelLabel: "Cancel",
          tone: "destructive",
        }),
      clearLog,
      log: (level, msg) => debugLog(level, "rn.reset", msg),
    });
    if (!result.ok) {
      showToast(`Couldn't clear the log — ${result.error ?? "unknown error"}`, {
        kind: "error",
      });
    } else if (result.cleared) {
      showToast("Log cleared.", { kind: "success" });
    }
    void refreshLogSize();
  }, [askConfirm, showToast, refreshLogSize]);

  useEffect(() => {
    let alive = true;
    void loadStats().then((s) => {
      if (alive) setStats(s);
    });
    const unsub = subscribeStats((s) => {
      if (alive) setStats(s);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  /**
   * Post a notification directly, bypassing the engine and
   * `notifyTransferComplete`, so a failed device test can tell a wrong
   * channel apart from a sleeping worklet. Skipping the guard is the point:
   * this one does show while the app is in the foreground.
   */
  const onTestNotification = useCallback(async () => {
    try {
      await ensureNotificationsReady();
      const granted = await ensureNotificationPermission();
      if (!granted) {
        // Denials are terminal for the session (and after two, for the OS
        // too), so say what happened rather than silently doing nothing.
        showToast("Notifications are off for PearDrop — enable them in system settings.");
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "PearDrop test notification",
          body: "If you can see this, the transfers channel is working.",
          sound: true,
          // The same accent as the real path, so this row isolates the
          // channel rather than also differing in appearance.
          color: NOTIFICATION_ACCENT,
        },
        trigger: { channelId: TRANSFER_CHANNEL_ID },
      });
      debugLog("info", "rn.notify", `test notification posted channel=${TRANSFER_CHANNEL_ID}`);
      showToast("Test notification sent.", { kind: "success" });
    } catch (err) {
      debugLog(
        "error",
        "rn.notify",
        `test notification failed — ${String((err as Error)?.message || err)}`,
      );
      showToast("Couldn't post the test notification.", { kind: "error" });
    }
  }, [showToast]);

  /**
   * Fire a real `upload-complete` from the engine after a delay, so the app
   * can be backgrounded and the notification observed. Not a shortcut to
   * `notifyTransferComplete`: it runs the whole chain, including the same
   * AppState guard and wording a real transfer uses. A failure here and not
   * in the direct test localises the fault.
   */
  const onSimulateComplete = useCallback(async () => {
    try {
      await ensureNotificationsReady();
      const granted = await ensureNotificationPermission();
      if (!granted) {
        showToast("Notifications are off for PearDrop — enable them in system settings.");
        return;
      }
      const res = await runFakeUploadTest({
        // Subtract the simulation's real run time so the total lands on the
        // delay the label promises.
        startDelayMs: Math.max(0, delayMs - SIMULATE_RUN_MS),
        durationMs: SIMULATE_DURATION_MS,
        tickMs: SIMULATE_TICK_MS,
        peers: 1,
        forceSelfPeer: true,
        // Engine floor, kept minimal because a hosted completion tallies
        // into the lifetime "sent" stats.
        totalBytes: 1024 * 1024,
      });
      if (!res?.ok) {
        showToast("Couldn't start the simulation — is the backend running?", { kind: "error" });
        return;
      }
      debugLog(
        "info",
        "rn.notify",
        `simulate-complete scheduled drive=${res.driveId ?? "?"} ` +
          `fires in ${delayMs}ms (startDelay=${Math.max(0, delayMs - SIMULATE_RUN_MS)}ms + sim=${SIMULATE_RUN_MS}ms)`,
      );
      showToast(
        `Completion in ${formatSimulateDelay(delayMs)} — background the app now.`,
        { kind: "success" },
      );
    } catch (err) {
      debugLog(
        "error",
        "rn.notify",
        `simulate-complete failed — ${String((err as Error)?.message || err)}`,
      );
      showToast("Couldn't start the simulation.", { kind: "error" });
    }
  }, [delayMs, runFakeUploadTest, showToast]);

  /**
   * Fire one OEM candidate and report the outcome three ways, not two.
   * `not-found` cannot distinguish an absent activity from one hidden by
   * package visibility, and `error` carries its exception class, because a
   * security failure on a component that exists is a different finding.
   * The toast is for whoever holds the phone; the log line is the record.
   */
  const onProbe = useCallback(
    (candidate: ProbeCandidate) => async () => {
      const result = await runProbe(candidate);
      const where = `${candidate.label} · ${shortTarget(candidate)}`;
      if (result.outcome === "launched") {
        showToast(where, {
          kind: "success",
          title: "launched",
          durationMs: PROBE_TOAST_MS,
        });
      } else if (result.outcome === "not-found") {
        showToast(`${where} — ActivityNotFoundException`, {
          kind: "warning",
          title: "not-found",
          durationMs: PROBE_TOAST_MS,
        });
      } else {
        showToast(`${where} — ${result.exceptionClass}`, {
          kind: "error",
          title: "error",
          durationMs: PROBE_TOAST_MS,
        });
      }
    },
    [showToast],
  );

  // The foreground service, as three harness rows: the foreground start,
  // the background start and the stop are three different questions.
  const [bgStartArmed, setBgStartArmed] = useState(isBackgroundStartArmed);
  useEffect(() => subscribeBackgroundStart(setBgStartArmed), []);

  /**
   * Whether the per-OEM fallback row has been earned. Subscribed rather than
   * read once, so the row appears the moment it is, with the user possibly
   * looking at this screen.
   */
  const backgroundHealth = useBackgroundHealth();
  const fallbackReady = backgroundHealth
    ? hasFallbackTriggered(backgroundHealth)
    : false;
  const fallbackCopy = useMemo(() => fallbackCopyFor(fallbackBrand()), []);

  /**
   * Shared reporting for the service rows. `unavailable` is a real answer, not
   * a bug: the bridge module is registered only in the instrumented build, so
   * a debug build says so plainly instead of failing against a service its
   * manifest never declared.
   */
  const reportService = useCallback(
    (label: string, result: string) => {
      if (result === "unavailable" || result === "dev-only") {
        showToast(`${label} — needs the instrumented release build`, {
          kind: "warning",
          title: "unavailable",
          durationMs: PROBE_TOAST_MS,
        });
      } else if (result.startsWith("error:") || result.startsWith("threw:")) {
        showToast(`${label} — ${result}`, {
          kind: "error",
          title: "error",
          durationMs: PROBE_TOAST_MS,
        });
      } else {
        showToast(`${label} — ${result}. Check the notification shade.`, {
          kind: "success",
          title: result,
          durationMs: PROBE_TOAST_MS,
        });
      }
    },
    [showToast],
  );

  const onStartService = useCallback(async () => {
    reportService("Start foreground service", await startForegroundService("row-foreground"));
  }, [reportService]);

  const onStopService = useCallback(async () => {
    reportService("Stop foreground service", await stopForegroundService("row-stop"));
  }, [reportService]);

  /**
   * Arms or disarms the AppState handler; it starts nothing now. The start
   * happens on the next transition to background, which is the path modern
   * Android restricts, and the native side resolves the restriction as a
   * value rather than throwing.
   */
  const onArmBackgroundStart = useCallback(() => {
    if (!isForegroundServiceAvailable()) {
      showToast("Start from background — needs the instrumented release build", {
        kind: "warning",
        title: "unavailable",
        durationMs: PROBE_TOAST_MS,
      });
      return;
    }
    const next = !isBackgroundStartArmed();
    setBackgroundStartArmed(next);
    showToast(
      next
        ? "Armed. Leave Settings and background the app now — the start fires on the next transition."
        : "Disarmed.",
      { kind: next ? "success" : "info", title: next ? "armed" : "disarmed", durationMs: PROBE_TOAST_MS },
    );
  }, [showToast]);

  /**
   * A simulate whose peer stays connected, so the predicate returns `upload`
   * for the whole run rather than falling through to the idle-host grace.
   */
  const onSustainedSimulate = useCallback(async () => {
    try {
      const res = await runFakeUploadTest({
        startDelayMs: 0,
        durationMs: SUSTAINED_DURATION_MS,
        tickMs: SUSTAINED_TICK_MS,
        peers: 1,
        forceSelfPeer: true,
        // The whole point: no early disconnect, so the peer stays attached.
        earlyCompletePeers: 0,
        // Engine floor, kept minimal — a hosted completion tallies into the
        // lifetime "sent" stats.
        totalBytes: 1024 * 1024,
      });
      if (!res?.ok) {
        showToast("Couldn't start the sustained simulation.", { kind: "error" });
        return;
      }
      debugLog(
        "info",
        "rn.probe.oem",
        `sustained simulate started drive=${res.driveId ?? "?"} ` +
          `durationMs=${SUSTAINED_DURATION_MS} tickMs=${SUSTAINED_TICK_MS} earlyCompletePeers=0`
      );
      showToast("Peer connected. Background the app now, then lock.", {
        kind: "success",
        title: "sustained upload running",
        durationMs: PROBE_TOAST_MS,
      });
    } catch (err: unknown) {
      showToast(`Sustained simulate failed — ${String((err as Error)?.message || err)}`, {
        kind: "error",
        durationMs: PROBE_TOAST_MS,
      });
    }
  }, [runFakeUploadTest, showToast]);

  /**
   * A sustained simulated download, the only instrument that makes
   * `classifyTransfer` return `download` on hardware. "run" completes
   * normally; "hold" pins at 100% forever, proving a stuck download looks
   * different from a finished one; "stall" goes silent so the watchdog flips
   * `stalled` and the service must release rather than hold a dead transfer.
   */
  const onSimulateDownload = useCallback(
    async (variant: "run" | "hold" | "stall") => {
      try {
        const res = await runFakeDownloadTest({
          durationMs: SUSTAINED_DOWNLOAD_MS,
          tickMs: SUSTAINED_DOWNLOAD_TICK_MS,
          totalBytes: SUSTAINED_DOWNLOAD_BYTES,
          startDelayMs: 0,
          shareName: `Simulated receive (${variant})`,
          ...(variant === "hold" ? { holdAtPercent: 100 } : {}),
          ...(variant === "stall"
            ? { stallAtMs: SIM_DOWNLOAD_STALL_AT_MS, stallDurationMs: 0 }
            : {}),
        });
        if (!res?.ok) {
          showToast("Couldn't start the simulated download.", { kind: "error" });
          return;
        }
        debugLog(
          "warn",
          "rn.probe.oem",
          `simulated download started variant=${variant} drive=${res.driveId ?? "?"} ` +
            `shareKey=${(res.shareKey ?? "").slice(0, 12)}… bytes=${res.totalBytes ?? "?"} ` +
            `holdAtPercent=${res.holdAtPercent ?? 0} durationMs=${SUSTAINED_DOWNLOAD_MS}`
        );
        showToast(
          variant === "hold"
            ? "Pins at 100% and never completes — the row must say Finishing…, not Saved."
            : variant === "stall"
              ? "Goes silent after 2 min. Background now; the service must release."
              : "Receiving. Background the app now, then lock.",
          {
            kind: "success",
            title: `simulated download (${variant})`,
            durationMs: PROBE_TOAST_MS,
          }
        );
      } catch (err: unknown) {
        showToast(
          `Simulated download failed — ${String((err as Error)?.message || err)}`,
          { kind: "error", durationMs: PROBE_TOAST_MS }
        );
      }
    },
    [runFakeDownloadTest, showToast]
  );

  /**
   * The forced override, a fallback rather than the primary instrument: it
   * bypasses `classifyTransfer`, so it proves the service starts and stops,
   * not that a real transfer satisfies the predicate.
   */
  const [forcedActive, setForcedActiveState] = useState(isForcedTransferActive);
  const onToggleForcedActive = useCallback(() => {
    const next = !isForcedTransferActive();
    setForcedTransferActive(next, IS_DEBUG_BUILD);
    const applied = isForcedTransferActive();
    setForcedActiveState(applied);
    showToast(
      applied
        ? "Predicate forced true. Every decision log line will read forced=true."
        : "Override cleared.",
      {
        kind: applied ? "warning" : "info",
        title: applied ? "forced active" : "released",
        durationMs: PROBE_TOAST_MS,
      }
    );
  }, [showToast]);

  /**
   * Put the record into the state repeated service-attributed freezes would
   * have produced, so the prompt and the row can be seen without waiting for
   * a device to actually defeat the service.
   */
  const onForceFallback = useCallback(async () => {
    const next = await forceFallbackTriggered();
    showToast(
      `Streak ${next.serviceFreezeStreak}/${SERVICE_FREEZE_THRESHOLD}. The prompt should appear now.`,
      { kind: "warning", title: "fallback forced", durationMs: PROBE_TOAST_MS }
    );
  }, [showToast]);

  /**
   * Clear the streak, the sticky stamp and the prompt version so the prompt
   * can be seen again. Freeze history is preserved.
   */
  const onResetBackgroundHealth = useCallback(async () => {
    const next = await resetBackgroundHealthForTesting();
    showToast(
      `Streak, fallback flag and prompt version cleared. freezeCount kept at ${next.freezeCount}.`,
      { kind: "info", title: "background health reset", durationMs: PROBE_TOAST_MS }
    );
  }, [showToast]);

  const onBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  const notYet = useCallback(
    (label: string) => () => showToast(`${label} isn't available yet.`),
    [showToast],
  );

  const styles = useMemo(() => createStyles(theme), [theme]);
  const activeThemeLabel = themes[themeId].label;

  /**
   * Which Support row renders first, so it can suppress its top hairline
   * against the card's rounded corner. The leading row is build-gated, so
   * this cannot be a static prop, and the order here must match render
   * order. `"none"` is correct when no row leads the card at all.
   */
  const firstSupportRow: "test" | "battery" | "none" = IS_DEBUG_BUILD
    ? "test"
    : fallbackReady
      ? "battery"
      : "none";

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top + theme.pad }]}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 96 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.titleRow}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      {/* Appearance section */}
      <SectionLabel theme={theme}>Appearance</SectionLabel>
      <View style={styles.sectionCard}>
        <SettingsRow
          theme={theme}
          icon="language-outline"
          label="Language"
          value="English"
          onPress={notYet("Language")}
          first
        />
        <SettingsRow
          theme={theme}
          icon="color-palette-outline"
          label="Theme"
          value={followSystem ? `System · ${activeThemeLabel}` : activeThemeLabel}
          onPress={() => setThemeExpanded((v) => !v)}
          trailing={themeExpanded ? "chevron-up" : "chevron-down"}
        />
        {themeExpanded ? (
          <View style={styles.themePanel}>
            <View style={styles.followRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.followLabel}>Follow system</Text>
                <Text style={styles.followHint}>
                  Match your device&apos;s light or dark mode automatically.
                </Text>
              </View>
              <Switch
                value={followSystem}
                onValueChange={(v) => setMode(v ? "system" : "manual")}
                accessibilityLabel="Follow system theme"
              />
            </View>
            <View
              style={[
                styles.themeList,
                followSystem && styles.themeListDisabled,
              ]}
            >
              {THEME_ORDER.map((id) => {
                const candidate = themes[id];
                const active = followSystem
                  ? id === preferredThemeId
                  : id === themeId;
                return (
                  <Pressable
                    key={id}
                    onPress={() => setThemeId(id)}
                    style={[
                      styles.themeRow,
                      active && styles.themeRowActive,
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${candidate.label} theme`}
                  >
                    <View style={styles.swatchRow}>
                      <View
                        style={[
                          styles.swatch,
                          { backgroundColor: candidate.primary },
                        ]}
                      />
                      <View
                        style={[
                          styles.swatch,
                          { backgroundColor: candidate.secondary },
                        ]}
                      />
                      <View
                        style={[
                          styles.swatch,
                          { backgroundColor: candidate.cardStrong },
                        ]}
                      />
                    </View>
                    <Text style={styles.themeLabel}>{candidate.label}</Text>
                    {active ? (
                      <Ionicons
                        name="checkmark-circle"
                        size={18}
                        color={theme.primary}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>

      {/* Support section */}
      <SectionLabel theme={theme}>Support</SectionLabel>
      <View style={styles.sectionCard}>
        {/* Posts straight to the transfers channel, with no engine and no
            AppState guard, to confirm notifications work at all before
            blaming a transfer. Dev-gated: a release build should not offer
            a diagnostic only its developers can read. */}
        {IS_DEBUG_BUILD ? (
          <SettingsRow
            theme={theme}
            icon="notifications-outline"
            label="Send a test notification"
            onPress={() => void onTestNotification()}
            trailing="chevron-forward"
            first={firstSupportRow === "test"}
          />
        ) : null}
        {/* The fallback row appears only once the foreground service has
            demonstrably failed on this device, and then stays: the user has
            been told their phone stops PearDrop, and withdrawing the fix
            after one good window would be worse than leaving it. Label and
            subtitle come from the same module the prompt reads, so the
            setting named here is the one on the screen that opens, and both
            destinations are global lists rather than PearDrop's own page. */}
        {fallbackReady ? (
          <SettingsRow
            theme={theme}
            icon={FALLBACK_ROW_ICON}
            label={FALLBACK_ROW_LABEL}
            subtitle={fallbackCopy.rowSubtitle}
            onPress={() => void openFallbackSettings()}
            trailing="chevron-forward"
            first={firstSupportRow === "battery"}
          />
        ) : null}

        {/* The other half of the pair above. That row proves the channel
            works; this one drives a real engine `upload-complete` through
            the full notification path including the AppState guard, so it
            shows nothing unless the app is backgrounded. Dev-only, on the
            same flag as the row above, so the pair appears together. */}
        {IS_DEBUG_BUILD ? (
        <View style={styles.debugRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.followLabel}>
              Simulate transfer complete ({formatSimulateDelay(delayMs)})
            </Text>
            <Text style={styles.followHint}>
              Fires a real completion after the selected delay. Tap, then
              background the app straight away — nothing shows while PearDrop
              is on screen. Pick a delay longer than a minute to test what
              happens once the system freezes the app.
            </Text>
            {/* Same pressable-radio idiom as the theme list above, laid out
                in a row because three short values do not need full rows. */}
            <View style={styles.delayPicker}>
              {SIMULATE_DELAY_OPTIONS.map((ms) => {
                const active = ms === delayMs;
                return (
                  <Pressable
                    key={ms}
                    onPress={() => setDelayMs(ms)}
                    style={[styles.delayChip, active && styles.delayChipActive]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Delay ${formatSimulateDelay(ms)}`}
                  >
                    <Text
                      style={[
                        styles.delayChipText,
                        active && styles.delayChipTextActive,
                      ]}
                    >
                      {formatSimulateDelay(ms)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Simulate transfer complete"
            onPress={() => void onSimulateComplete()}
            hitSlop={8}
          >
            <Ionicons name="play-circle-outline" size={26} color={theme.primary} />
          </Pressable>
        </View>
        ) : null}

        {/* The debugging toggle is not dev-gated: the log export hanging off
            it is the only way to get diagnostics off a user's device. Only
            the instrumentation built on top of it is gated. */}
        <View style={styles.debugRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.followLabel}>Debugging</Text>
            <Text style={styles.followHint}>
              Record a detailed log so a bug can be traced. Leave this off
              unless you&apos;re chasing a problem.
            </Text>
          </View>
          <Switch
            value={debugEnabled}
            onValueChange={setDebugEnabled}
            accessibilityLabel="Debug logging"
          />
        </View>

        {debugEnabled ? (
          <View style={styles.debugPanel}>
            <Text style={styles.debugMeta}>
              {logBytes > 0
                ? `Log size ${formatBytes(logBytes)} · caps at ${formatBytes(
                    maxOnDiskBytes(),
                  )}`
                : "Nothing logged yet."}
            </Text>
            <Text style={styles.debugWarn}>
              Exported logs are raw — they can include file names, folder
              paths and share keys.
            </Text>
            <View style={styles.debugActions}>
              <Pressable
                onPress={() => setLabelPromptOpen(true)}
                disabled={exportBusy}
                style={[styles.debugBtn, exportBusy && styles.debugBtnDisabled]}
                accessibilityRole="button"
                accessibilityLabel="Export log"
              >
                <Ionicons
                  name="share-outline"
                  size={16}
                  color={theme.onPrimary}
                />
                <Text style={styles.debugBtnText}>
                  {exportBusy ? "Exporting…" : "Export log"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void onManualReset()}
                style={styles.debugBtnGhost}
                accessibilityRole="button"
                accessibilityLabel="Reset log"
              >
                <Ionicons name="trash-outline" size={16} color={theme.danger} />
                <Text style={styles.debugBtnGhostText}>Reset</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* The version row is ungated, because "read me the version" has to
            be answerable on the build someone actually runs. Three
            identifiers, because one is not enough: version and code name the
            drop, the build stamp distinguishes two builds of the same drop,
            and the worklet id names the packed backend inside it. The
            worklet is stamped separately on purpose — a fresh RN bundle over
            a stale worklet is the most common phantom bug here, and a
            combined stamp would move on the RN rebuild and hide it. The
            gate-state diagnostics below stay gated; a version does not. */}
        <View style={styles.debugRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.followLabel}>Version</Text>
            <Text style={styles.debugMeta} selectable>
              {`${APP_VERSION} (${
                APP_VERSION_CODE === null ? "?" : APP_VERSION_CODE
              }) · ${BUILD_TYPE}`}
            </Text>
            <Text style={styles.debugMeta} selectable>
              {`build ${BUILD_STAMP}`}
            </Text>
            <Text style={styles.debugMeta} selectable>
              {`worklet ${shortBundleId(workletBundleId)}`}
            </Text>
          </View>
        </View>

        {/* Read-only instrumentation identity, checked before starting a
            long background run rather than discovering afterwards that the
            log was empty. `selectable` so the gate source can be pasted into
            a report. The wording is unconditional because the gate and the
            text read the same constant, so a not-armed branch here could
            never render; that state shows as the row's absence, and in the
            export header's ungated instrument line. */}
        {IS_DEBUG_BUILD ? (
        <View style={styles.debugRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.followLabel}>Build</Text>
            <Text style={styles.followHint}>
              Instrumentation ARMED — heartbeats and probe will be recorded.
            </Text>
            <Text style={styles.debugMeta} selectable>
              {`debuggable ${
                IS_DEBUGGABLE === null ? "unknown" : IS_DEBUGGABLE ? "yes" : "no"
              }`}
            </Text>
            <Text style={styles.debugMeta} selectable>
              {DEV_GATE_SOURCE}
            </Text>
          </View>
        </View>
        ) : null}

      </View>

      {/* The OEM background-settings test harness: an instrument, not a
          feature, unreachable from a release build and not wired into the
          shipping ladder. Every row shows on every device on purpose — a
          component that resolves on the wrong manufacturer is a finding, and
          gating by manufacturer would hide it. Package visibility makes
          pre-tap resolution unknowable, so the outcome is reported after the
          attempt. One row, one intent, no fall-through: a ladder would hide
          which rung worked. */}
      {IS_DEBUG_BUILD ? (
        <>
          <SectionLabel theme={theme}>
            Test harness · OEM background settings
          </SectionLabel>
          <View style={styles.sectionCard}>
            <View style={styles.harnessNote}>
              <Text style={styles.debugWarn}>
                Debug builds only. These rows are not a feature — each one
                fires a single OEM intent and reports whether it launched.
                Most are expected to fail on any given phone.
              </Text>
              <Text style={styles.debugMeta}>
                launched · not-found (ActivityNotFoundException — could not
                launch; ambiguous under package visibility) · error (any other
                throw, named). Every tap is logged under {PROBE_TAG}.
              </Text>
            </View>
            {/* No `first` on any row: the note above leads the card, so
                every row wants its top hairline. */}
            {OEM_PROBE_CANDIDATES.map((candidate) => (
              <SettingsRow
                key={candidate.key}
                theme={theme}
                icon="flask-outline"
                label={candidate.label}
                subtitle={candidate.subtitle}
                onPress={() => void onProbe(candidate)()}
                trailing="chevron-forward"
              />
            ))}

            {/* The foreground service shares this card because it answers
                the same question a different way. It is declared only in the
                instrumented release build, and the bridge module is
                registered on the same flag, so any other build reports
                "unavailable" and says why.

                Two instruments in priority order: the first exercises the
                real upload branch of the predicate, the second bypasses the
                predicate and is the fallback. The decision log distinguishes
                them, so one run is never mistaken for the other. */}
            <SettingsRow
              theme={theme}
              icon="cloud-done-outline"
              label="Simulate sustained upload (15 min)"
              subtitle="Peer stays connected — exercises the real upload branch"
              onPress={() => void onSustainedSimulate()}
              trailing="chevron-forward"
            />
            {/* The receive-side counterparts: the only instruments that make
                the predicate return `download` on hardware. The decision
                line prints `simulated=N` alongside `download=N`, so a
                synthetic run is never mistaken for a real receive. */}
            <SettingsRow
              theme={theme}
              icon="cloud-download-outline"
              label="Simulate sustained download (15 min)"
              subtitle="Real received row — exercises the download branch"
              onPress={() => void onSimulateDownload("run")}
              trailing="chevron-forward"
            />
            <SettingsRow
              theme={theme}
              icon="pause-circle-outline"
              label="Simulate download stuck at 100%"
              subtitle="Must read Finishing…, never Saved"
              onPress={() => void onSimulateDownload("hold")}
              trailing="chevron-forward"
            />
            <SettingsRow
              theme={theme}
              icon="alert-circle-outline"
              label="Simulate download that stalls"
              subtitle="Goes silent after 2 min — the service must release"
              onPress={() => void onSimulateDownload("stall")}
              trailing="chevron-forward"
            />
            <SettingsRow
              theme={theme}
              icon="flash-outline"
              label="Force active transfer state"
              subtitle="Fallback — bypasses the predicate, logs forced=true"
              value={forcedActive ? "on" : undefined}
              onPress={onToggleForcedActive}
              trailing="chevron-forward"
            />

            {/* The fallback instruments write persisted state, unlike the
                session-only forced-active flag above: the fallback is
                sticky once earned, and a session-only version could not
                test stickiness. The reset row undoes them. Both log that
                the state was written rather than measured, so an exported
                log never shows a fallback that was really a test. */}
            <SettingsRow
              theme={theme}
              icon="warning-outline"
              label="Force fallback triggered"
              subtitle="Writes the 3/3 streak — prompt fires, row appears"
              value={fallbackReady ? "on" : undefined}
              onPress={() => void onForceFallback()}
              trailing="chevron-forward"
            />
            <SettingsRow
              theme={theme}
              icon="refresh-outline"
              label="Reset background health"
              subtitle="Clears streak, fallback flag and prompt version — keeps freeze history"
              onPress={() => void onResetBackgroundHealth()}
              trailing="chevron-forward"
            />

            <SettingsRow
              theme={theme}
              icon="play-circle-outline"
              label="Start foreground service"
              subtitle="All brands — standard Android mechanism"
              onPress={() => void onStartService()}
              trailing="chevron-forward"
            />
            <SettingsRow
              theme={theme}
              icon="cloud-upload-outline"
              label="Start service from background"
              subtitle="All brands — standard Android mechanism"
              value={bgStartArmed ? "armed" : undefined}
              onPress={onArmBackgroundStart}
              trailing="chevron-forward"
            />
            <SettingsRow
              theme={theme}
              icon="stop-circle-outline"
              label="Stop foreground service"
              subtitle="All brands — standard Android mechanism"
              onPress={() => void onStopService()}
              trailing="chevron-forward"
            />

            {/* Who this device says it is, read before any row is tapped: a
                result is only interpretable next to the device that produced
                it, and the block is `selectable` so it can be copied rather
                than transcribed. MANUFACTURER and BRAND are separate fields
                because the predicate and the intent ladder key off different
                ones, and where they disagree that is the finding. The last
                line is the live predicate result, never a re-derivation, so
                the readout cannot drift from what it measures. */}
            <View style={styles.identityPanel}>
              <Text style={styles.followLabel}>Device identity</Text>
              <Text style={styles.followHint}>
                Record this before tapping anything. isXiaomiDevice() matches
                MANUFACTURER; AutoStarter dispatches on BRAND — where they
                disagree, that disagreement is the finding.
              </Text>
              {deviceIdentityRows().map(([label, value]) => (
                <Text key={label} style={styles.identityLine} selectable>
                  {`${label}: ${value}`}
                </Text>
              ))}
            </View>
          </View>
        </>
      ) : null}

      {/* Lifetime stats — kept as a small footer card so the info survives. */}
      <View style={styles.statsCard}>
        <Text style={styles.statsTitle}>Lifetime stats</Text>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Sent</Text>
          <Text style={styles.statValue}>{formatBytes(stats.sentBytes)}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Received</Text>
          <Text style={styles.statValue}>
            {formatBytes(stats.receivedBytes)}
          </Text>
        </View>
      </View>

      {/* Label prompt for the export. Same one-field modal the share flow
          uses, with copy overridden for this job. */}
      <NameShareModal
        visible={labelPromptOpen}
        defaultName=""
        fileCount={1}
        title="Label this log"
        subtitle="The label goes in the filename so we can tell reports apart."
        placeholder="e.g. stuck at 0 percent"
        confirmLabel="Export"
        confirmIcon="share-outline"
        onCancel={() => setLabelPromptOpen(false)}
        onConfirm={(label) => void onExportWithLabel(label)}
      />

      <ConfirmModal
        visible={confirmSpec !== null}
        title={confirmSpec?.title ?? ""}
        body={confirmSpec?.body}
        confirmLabel={confirmSpec?.confirmLabel}
        cancelLabel={confirmSpec?.cancelLabel}
        tone={confirmSpec?.tone ?? "destructive"}
        onConfirm={() => settleConfirm(true)}
        // Backdrop tap and hardware back both land here — and both mean
        // "keep the log". There is no path from a dismissal to a clear.
        onCancel={() => settleConfirm(false)}
      />
    </ScrollView>
  );
}

function SectionLabel({
  theme,
  children,
}: {
  theme: AppTheme;
  children: React.ReactNode;
}) {
  return (
    <Text
      style={{
        color: theme.muted,
        fontSize: 12,
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginTop: 20,
        marginBottom: 8,
        paddingHorizontal: 4,
      }}
    >
      {children}
    </Text>
  );
}

type RowProps = {
  theme: AppTheme;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  /**
   * Optional second line under the label. Added for the background rows,
   * whose labels cannot carry their own explanation without reading as an
   * instruction. Rows that omit it render exactly as before.
   */
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  first?: boolean;
  trailing?: React.ComponentProps<typeof Ionicons>["name"];
};

function SettingsRow({
  theme,
  icon,
  label,
  subtitle,
  value,
  onPress,
  first,
  trailing = "chevron-forward",
}: RowProps) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: theme.border,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          backgroundColor: theme.primary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={18} color={theme.onPrimary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: theme.text,
            fontSize: 15,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
        {subtitle ? (
          <Text
            style={{
              color: theme.muted,
              fontSize: 12,
              lineHeight: 16,
              marginTop: 2,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={{ color: theme.muted, fontSize: 13, marginRight: 4 }}>
          {value}
        </Text>
      ) : null}
      <Ionicons name={trailing} size={18} color={theme.muted} />
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    content: { paddingHorizontal: theme.pad },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      // 0, not 16. The profile card that used to sit between the
      // title and the first section header is gone, so this margin would
      // stack with SectionLabel's own marginTop: 20 and give the first
      // header 36px where every later one gets 20.
      marginBottom: 0,
    },
    backBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { fontSize: 26, fontWeight: "700", color: theme.text },
    sectionCard: {
      backgroundColor: theme.card,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: "hidden",
    },
    themePanel: {
      paddingHorizontal: 16,
      paddingBottom: 16,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    followRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingTop: 12,
    },
    followLabel: { color: theme.text, fontWeight: "600", fontSize: 14 },
    followHint: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 2,
      lineHeight: 16,
    },
    // the delay picker. Same border/active tokens as themeRow
    // below, sized down to a chip because the values are two or three
    // characters and sit inside an existing row.
    delayPicker: { flexDirection: "row", gap: 6, marginTop: 8 },
    delayChip: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: 12,
      paddingVertical: 5,
      backgroundColor: theme.cardStrong,
    },
    delayChipActive: {
      backgroundColor: theme.tabActiveOverlay,
      borderColor: theme.primaryMuted,
    },
    delayChipText: { color: theme.muted, fontSize: 12, fontWeight: "600" },
    delayChipTextActive: { color: theme.text },
    themeList: { gap: 8 },
    themeListDisabled: { opacity: 0.5 },
    themeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: theme.cardStrong,
    },
    themeRowActive: {
      backgroundColor: theme.tabActiveOverlay,
      borderColor: theme.primaryMuted,
    },
    swatchRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    swatch: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: theme.border,
    },
    themeLabel: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    statsCard: {
      marginTop: 20,
      backgroundColor: theme.card,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 16,
    },
    statsTitle: {
      color: theme.text,
      fontSize: 13,
      fontWeight: "700",
      marginBottom: 8,
    },
    statRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 4,
    },
    statLabel: { color: theme.muted, fontSize: 13, fontWeight: "600" },
    statValue: { color: theme.text, fontSize: 13, fontWeight: "600" },
    // debug logging block inside the Support card.
    debugRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    debugPanel: {
      paddingHorizontal: 16,
      paddingBottom: 16,
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingTop: 12,
    },
    debugMeta: { color: theme.muted, fontSize: 12 },
    // the harness card's preamble. Same padding as debugPanel but
    // leading the card, so no top hairline.
    harnessNote: { paddingHorizontal: 16, paddingVertical: 14, gap: 8 },
    // the identity block. One line per field, monospaced so a
    // ROM build ID is legible and so two devices' readouts line up when
    // pasted side by side in a report.
    identityPanel: {
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    identityLine: {
      color: theme.text,
      fontSize: 12,
      lineHeight: 18,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    debugWarn: { color: theme.warning, fontSize: 12, lineHeight: 16 },
    debugActions: { flexDirection: "row", gap: 8, marginTop: 2 },
    debugBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.primary,
      borderRadius: 12,
      paddingVertical: 11,
    },
    debugBtnDisabled: { opacity: 0.5 },
    debugBtnText: { color: theme.onPrimary, fontSize: 14, fontWeight: "700" },
    debugBtnGhost: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
      paddingVertical: 11,
      paddingHorizontal: 16,
    },
    debugBtnGhostText: { color: theme.danger, fontSize: 14, fontWeight: "700" },
  });
}
