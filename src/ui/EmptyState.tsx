import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type EmptyStateProps = {
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  subtitle?: string;
  /**
   * True when the empty list is a failure, not an absence — the shares
   * manifest could not be read, say, so the shares are on disk but unseen.
   * Key error states off this flag, never off a `kind` string: a kind added
   * to the union without a matching branch here would render calm.
   */
  isError?: boolean;
};

/**
 * Themed empty state: soft round icon badge over a title and subtitle.
 * Two palettes, calm for an absence and error for a failure, selected by
 * `isError`.
 */
export default function EmptyState({
  icon = "sparkles-outline",
  title,
  subtitle,
  isError = false,
}: EmptyStateProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.root} accessibilityRole="summary">
      <View style={[styles.iconBadge, isError && styles.iconBadgeError]}>
        <Ionicons
          name={icon}
          size={28}
          color={isError ? theme.danger : theme.muted}
        />
      </View>
      <Text style={[styles.title, isError && styles.titleError]}>{title}</Text>
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
    // A border and icon tint rather than a filled red panel: this is still an
    // empty list, and every theme defines `danger`, so none falls back to calm.
    iconBadgeError: {
      borderColor: theme.danger,
    },
    title: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      textAlign: "center",
    },
    titleError: {
      color: theme.danger,
    },
    subtitle: {
      color: theme.muted,
      fontSize: 13,
      textAlign: "center",
      lineHeight: 18,
    },
  });
}
