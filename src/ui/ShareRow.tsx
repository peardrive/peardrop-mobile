import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import ActiveIndicator, { type ActiveIndicatorState } from "./ActiveIndicator";
import { useVideoThumbnail } from "../lib/videoThumbnail";

export type ShareRowStatus = {
  /** Copy shown in the sub-line. Falls through to `meta` when null/undefined. */
  label: string;
  /**
   * Which theme token drives the color:
   *  - "warning" → `theme.warning` (amber "Sharing (NN%)")
   *  - "primary" → `theme.primary` (green "Active"/"Completed")
   *  - "danger"  → `theme.danger` (failed)
   *  - "muted"   → default sub-text
   */
  tone: "warning" | "primary" | "danger" | "muted";
};

export type ShareRowProps = {
  /** Ionicons glyph shown when no thumbnail is available. */
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  /** Local file path or URI to render as the tile thumbnail (images only). */
  previewUri?: string | null;
  /** Local video file URI. A one-frame thumbnail is generated on demand
   *  and cached module-wide, then swapped in place of the type-icon tile.
   *  Ignored when `previewUri` is already set. */
  videoUri?: string | null;
  name: string;
  /** Secondary line shown when `status` is null (e.g. "38 KB · 2h ago"). */
  meta: string;
  status?: ShareRowStatus | null;
  isFavorite?: boolean;
  isPinned?: boolean;
  indicatorState: ActiveIndicatorState;
  isBundle?: boolean;
  dim?: boolean;
  onPress: () => void;
  onKebabPress: () => void;
  /** Row divider at top. `false` on the first row of the list. */
  showTopDivider?: boolean;
  /**
   * v5 multi-select: when true, the row swaps the kebab for a leading
   * checkbox and forwards taps to `onPress` as a toggle-selection
   * shortcut. Chevron stays for bundles (still expandable).
   */
  selectionMode?: boolean;
  /** Only meaningful when `selectionMode` is true. */
  selected?: boolean;
};

/**
 * v5 list row. Thumbnail tile (image preview or type icon), name + color-
 * coded status sub-line, optional inline star + pin, optional inline stop-
 * circle while sharing, kebab. Wraps in SwipeableRow at the call site.
 */
export default function ShareRow({
  iconName,
  previewUri,
  videoUri,
  name,
  meta,
  status,
  isFavorite,
  isPinned,
  indicatorState,
  isBundle,
  dim,
  onPress,
  onKebabPress,
  showTopDivider = true,
  selectionMode,
  selected,
}: ShareRowProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const videoThumb = useVideoThumbnail(previewUri ? null : videoUri);
  const thumbUri = previewUri ?? videoThumb;
  const subColor =
    status?.tone === "warning"
      ? theme.warning
      : status?.tone === "primary"
        ? theme.primary
        : status?.tone === "danger"
          ? theme.danger
          : theme.muted;
  const subText = status?.label ?? meta;
  return (
    <Pressable
      style={[
        styles.row,
        showTopDivider && styles.rowDivider,
        dim && !selectionMode && styles.rowDim,
      ]}
      onPress={onPress}
      accessibilityRole={selectionMode ? "checkbox" : "button"}
      accessibilityState={selectionMode ? { checked: !!selected } : undefined}
      accessibilityLabel={`${name}, ${subText}`}
    >
      <View style={styles.thumb}>
        {thumbUri ? (
          <Image
            source={{ uri: thumbUri }}
            style={styles.thumbImage}
            resizeMode="cover"
          />
        ) : isBundle ? (
          // Unified folder treatment: outline glyph in the brand green
          // on the same subtle-surface tile every folder uses across
          // the app (list row, kebab header, info modal, folder modal).
          <Ionicons name="folder-outline" size={28} color={theme.primary} />
        ) : (
          <Ionicons name={iconName} size={26} color={theme.text} />
        )}
        <ActiveIndicator state={indicatorState} />
      </View>
      <View style={styles.main}>
        <View style={styles.nameLine}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {isFavorite ? (
            <Ionicons
              name="star"
              size={15}
              color={theme.primary}
              style={styles.nameMark}
            />
          ) : null}
          {isPinned ? (
            <Ionicons
              name="pin"
              size={15}
              color={theme.primary}
              style={styles.nameMark}
            />
          ) : null}
        </View>
        <Text
          style={[styles.sub, { color: subColor }]}
          numberOfLines={1}
        >
          {subText}
        </Text>
      </View>
      {isBundle ? (
        <View
          style={styles.chevron}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Ionicons
            name="chevron-forward"
            size={18}
            color={theme.muted}
          />
        </View>
      ) : null}
      {selectionMode ? (
        <View
          style={styles.checkSlot}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <View
            style={[styles.checkbox, selected && styles.checkboxChecked]}
          >
            {selected ? (
              <Ionicons name="checkmark" size={14} color={theme.onPrimary} />
            ) : null}
          </View>
        </View>
      ) : (
        <Pressable
          style={styles.kebab}
          hitSlop={8}
          onPress={onKebabPress}
          accessibilityRole="button"
          accessibilityLabel={`More options for ${name}`}
        >
          <Ionicons name="ellipsis-vertical" size={20} color={theme.muted} />
        </Pressable>
      )}
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: theme.pad,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    rowDim: { opacity: 0.85 },
    checkSlot: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    thumb: {
      width: 48,
      height: 48,
      borderRadius: 12,
      // v5: filled tile (cardStrong) for non-image thumbs so video/audio/doc
      // read as tiles-with-glyph rather than thin outlined icons. Folders
      // override with theme.secondary at the call site.
      backgroundColor: theme.cardStrong,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      position: "relative",
    },
    thumbImage: { width: "100%", height: "100%" },
    main: { flex: 1, minWidth: 0 },
    nameLine: {
      flexDirection: "row",
      alignItems: "center",
      minWidth: 0,
    },
    name: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
      flexShrink: 1,
    },
    nameMark: { marginLeft: 6 },
    sub: {
      fontSize: 13,
      marginTop: 2,
      fontWeight: "500",
    },
    chevron: {
      width: 28,
      alignItems: "center",
      justifyContent: "center",
    },
    kebab: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
