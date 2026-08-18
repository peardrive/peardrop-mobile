import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMainDockBottomInset } from "../navigation/dockLayout";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "../ui/themes";
import { formatBytes } from "../lib/format";
import { loadStats, subscribeStats, type Stats } from "../state/statsStorage";

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    content: { paddingHorizontal: theme.pad },
    headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
    title: { fontSize: 26, fontWeight: "700", color: theme.text, marginBottom: 6 },
    sub: { fontSize: 14, color: theme.muted, marginBottom: theme.pad },
    iconBtn: {
      width: 38,
      height: 38,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.cardStrong,
    },
    profileCard: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.card,
      padding: 16,
      marginTop: 8,
      alignItems: "center",
    },
    avatar: {
      width: 74,
      height: 74,
      borderRadius: 37,
      backgroundColor: theme.tabActiveOverlay,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 12,
    },
    name: { color: theme.text, fontWeight: "700", fontSize: 18 },
    info: { color: theme.muted, fontSize: 13, marginTop: 10, textAlign: "center" },
    statsCard: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.card,
      marginTop: 12,
      overflow: "hidden",
    },
    statRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    statRowFirst: {
      borderTopWidth: 0,
    },
    statLabel: { color: theme.muted, fontSize: 16, fontWeight: "600" },
    statValue: { color: theme.text, fontSize: 16, fontWeight: "600" },
    startCard: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.card,
      marginTop: 12,
      padding: 20,
      alignItems: "center",
      gap: 8,
    },
    startTitle: { color: theme.text, fontWeight: "700", fontSize: 16, textAlign: "center" },
    startBody: { color: theme.muted, fontSize: 13, textAlign: "center", lineHeight: 18 },
    startBtn: {
      marginTop: 10,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 10,
      backgroundColor: theme.primary,
    },
    startBtnText: { color: theme.onPrimary, fontWeight: "700", fontSize: 13 },
  });
}

export default function AccountScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const dockBottom = useMainDockBottomInset();
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [stats, setStats] = useState<Stats>({
    sentBytes: 0,
    receivedBytes: 0,
    updatedAt: 0,
  });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadStats().then((s) => {
        if (active) setStats(s);
      });
      const unsub = subscribeStats((s) => {
        if (active) setStats(s);
      });
      return () => {
        active = false;
        unsub();
      };
    }, [])
  );

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top + theme.pad }]}
      contentContainerStyle={[styles.content, { paddingBottom: dockBottom + 16 }]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.title}>Account</Text>
        <View style={styles.headerActions}>
          <Pressable style={styles.iconBtn} onPress={() => navigation.navigate("Settings")}>
            <Ionicons name="settings-outline" size={19} color={theme.text} />
          </Pressable>
        </View>
      </View>
      <Text style={styles.sub}>Your stats and settings live here.</Text>

      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={36} color={theme.primary} />
        </View>
        <Text style={styles.name}>You</Text>
      </View>

      {stats.sentBytes === 0 && stats.receivedBytes === 0 ? (
        <View style={styles.startCard} accessibilityRole="summary">
          <Ionicons name="share-outline" size={32} color={theme.primary} />
          <Text style={styles.startTitle}>Let&apos;s get moving</Text>
          <Text style={styles.startBody}>
            Nothing sent or received yet. Head to the Share tab and pick a
            file — takes about ten seconds.
          </Text>
          <Pressable
            style={styles.startBtn}
            onPress={() => navigation.navigate("Share")}
            accessibilityRole="button"
            accessibilityLabel="Go to Share tab"
          >
            <Text style={styles.startBtnText}>Take me there</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.statsCard}>
          <View style={[styles.statRow, styles.statRowFirst]}>
            <Text style={styles.statLabel}>Sent</Text>
            <Text style={styles.statValue}>{formatBytes(stats.sentBytes)}</Text>
          </View>

          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Received</Text>
            <Text style={styles.statValue}>{formatBytes(stats.receivedBytes)}</Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}
