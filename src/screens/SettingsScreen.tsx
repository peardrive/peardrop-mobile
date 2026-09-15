import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
 * how long a probe verdict stays on screen. Longer than the 2.6 s
 * default because the operator is working down a list with a pen in hand and
 * may be reading it on the way back from an OEM settings screen.
 */
const PROBE_TOAST_MS = 6_000;

const SIMULATE_DURATION_MS = 4_000;
/** Simulation tick. Completion can only land on a tick boundary. */
const SIMULATE_TICK_MS = 500;
/**
 * how long the simulation ACTUALLY takes — 3 s, not the 4 s
 * `SIMULATE_DURATION_MS` implies. 6I's label was 1 s optimistic because of
 * this gap, and the device run showed completions at ~14.0 s against a
 * promised 15 s.
 *
 * Where the second goes: the engine reads `earlyCompletePeers` as
 * `Number(opts.earlyCompletePeers || 1)`. 6I passed `0` to disable early
 * disconnect, but `0` is falsy, so `|| 1` silently restores it to 1. One
 * peer is therefore disconnected at `durationMs * 0.65` = 2600 ms, leaving
 * nobody connected; the next tick at 3000 ms sees `activeWeight <= 0` with
 * every peer having joined and completes via the `path=no-peers` branch —
 * exactly what 6I's log recorded.
 *
 * That coercion lives in `backend/`, which this sprint must not touch, so
 * the early disconnect is treated as the intended behaviour and the offset
 * is matched to it rather than fought. Completion is therefore
 * deterministic at `ceil(4000 * 0.65 / 500) * 500` = 3000 ms.
 */
const SIMULATE_RUN_MS =
  Math.ceil((SIMULATE_DURATION_MS * 0.65) / SIMULATE_TICK_MS) * SIMULATE_TICK_MS;

/**
 * the SUSTAINED simulate — a peer that stays connected.
 *
 * The primary instrument for test case A. The existing delayed simulate
 * cannot serve: it emits nothing for the whole delay (the engine's delayed
 * branch returns immediately without events), so `transfers` is empty and
 * the predicate is correctly false at the moment the protocol says to
 * background. Its real activity then lasts 2.6 s before the peer
 * disconnects, after which only 8A's 10-minute idle-host grace keeps the
 * predicate true — the wrong branch.
 *
 * Two argument changes make the peer stay attached, both RN-side; `backend/`
 * is untouched.
 *
 * `earlyCompletePeers: 0` is the one that matters. The engine reads it with
 * `??` rather than `||` precisely so zero is meaningful — its own comment
 * says zero means "no peer disconnects early". That removes the
 * `durationMs * 0.65` disconnect, which is the entire mechanism
 * SIMULATE_RUN_MS exists to model.
 *
 * `startDelayMs: 0` removes the wait. The peer connects during the RPC, so
 * the predicate is already true when the operator backgrounds.
 *
 * THE SIMULATE_RUN_MS COUPLING IS UNAFFECTED. That constant converts a
 * promised completion time into a start delay, and models the 0.65
 * disconnect. This instrument sets both inputs to zero, so it leaves the
 * arithmetic entirely rather than changing it. The existing 15 s / 1 min /
 * 3 min options still use it, unmodified.
 *
 * How long the peer actually stays: the single peer progresses at
 * `weight × fileBytes / durationMs`, and peer 0's weight is 0.75, so it
 * finishes at `durationMs / 0.75` — 20 minutes for the value below. Sized
 * so that even at weight 1.0 it would still hold the full 15 minutes the
 * label promises. Longer than needed is the safe direction: the run not
 * completing inside the test window costs nothing.
 */
const SUSTAINED_DURATION_MS = 900_000;
/**
 * 5 s, not the 500 ms the short simulate uses. `tickMs` sets event
 * granularity only — total duration is `fileBytes / (rate × weight)` and is
 * independent of it — so this trades nothing but log volume, turning 1,800
 * progress events into 180.
 */
const SUSTAINED_TICK_MS = 5_000;

// dev-mode cards + demo panel are gone. The v5
// redesign groups the surviving surfaces (Theme + follow-system + stats)
// into a section list (Appearance / Support).
//
// the profile placeholder block, Edit Account, About and Report
// a bug were removed — every one of them was a toast stub or a screen that
// claimed to send something it never sent. Language survives because
// "English" is a true statement about the app even unwired.

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
  const { runFakeUploadTest } = useBackend();
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
   * Export: label prompt → bundle → share sheet → "Log shared?" confirm.
   *
   * The orchestrator owns the ordering guarantee (the log is only ever
   * cleared on an explicit "Clear it"); this callback only supplies the
   * side effects and reports the outcome.
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
              // Deliberately explicit: Android can't tell us whether the
              // share actually went through, so the user is the source of
              // truth and needs to know what each button does.
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
   * `notifyTransferComplete` entirely.
   *
   * This exists so a failed device test can tell "the channel is wrong"
   * apart from "the worklet was asleep". Going through
   * `notifyTransferComplete` would reintroduce both the AppState guard and
   * the dependency on a real transfer, which is exactly what needs
   * isolating. Because it skips that guard, this one *does* show while the
   * app is in the foreground — that is the point.
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
          // same accent as the real path, so this row still
          // isolates the channel rather than also differing in appearance.
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
   * fire a REAL `upload-complete` from the engine after a delay,
   * so the tester can background the app and see whether the notification
   * actually arrives.
   *
   * Deliberately not a shortcut to `notifyTransferComplete`: this goes
   * engine → IPC → BackendProvider's upload-complete handler → the same
   * AppState guard and the same wording every real transfer uses. A
   * simulation that skipped that chain would prove nothing about it.
   *
   * The complement of "Send a test notification" above, not a replacement:
   * that one bypasses the guard to isolate the channel, this one exercises
   * the whole path. A failure in one and not the other localises the fault.
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
        // Subtract the simulation's real 3 s so the total lands on the
        // delay the label promises. See SIMULATE_RUN_MS.
        startDelayMs: Math.max(0, delayMs - SIMULATE_RUN_MS),
        durationMs: SIMULATE_DURATION_MS,
        tickMs: SIMULATE_TICK_MS,
        peers: 1,
        forceSelfPeer: true,
        // Engine floor. Kept minimal because the RN handler tallies a
        // hosted completion into lifetime "sent" stats — see the report.
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
   * fire one OEM candidate and report the outcome three ways.
   *
   * Three outcomes, not two. `not-found` is an ActivityNotFoundException —
   * could not launch, and under Android 11+ package visibility that is
   * genuinely ambiguous between "the activity is absent" and "the package is
   * invisible to us". `error` is anything else, and carries its exception
   * class: a SecurityException from a component that exists but is not
   * exported is a different finding entirely, and collapsing the two into
   * "didn't work" would discard it.
   *
   * The toast is for the operator standing in front of the phone; the
   * `rn.probe.oem` log line written inside `runProbe` is the record. Both
   * always, because a borrowed-device session is read afterwards.
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

  // ---------------------------------------------------------------
  // Phase 2B: the foreground service, as three harness rows.
  //
  // 6R's null result was measured on Xiaomi with Autostart off, where nothing
  // but Autostart would have helped. On a Pixel or a Samsung a foreground
  // service is the standard mechanism and has never been tried. Three rows
  // rather than one, because the foreground start, the background start and
  // the stop are three different questions.
  // ---------------------------------------------------------------
  const [bgStartArmed, setBgStartArmed] = useState(isBackgroundStartArmed);
  useEffect(() => subscribeBackgroundStart(setBgStartArmed), []);

  /**
   * whether the per-OEM fallback row has been earned. Subscribed
   * rather than read once, so the row appears in the same moment the third
   * bad window is recorded — the user may well be looking at this screen.
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
   * Arms (or disarms) the AppState handler — it does not start anything now.
   * The start happens on the next transition to `background`, which is the
   * path Android 12+ restricts and which this targets SDK 36 build is subject
   * to. A ForegroundServiceStartNotAllowedException there is the result, and
   * the native side resolves it as a value rather than throwing.
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
   * instrument (a): a simulate whose peer stays connected, so the
   * predicate returns `upload` for the whole run rather than falling through
   * to the idle-host grace window after 2.6 s.
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
   * instrument (b): the forced override. Fallback, not primary —
   * it bypasses `classifyTransfer` entirely, so it proves the service starts
   * and stops, not that a real transfer satisfies the predicate.
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
   * put the record into the state three service-attributed
   * freezes would have produced, so the prompt fires and the row appears
   * without waiting for a device to actually defeat the service.
   */
  const onForceFallback = useCallback(async () => {
    const next = await forceFallbackTriggered();
    showToast(
      `Streak ${next.serviceFreezeStreak}/${SERVICE_FREEZE_THRESHOLD}. The prompt should appear now.`,
      { kind: "warning", title: "fallback forced", durationMs: PROBE_TOAST_MS }
    );
  }, [showToast]);

  /**
   * clear the streak, the sticky stamp and promptedVersion, so
   * the prompt can be read again. Freeze history is preserved — see the
   * writer.
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
   * Which element leads the Support card.
   *
   * The card clips to a rounded corner, so a top hairline on whatever
   * renders first shows as a stray line hugging that corner. The
   * test-notification row is build-gated, so "first" cannot be a static prop
   * on it.
   *
   * the background row is now permanent, so it always leads in a
   * release build and the Debugging row can never be first. Order here must
   * match render order.
   */
  /**
   * Which Support row renders first, so it can suppress its top hairline.
   *
   * the `"autostart"` case is gone with the row it named. Keeping
   * it would have been worse than cosmetic — on a Xiaomi release build it
   * would still have resolved to `"autostart"`, so NO row would have claimed
   * `first`, and the fallback row would have worn a hairline against the
   * card's rounded edge.
   *
   * `"none"` is the honest answer when no SettingsRow leads the card, which
   * is now the common case: a release build on a device the service is
   * working on shows no row here at all. The Debugging toggle that follows
   * draws no border of its own and looks correct unaided.
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
        {/* Posts straight to the transfers channel — no engine, no
            AppState guard. Lets a tester confirm notifications work at all
            before blaming a transfer for not announcing itself.

            dev-gated. It had deliberately stayed in release as a
            support tool for real bug reports; that call was reversed — a
            release build should not offer a diagnostic that only means
            something to us. */}
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
        {/* removed the always-present Xiaomi Autostart row that
            stood here.

            7A/7B made it permanent for a good reason at the time: the prompt
            was one-shot, so a user who dismissed it had no way back and a
            user who never froze never learned the option existed. But it
            asked every Xiaomi owner to grant a permission before knowing
            whether they needed it, and the 2026-09-13 runs showed most of
            them do not — the foreground service sustained the engine on the
            Redmi with Autostart OFF, outperforming Autostart's own
            screen-locked run (2.0 s worst gap against 29 s).

            The row below replaces it and inverts the default: nothing is
            offered until this specific device has demonstrably defeated the
            service three times, and then it stays for good. Same destination
            on Xiaomi, same ladder, reached only by users who need it.

            `openAutostartSettings()` and its ladder are deliberately kept —
            see the note in openBackgroundSettings.ts. */}
        {/* the fallback row.

            Appears ONLY once the foreground service has demonstrably failed
            on this device — three weighted service-attributed bad background
            windows — and then stays, because the user has been told their
            phone stops PearDrop and withdrawing the fix after one good
            window would be worse than leaving it.

            Before it triggers there is nothing to fix and no row: the
            service handles the problem without asking, on every device
            measured on 2026-09-13. This replaces 7A/7B's always-present
            Autostart row, which asked everyone for a permission most of them
            never needed.

            Label and subtitle come from the same module the prompt reads, so
            the setting named here is the one on the screen that opens. Both
            destinations are global lists rather than PearDrop's own page, so
            the subtitle has to say what to look for once you arrive. */}
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

        {/* the other half of the pair above. That row proves the
            channel works; this one drives a real engine `upload-complete`
            through the full notification path, including the AppState
            guard — so it shows nothing unless the app is backgrounded.
            Dev-only: the flag is false in release, so the whole subtree —
            row, delay picker, and the useSimulateDelay subscription it
            reads — is unreachable. As of 6W the test-notification row above
            is gated on the same flag, so the pair appears and disappears
            together. */}
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
            {/* same Pressable + radio idiom as the theme list
                above, laid out in a row because three short values don't
                warrant full-width rows. */}
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

        {/* debugging. The toggle itself is NOT dev-gated: it's a
            real feature for bug reports, and the log export hanging off it
            is the only way to get diagnostics off a user's device. Only the
            instrumentation built on top of it is gated. */}
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

        {/* Read-only build identity. An operator checks this before starting
            a ten-minute background run instead of discovering afterwards that
            the log was empty; a 2026-09-06 session lost five runs that way.
            `selectable` so the gate source can be copied into a report.

            Gated, since 7C. It shipped ungated for one release because the
            reasoning was "it must work in the build where everything else is
            off" — which was about the INSTRUMENTED build, where the flag is
            true anyway. It never needed to be ungated to do its job, and
            ungating it put four lines of internal diagnostics in front of
            users, led by "Instrumentation NOT ARMED", which reads as
            something being broken.

            The wording is now unconditional, because the gate and the text
            read the same constant: inside this wrapper IS_DEBUG_BUILD is
            true by construction, so a NOT ARMED branch here could never
            render. The state it used to describe — an operator on a build
            with the gate off — is now conveyed by the row's ABSENCE, and by
            the export header's `instrument:` line, which is ungated and
            still says NOT ARMED in exactly that case. */}
        {IS_DEBUG_BUILD ? (
        <View style={styles.debugRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.followLabel}>Build</Text>
            <Text style={styles.followHint}>
              Instrumentation ARMED — heartbeats and probe will be recorded.
            </Text>
            <Text style={styles.debugMeta} selectable>
              {`${APP_VERSION} · ${BUILD_TYPE} · debuggable ${
                IS_DEBUGGABLE === null ? "unknown" : IS_DEBUGGABLE ? "yes" : "no"
              }`}
            </Text>
            <Text style={styles.debugMeta} selectable>
              {DEV_GATE_SOURCE}
            </Text>
          </View>
        </View>
        ) : null}

        {/* "Keep transfers awake (experimental)" was removed
            here. Device runs on 2026-08-24 showed the counter-`resume()` it
            drove made no difference in either direction — the worklet froze
            with it on and off under battery restriction. It was fighting
            SmartPower's process freeze, which `resume()` does not affect.
            The suspend probe's *logging* survives in backend.ts, gated on
            the debug-build flag and needing no toggle. */}
      </View>

      {/* ---------------------------------------------------------------
          the OEM background-settings test harness.

          A TEST INSTRUMENT, not a feature. Nothing here is reachable from a
          release build, and nothing here is wired into the shipping ladder
          in openBackgroundSettings.ts — that stays exactly as it was.

          Every row is visible on every device regardless of manufacturer,
          deliberately. The harness exists to find out which of these intents
          resolve where, and that requires trying the non-matching ones: a
          Samsung component that unexpectedly resolves on a Xiaomi is a
          finding, and gating rows by manufacturer would hide it.

          Android 11+ package visibility means queryIntentActivities returns
          nothing for undeclared packages, so there is no honest way to show
          "resolves / doesn't resolve" BEFORE the tap. The outcome is reported
          after the attempt instead. This sprint adds no <queries> block.

          One row, one intent, no fall-through. A ladder would hide which rung
          worked, which is precisely what needs measuring.
          --------------------------------------------------------------- */}
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

            {/* the foreground service. Same card, because it is the
                same question asked a different way — "can this app keep
                running" — and the operator works down one list.

                The service is declared only in the instrumented release
                build (src/instrumented/AndroidManifest.xml, added to the
                release source set under -PdevInstrumentation=true), and the
                bridge module is registered on the same flag. In any other
                build these three report "unavailable" and say why. */}
            {/* the two test-case-A instruments, in priority
                order. The first exercises the real `upload` branch of
                `isTransferActive()`; the second bypasses the predicate
                entirely and is the fallback. The decision log distinguishes
                them — `upload=1` versus `forced=true` — so a run can never
                be mistaken for the other afterwards. */}
            <SettingsRow
              theme={theme}
              icon="cloud-done-outline"
              label="Simulate sustained upload (15 min)"
              subtitle="Peer stays connected — exercises the real upload branch"
              onPress={() => void onSustainedSimulate()}
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

            {/* the fallback instruments.

                These write PERSISTED state, unlike the session-only
                forced-active flag above — the fallback's whole behaviour is
                "sticky once earned", and a session-only version could not
                test stickiness. The reset row is what undoes them, and it
                also closes the gap carried since 7B: prompt copy could
                previously be seen exactly once per install.

                Both log under `rn.fallback.forced`, saying in the line
                itself that the state was written rather than measured. Same
                principle as `forced=true` on the decision line — an
                exported log must never show a fallback that was really a
                test. */}
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

            {/* who this device says it is.

                Read FIRST, before any row is tapped — a result is only
                interpretable next to the device that produced it, and the
                whole block is `selectable` so it can be copied into a report
                rather than transcribed by hand off a borrowed phone.

                MANUFACTURER and BRAND lead, and are two fields rather than
                two spellings of one. `isXiaomiDevice()` matches MANUFACTURER;
                AutoStarter — the source for most of the candidates above —
                dispatches on BRAND. On a Redmi both agree and the question
                never arises; on a rebranded or carrier build it will, and
                which field is the right one is exactly what these rows are
                collected to answer.

                The last line is the live result of `isXiaomiDevice()` itself,
                not a re-derivation of its body, so the readout cannot drift
                from the predicate it is measuring. */}
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
