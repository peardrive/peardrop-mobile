import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type StatusScreenTone = "primary" | "warning" | "danger";

export type StatusScreenAction = {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary";
};

export type StatusScreenProps = {
  tone: StatusScreenTone;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  body: string;
  actions: StatusScreenAction[];
};

/**
 * Full-screen status/error surface: large tinted-tile icon at top, bold
 * title, muted body, one or two bottom CTAs. All colors token-driven so
 * the same shell works for No connection, Peer not found, File
 * unavailable, Something went wrong, and Report sent.
 */
export default function StatusScreen({
  tone,
  icon,
  title,
  body,
  actions,
}: StatusScreenProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const toneColor =
    tone === "primary"
      ? theme.primary
      : tone === "danger"
        ? theme.danger
        : theme.warning;
  return (
    <View style={[styles.root, { paddingTop: insets.top + 24 }]}>
      <View style={styles.body}>
        <View
          style={[
            styles.tile,
            { backgroundColor: `${toneColor}22`, borderColor: toneColor },
          ]}
        >
          <Ionicons name={icon} size={56} color={toneColor} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.copy}>{body}</Text>
      </View>
      <View style={[styles.actions, { paddingBottom: insets.bottom + 16 }]}>
        {actions.map((a) => {
          const isPrimary = (a.kind ?? "primary") === "primary";
          return (
            <Pressable
              key={a.label}
              onPress={a.onPress}
              style={[
                styles.actionBtn,
                isPrimary ? styles.actionPrimary : styles.actionSecondary,
              ]}
              accessibilityRole="button"
              accessibilityLabel={a.label}
            >
              <Text
                style={[
                  styles.actionLabel,
                  isPrimary
                    ? styles.actionLabelPrimary
                    : styles.actionLabelSecondary,
                ]}
              >
                {a.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.bg,
      paddingHorizontal: theme.pad * 1.5,
    },
    body: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
    },
    tile: {
      width: 128,
      height: 128,
      borderRadius: 32,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8,
    },
    title: {
      color: theme.text,
      fontSize: 24,
      fontWeight: "800",
      textAlign: "center",
    },
    copy: {
      color: theme.muted,
      fontSize: 15,
      lineHeight: 22,
      textAlign: "center",
      paddingHorizontal: 12,
    },
    actions: { gap: 10, paddingTop: 12 },
    actionBtn: {
      borderRadius: theme.radius,
      paddingVertical: 14,
      alignItems: "center",
    },
    actionPrimary: { backgroundColor: theme.primary },
    actionSecondary: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: theme.border,
    },
    actionLabel: { fontSize: 15, fontWeight: "700" },
    actionLabelPrimary: { color: theme.onPrimary },
    actionLabelSecondary: { color: theme.text },
  });
}
