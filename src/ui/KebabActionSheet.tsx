import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import BottomSheet from "./BottomSheet";

export type KebabActionItem = {
  /** Stable key. Falls back to `label` when omitted. */
  key?: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  /** `danger` tints icon + label with `theme.danger`. */
  tone?: "default" | "danger";
  /** Optional accessibility label if `label` is ambiguous. */
  accessibilityLabel?: string;
  /** Optional: mark the row as toggled-on (icon takes `theme.primary`). */
  activeTint?: boolean;
};

/**
 * v5: identity header at the top of the kebab sheet — matches the design
 * deck's "who is this action list about" cue. Thumbnail rendering mirrors
 * ShareRow so the item reads identically wherever it appears.
 */
export type KebabActionHeader = {
  /** Fallback glyph shown when no `previewUri`. */
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  /** Optional local URI for the tile image (single-file image rows). */
  previewUri?: string | null;
  name: string;
  /** Sub-line, e.g. "Video · 1.2 GB". Hidden when absent. */
  meta?: string | null;
  /** Bundle tile styling (filled folder over `theme.secondary`). */
  isBundle?: boolean;
};

export type KebabActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  items: KebabActionItem[];
  /**
   * Optional identity header for the target row. Renders above the action
   * list with a divider between. Preferred over `title` for per-item sheets.
   */
  header?: KebabActionHeader;
  /**
   * Optional uppercase caption shown at the top — kept for callers like the
   * multi-select variant that want a heading instead of a per-row header.
   */
  title?: string;
};

/**
 * Data-driven action list rendered inside the shared BottomSheet. Base
 * sheet chrome (scrim, safe-area padding, opaque bg) comes from
 * BottomSheet so translucent-theme bleedthrough can't recur here.
 */
export default function KebabActionSheet({
  visible,
  onClose,
  items,
  header,
  title,
}: KebabActionSheetProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <BottomSheet visible={visible} onClose={onClose} sideInset>
      {header ? (
        <>
          <View style={styles.header}>
            <View style={styles.thumb}>
              {header.previewUri ? (
                <Image
                  source={{ uri: header.previewUri }}
                  style={styles.thumbImage}
                  resizeMode="cover"
                />
              ) : header.isBundle ? (
                // Unified folder treatment — outline glyph + brand green.
                <Ionicons
                  name="folder-outline"
                  size={26}
                  color={theme.primary}
                />
              ) : (
                <Ionicons name={header.iconName} size={24} color={theme.text} />
              )}
            </View>
            <View style={styles.headerMain}>
              <Text style={styles.headerName} numberOfLines={1}>
                {header.name}
              </Text>
              {header.meta ? (
                <Text style={styles.headerMeta} numberOfLines={1}>
                  {header.meta}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.headerDivider} />
        </>
      ) : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {items.map((item, i) => {
        const isDanger = item.tone === "danger";
        const iconColor = isDanger
          ? theme.danger
          : item.activeTint
            ? theme.primary
            : theme.text;
        return (
          <React.Fragment key={item.key ?? item.label}>
            {i > 0 ? <View style={styles.divider} /> : null}
            <Pressable
              style={styles.row}
              onPress={item.onPress}
              accessibilityRole="button"
              accessibilityLabel={item.accessibilityLabel ?? item.label}
            >
              <Ionicons name={item.icon} size={22} color={iconColor} />
              <Text
                style={[styles.rowText, isDanger && styles.rowTextDanger]}
              >
                {item.label}
              </Text>
            </Pressable>
          </React.Fragment>
        );
      })}
    </BottomSheet>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 4,
    },
    thumb: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: theme.cardStrong,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    thumbImage: { width: "100%", height: "100%" },
    headerMain: { flex: 1, minWidth: 0 },
    headerName: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
    },
    headerMeta: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 2,
      fontWeight: "500",
    },
    headerDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginTop: 8,
      marginBottom: 4,
    },
    title: {
      color: theme.muted,
      fontSize: 12,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      paddingVertical: 6,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingVertical: 14,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    rowText: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "500",
    },
    rowTextDanger: {
      color: theme.danger,
    },
  });
}
