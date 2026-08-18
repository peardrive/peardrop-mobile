import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "../ui/themes";
import { useBackend } from "../state/backend";
import { errorMessage } from "../lib/errorMessage";

type Scenario = {
  id: string;
  name: string;
  section: string;
  description: string;
};

const SCENARIOS: Scenario[] = [
  // Share tab scenarios (7)
  {
    id: "share-baseline",
    name: "Share baseline churn",
    section: "Share: Upload Card",
    description: "Current flow: peers join over time and one completes early.",
  },
  {
    id: "share-late-surge",
    name: "Share late surge peers",
    section: "Share: Upload Card",
    description: "Starts calm, then several peers join late and percentage rebalances.",
  },
  {
    id: "share-flappy",
    name: "Share flappy peer",
    section: "Share: Upload Card",
    description: "One peer repeatedly disconnects/reconnects while transfer continues.",
  },
  {
    id: "share-stall-resume",
    name: "Share stall and resume",
    section: "Share: Upload Card",
    description: "All peers drop temporarily; transfer stalls and then resumes.",
  },
  {
    id: "share-many-peers",
    name: "Share many peers stress",
    section: "Share: Upload Card",
    description: "High peer count to test card stability and detail readability.",
  },
  {
    id: "share-early-multi-complete",
    name: "Share multiple early completions",
    section: "Share: Upload Card",
    description: "More than one peer completes early to test denominator jumps.",
  },
  {
    id: "share-rapid-restart",
    name: "Share rapid restart",
    section: "Share: Upload Card",
    description: "Starts a test and quickly starts another to catch stale timers.",
  },
  // Receive tab scenarios (7)
  {
    id: "receive-baseline",
    name: "Receive baseline download",
    section: "Receive: Transfer Strip",
    description: "Single sender baseline for receive progress and completion strip.",
  },
  {
    id: "receive-sender-drop",
    name: "Receive sender disconnect",
    section: "Receive: Transfer Strip",
    description: "Sender drops before completion to verify disconnect messaging/behavior.",
  },
  {
    id: "receive-stall-resume",
    name: "Receive stall and resume",
    section: "Receive: Transfer Strip",
    description: "Receive progress pauses and resumes after temporary sender loss.",
  },
  {
    id: "receive-tiny-file",
    name: "Receive tiny file",
    section: "Receive: Transfer Strip",
    description: "Small payload to validate formatting and rapid completion state.",
  },
  {
    id: "receive-huge-file",
    name: "Receive huge file",
    section: "Receive: Transfer Strip",
    description: "Large payload to validate long-running receive progress display.",
  },
  {
    id: "receive-out-of-order",
    name: "Receive out-of-order events",
    section: "Receive: Transfer Strip",
    description: "Progress event appears before expected peer event order.",
  },
  {
    id: "receive-rapid-restart",
    name: "Receive rapid restart",
    section: "Receive: Transfer Strip",
    description: "Back-to-back receive tests to catch stale state or overlap issues.",
  },
];

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    content: { padding: theme.pad, paddingBottom: 36 },
    title: { fontSize: 26, fontWeight: "700", color: theme.text, marginBottom: 6 },
    sub: { fontSize: 14, color: theme.muted, marginBottom: 12, lineHeight: 20 },
    card: {
      marginTop: 10,
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 12,
      padding: 12,
    },
    cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    name: { flex: 1, color: theme.text, fontWeight: "700", fontSize: 15 },
    badge: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeText: { color: theme.muted, fontSize: 11, fontWeight: "700" },
    meta: { marginTop: 6, color: theme.muted, fontSize: 12, fontWeight: "600" },
    desc: { marginTop: 6, color: theme.text, fontSize: 13, lineHeight: 18 },
    actionRow: { marginTop: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    btn: {
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      backgroundColor: theme.primary,
      minWidth: 98,
      alignItems: "center",
    },
    btnText: { color: theme.onPrimary, fontWeight: "700", fontSize: 13 },
    stateText: { color: theme.muted, fontSize: 12 },
    message: { marginTop: 12, color: theme.text, fontSize: 13 },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tabFromSection(section: string): "Share" | "Receive" | "Settings" | "Test Bed" {
  const tab = String(section || "").split(":")[0]?.trim();
  if (tab === "Receive" || tab === "Settings" || tab === "Test Bed") return tab;
  return "Share";
}

export default function TestBedScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { ready, runFakeUploadTest } = useBackend();
  const navigation = useNavigation<any>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function runScenario(id: string) {
    switch (id) {
      case "share-baseline":
        return runFakeUploadTest({
          durationMs: 22000,
          tickMs: 850,
          peers: 3,
          totalBytes: 32 * 1024 * 1024,
          peerPrefix: "ux-peer",
        });
      case "share-late-surge":
        return runFakeUploadTest({
          durationMs: 26000,
          tickMs: 850,
          peers: 6,
          totalBytes: 32 * 1024 * 1024,
          peerPrefix: "surge-peer",
        });
      case "share-flappy":
        return runFakeUploadTest({
          durationMs: 24000,
          tickMs: 900,
          peers: 3,
          totalBytes: 32 * 1024 * 1024,
          peerPrefix: "flap-peer",
          flapPeer: true,
        });
      case "share-stall-resume":
        return runFakeUploadTest({
          durationMs: 28000,
          tickMs: 900,
          peers: 3,
          totalBytes: 32 * 1024 * 1024,
          peerPrefix: "stall-peer",
          stallAtMs: 10000,
          stallDurationMs: 6000,
        });
      case "share-many-peers":
        return runFakeUploadTest({
          durationMs: 28000,
          tickMs: 800,
          peers: 6,
          totalBytes: 128 * 1024 * 1024,
          peerPrefix: "stress-peer",
        });
      case "share-early-multi-complete":
        return runFakeUploadTest({
          durationMs: 24000,
          tickMs: 850,
          peers: 4,
          totalBytes: 48 * 1024 * 1024,
          peerPrefix: "early-peer",
          earlyCompletePeers: 2,
        });
      case "share-rapid-restart": {
        const first = await runFakeUploadTest({
          durationMs: 22000,
          tickMs: 850,
          peers: 3,
          totalBytes: 32 * 1024 * 1024,
          peerPrefix: "restart-a",
        });
        if (!first.ok) return first;
        await sleep(800);
        return runFakeUploadTest({
          durationMs: 22000,
          tickMs: 850,
          peers: 3,
          totalBytes: 32 * 1024 * 1024,
          peerPrefix: "restart-b",
        });
      }
      case "receive-baseline":
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 18000,
          tickMs: 800,
          peers: 1,
          totalBytes: 32 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-base",
        });
      case "receive-sender-drop":
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 18000,
          tickMs: 850,
          peers: 1,
          totalBytes: 32 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-drop",
          earlyCompletePeers: 1,
        });
      case "receive-stall-resume":
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 22000,
          tickMs: 850,
          peers: 1,
          totalBytes: 32 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-stall",
          stallAtMs: 8000,
          stallDurationMs: 5000,
        });
      case "receive-tiny-file":
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 7000,
          tickMs: 500,
          peers: 1,
          totalBytes: 128 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-tiny",
        });
      case "receive-huge-file":
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 32000,
          tickMs: 1100,
          peers: 1,
          totalBytes: 2 * 1024 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-huge",
        });
      case "receive-out-of-order":
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 18000,
          tickMs: 800,
          peers: 1,
          totalBytes: 32 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-order",
          outOfOrderStart: true,
        });
      case "receive-rapid-restart": {
        const first = await runFakeUploadTest({
          simulate: "received",
          durationMs: 18000,
          tickMs: 800,
          peers: 1,
          totalBytes: 32 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-restart-a",
        });
        if (!first.ok) return first;
        await sleep(700);
        return runFakeUploadTest({
          simulate: "received",
          durationMs: 18000,
          tickMs: 800,
          peers: 1,
          totalBytes: 32 * 1024 * 1024,
          forceSelfPeer: true,
          peerPrefix: "recv-restart-b",
        });
      }
      default:
        return { ok: false, error: "Unknown scenario." };
    }
  }

  async function onStartScenario(s: Scenario) {
    if (busyId) return;
    setBusyId(s.id);
    setMessage("");
    navigation.navigate(tabFromSection(s.section));
    try {
      const out = await runScenario(s.id);
      if (!out.ok) {
        setMessage(`${s.name}: ${errorMessage(out.error) || "failed to start."}`);
        return;
      }
      setMessage(`${s.name}: started.`);
    } catch (err: unknown) {
      setMessage(`${s.name}: ${String((err as Error)?.message || err)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ScrollView style={[styles.root, { paddingTop: insets.top + theme.pad }]} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Test Bed</Text>
      <Text style={styles.sub}>
        Start upload UX scenarios from one place. Section shows where to watch behavior in the app.
      </Text>

      {SCENARIOS.map((s) => (
        <View key={s.id} style={styles.card}>
          <View style={styles.cardTop}>
            <Text style={styles.name}>{s.name}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{s.section}</Text>
            </View>
          </View>
          <Text style={styles.desc}>{s.description}</Text>
          <View style={styles.actionRow}>
            <Text style={styles.stateText}>{ready ? "Backend ready" : "Backend not ready"}</Text>
            <Pressable style={styles.btn} disabled={!ready || !!busyId} onPress={() => onStartScenario(s)}>
              {busyId === s.id ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Text style={styles.btnText}>Start test</Text>
              )}
            </Pressable>
          </View>
        </View>
      ))}

      {!!message && <Text style={styles.message}>{message}</Text>}
    </ScrollView>
  );
}

