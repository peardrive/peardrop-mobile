import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type EmptyStateProps = {
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  subtitle?: string;
};

/**
 * Themed empty state: soft round icon badge over a title + subtitle. Callers
 * pass Ionicons `name`; defaults to `sparkles-outline` when omitted.
 */
export default function EmptyState({
  icon = "sparkles-outline",
  title,
  subtitle,
}: EmptyStateProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.root} accessibilityRole="summary">
      <View style={styles.iconBadge}>
        <Ionicons name={icon} size={28} color={theme.muted} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      gap: 10,
    },
    iconBadge: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    title: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      textAlign: "center",
    },
    subtitle: {
      color: theme.muted,
      fontSize: 13,
      textAlign: "center",
      lineHeight: 18,
    },
  });
}
