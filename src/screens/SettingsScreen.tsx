import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
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
import { runExportFlow, runManualReset } from "../lib/debugLogExport";
import { maxOnDiskBytes } from "../lib/debugLogFormat";
import ConfirmModal from "../ui/ConfirmModal";
import NameShareModal from "../ui/NameShareModal";

/**
 * The simulated transfer's nominal length. 4 s is the engine's clamp floor
 * (`Math.max(4000, …)`), so this is the shortest run available.
 */
const SIMULATE_DURATION_MS = 4_000;
/** Simulation tick. Completion can only land on a tick boundary. */
const SIMULATE_TICK_MS = 500;
/**
 * How long the simulation ACTUALLY takes — 3 s, not the 4 s
 * `SIMULATE_DURATION_MS` implies. A label of 4 s would be 1 s optimistic because of
 * this gap, and the device run showed completions at ~14.0 s against a
 * promised 15 s.
 *
 * Where the second goes: the engine reads `earlyCompletePeers` as
 * `Number(opts.earlyCompletePeers || 1)`. Passing `0` to disable early
 * disconnect, but `0` is falsy, so `|| 1` silently restores it to 1. One
 * peer is therefore disconnected at `durationMs * 0.65` = 2600 ms, leaving
 * nobody connected; the next tick at 3000 ms sees `activeWeight <= 0` with
 * every peer having joined and completes via the `path=no-peers` branch —
 * the `path=no-peers` branch.
 *
 * That coercion lives in `backend/`, which this sprint must not touch, so
 * the early disconnect is treated as the intended behaviour and the offset
 * is matched to it rather than fought. Completion is therefore
 * deterministic at `ceil(4000 * 0.65 / 500) * 500` = 3000 ms.
 */
const SIMULATE_RUN_MS =
  Math.ceil((SIMULATE_DURATION_MS * 0.65) / SIMULATE_TICK_MS) * SIMULATE_TICK_MS;

// The settings screen groups the surviving surfaces
// (Theme + follow-system + stats)
// into a section list (Appearance / Support), adds a profile placeholder
// block on top, and stubs Edit Account / Language / Report / About / Sign
// out as toast placeholders. Only Theme is actually wired.

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
  // Debug logging
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
          // Same accent as the real path, so this row still
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
   * Fire a REAL `upload-complete` from the engine after a delay,
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

  const onBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  const notYet = useCallback(
    (label: string) => () => showToast(`${label} isn't available yet.`),
    [showToast],
  );

  const styles = useMemo(() => createStyles(theme), [theme]);
  const activeThemeLabel = themes[themeId].label;

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

      {/* Profile block */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={28} color={theme.muted} />
        </View>
        <View style={styles.profileMain}>
          <Text style={styles.profileName}>User</Text>
          <Text style={styles.profileId} numberOfLines={1}>
            Local device
          </Text>
        </View>
      </View>

      {/* Appearance section */}
      <SectionLabel theme={theme}>Appearance</SectionLabel>
      <View style={styles.sectionCard}>
        <SettingsRow
          theme={theme}
          icon="person-circle-outline"
          label="Edit Account"
          onPress={notYet("Edit Account")}
          first
        />
        <SettingsRow
          theme={theme}
          icon="language-outline"
          label="Language"
          value="English"
          onPress={notYet("Language")}
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
        <SettingsRow
          theme={theme}
          icon="bug-outline"
          label="Report a bug"
          onPress={() => navigation.navigate("ReportBug")}
          first
        />
        <SettingsRow
          theme={theme}
          icon="information-circle-outline"
          label="About"
          onPress={notYet("About")}
        />
        {/* Posts straight to the transfers channel — no engine, no
            AppState guard. Lets a tester confirm notifications work at all
            before blaming a transfer for not announcing itself. */}
        <SettingsRow
          theme={theme}
          icon="notifications-outline"
          label="Send a test notification"
          onPress={() => void onTestNotification()}
          trailing="chevron-forward"
        />
        {/* The other half of the pair above. That row proves the
            channel works; this one drives a real engine `upload-complete`
            through the full notification path, including the AppState
            guard — so it shows nothing unless the app is backgrounded.

            Dev-only. `__DEV__` is statically false in release, so
            the whole subtree — row, delay picker, and the useSimulateDelay
            subscription it reads — is unreachable and stripped. The "Send a
            test notification" row ABOVE deliberately stays ungated: that one
            is a support tool for real bug reports, not instrumentation. */}
        {__DEV__ ? (
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
            {/* Same Pressable + radio idiom as the theme list
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

        {/* Debugging. Sits next to "Report a bug" because it's
            the same job — getting us something we can diagnose from. The
            toggle itself is NOT dev-gated: it's a real feature for bug
            reports. Only the instrumentation built on top of it is. */}
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

        {/* Do not add a "keep transfers awake" toggle driving a
            counter-`resume()` on background. Measured on device, it makes no
            difference in either direction: the freeze comes from the OS
            process freezer, which `resume()` does not affect. */}
      </View>

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
  value?: string;
  onPress?: () => void;
  first?: boolean;
  trailing?: React.ComponentProps<typeof Ionicons>["name"];
};

function SettingsRow({
  theme,
  icon,
  label,
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
      <Text
        style={{
          flex: 1,
          color: theme.text,
          fontSize: 15,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
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
      marginBottom: 16,
    },
    backBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { fontSize: 26, fontWeight: "700", color: theme.text },
    profileCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: theme.card,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 16,
    },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
    },
    profileMain: { flex: 1 },
    profileName: {
      color: theme.text,
      fontSize: 17,
      fontWeight: "700",
      marginBottom: 2,
    },
    profileId: {
      color: theme.muted,
      fontSize: 13,
    },
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
    // The delay picker. Same border/active tokens as themeRow
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
    // Debug logging block inside the Support card.
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
