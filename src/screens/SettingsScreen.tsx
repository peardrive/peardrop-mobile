import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAppTheme } from "../state/ThemeContext";
import { THEME_ORDER, themes } from "../ui/themes";
import { loadStats, subscribeStats, type Stats } from "../state/statsStorage";
import { formatBytes } from "../lib/format";
import { useToast } from "../ui/Toast";
import type { AppTheme } from "../ui/themes";
import { useDebugLogging } from "../state/debugLogStorage";
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

// Section list (Appearance / Support) with a profile placeholder on top.
// Edit Account / Language / Report / About / Sign out are toast placeholders;
// only Theme is wired.

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

        {/* Sits next to "Report a bug" — same job, producing something
            diagnosable. */}
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
