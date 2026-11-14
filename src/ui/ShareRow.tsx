import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import ActiveIndicator, { type ActiveIndicatorState } from "./ActiveIndicator";
import { useVideoThumbnail } from "../lib/videoThumbnail";
import { PINNING_ENABLED } from "../lib/pinning";
import { FileKindBadge } from "./FileTypeIcon";
import { highlightPlan } from "../lib/readyHighlight";
import { ShareProgressBar } from "../vendor/pearkit/ShareState/ShareProgressBar";
import { shareBarColorsFrom, type ShareBar } from "../vendor/pearkit/ShareState/shareState";


/**
 * The tint, driven once per tick change.
 *
 * Keyed on the tick VALUE rather than a boolean, so a re-render cannot replay
 * it and the list can fire it again later for the same row. The whole sequence
 * is one `Animated.sequence` on one value with the native driver, which is the
 * lesson from the pear animation: a per-frame JS write is what stutters.
 */
function useReadyHighlight(tick: number): Animated.Value {
  const value = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduceMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => {
      if (mounted) setReduceMotion(v);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    // 0 is "never highlighted", so a freshly mounted row stays quiet.
    if (!tick) return undefined;
    const plan = highlightPlan(reduceMotion);
    value.setValue(0);
    if (!plan.animated) {
      // One tint, held, no animation at all. `setValue` either side of a plain
      // timer rather than a timing of duration 0, which still schedules frames.
      value.setValue(1);
      const id = setTimeout(() => value.setValue(0), plan.totalMs);
      return () => {
        clearTimeout(id);
        value.setValue(0);
      };
    }
    const pulse = () => [
      Animated.timing(value, {
        toValue: 1,
        duration: plan.pulseMs,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(value, {
        toValue: 0,
        duration: plan.pulseMs,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    ];
    const seq = Animated.sequence([...pulse(), ...pulse()]);
    seq.start();
    return () => {
      seq.stop();
      value.setValue(0);
    };
  }, [tick, reduceMotion, value]);

  return value;
}

/** How long a hold has to last. The Pearkit rows in the other two views use the same. */
const LONG_PRESS_MS = 500;

export type ShareRowStatus = {
  /** The state, one word or two: "Active", "Downloading 48%". Drawn in its colour, ahead of `meta`. */
  label: string;
  /**
   * Which theme token colours the state (the rule is Pearkit's, the same in every app):
   *  - "primary" → green: finished and available ("Active")
   *  - "warning" → amber: not finished yet ("Downloading 48%", "Waiting", "Paused")
   *  - "muted"   → grey: switched off ("Inactive")
   *  - "danger"  → red: needs the person
   */
  tone: "warning" | "primary" | "danger" | "muted";
  /** The progress bar under the line, for a share that is not finished. */
  bar?: ShareBar | null;
};

export type ShareRowProps = {
  /** Ionicons glyph shown when no thumbnail is available. */
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  /** Three-letter type badge drawn over the glyph, when the kind earns one. */
  iconBadge?: string | null;
  /** Local file path or URI to render as the tile thumbnail (images only). */
  previewUri?: string | null;
  /** Local video file URI. A one-frame thumbnail is generated on demand
   *  and cached module-wide, then swapped in place of the type-icon tile.
   *  Ignored when `previewUri` is already set. */
  videoUri?: string | null;
  name: string;
  /** Size and date ("38 KB · 2h ago"), in grey after the state, or alone when there is no state. */
  meta: string;
  status?: ShareRowStatus | null;
  isFavorite?: boolean;
  isPinned?: boolean;
  indicatorState: ActiveIndicatorState;
  isBundle?: boolean;
  dim?: boolean;
  onPress: () => void;
  /** Hold for about half a second. The list uses it to start choosing several. */
  onLongPress?: () => void;
  onKebabPress: () => void;
  /** Row divider at top. `false` on the first row of the list. */
  showTopDivider?: boolean;
  /**
   * Multi-select: the kebab goes, a checkbox appears on the left ahead of the
   * picture, and taps reach `onPress` as a toggle. The chevron stays for
   * bundles, which remain expandable.
   */
  selectionMode?: boolean;
  /** Only meaningful when `selectionMode` is true. */
  selected?: boolean;
  /**
   * Bumped by the list when this row has just become ready. The VALUE is the
   * trigger, not a boolean: a counter cannot be missed by a re-render and
   * cannot replay on one either.
   */
  highlightTick?: number;
};

/**
 * List row: thumbnail tile, name, color-coded status sub-line, optional
 * inline star and pin, and a kebab. Wrapped in SwipeableRow at the call site.
 */
export default function ShareRow({
  iconName,
  iconBadge,
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
  onLongPress,
  onKebabPress,
  showTopDivider = true,
  selectionMode,
  selected,
  highlightTick = 0,
}: ShareRowProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const highlight = useReadyHighlight(highlightTick);
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
  const subText = status ? `${status.label} · ${meta}` : meta;
  const barColors = useMemo(
    () =>
      shareBarColorsFrom({
        busy: theme.warning,
        good: theme.primary,
        track: theme.border,
        stopped: theme.muted,
      }),
    [theme],
  );
  return (
    <Pressable
      style={[
        styles.row,
        showTopDivider && styles.rowDivider,
        dim && !selectionMode && styles.rowDim,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={LONG_PRESS_MS}
      accessibilityRole={selectionMode ? "checkbox" : "button"}
      accessibilityState={selectionMode ? { checked: !!selected } : undefined}
      accessibilityLabel={`${name}, ${subText}`}
    >
      {/* The tint is an OPACITY on an overlay, not an animated backgroundColor:
          colour is not a native-driver property and animating it would throw.
          Nothing here changes a layout value, so the row never moves. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.highlight,
          {
            // A light tint, never a wash: the accent at full strength would
            // make the row unreadable.
            opacity: highlight.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 0.12],
            }),
          },
        ]}
      />
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
      ) : null}
      <View style={styles.thumb}>
        {thumbUri ? (
          <Image
            source={{ uri: thumbUri }}
            style={styles.thumbImage}
            resizeMode="cover"
          />
        ) : isBundle ? (
          // One folder treatment everywhere: outline glyph in the brand
          // green on the same subtle-surface tile every folder surface uses.
          <Ionicons name="folder-outline" size={28} color={theme.primary} />
        ) : (
          <>
            <Ionicons name={iconName} size={28} color={theme.text} />
            <FileKindBadge text={iconBadge ?? null} size={28} color={theme.text} />
          </>
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
          {PINNING_ENABLED && isPinned ? (
            <Ionicons
              name="pin"
              size={15}
              color={theme.primary}
              style={styles.nameMark}
            />
          ) : null}
        </View>
        {/* The state in its own colour, then the size and date in grey: the colour says how the
            share is doing, and it is never the whole line that goes grey. */}
        <Text style={styles.sub} numberOfLines={1}>
          {status ? <Text style={{ color: subColor }}>{status.label}</Text> : null}
          {status ? ` · ${meta}` : meta}
        </Text>
        {status?.bar ? (
          <ShareProgressBar
            value={status.bar.value}
            look={status.bar.look}
            colors={barColors}
            style={styles.bar}
          />
        ) : null}
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
      {selectionMode ? null : (
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
    // Only a share that is switched off.
    rowDim: { opacity: 0.55 },
    // Behind the content, inside the row's own bounds. `accent` at a low
    // opacity is the light tint; the overlay itself never changes size.
    highlight: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.primary,
      opacity: 0,
    },
    // Narrower than the kebab it replaces, so the row's words move as little as they can.
    checkSlot: {
      width: 24,
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
      // Filled tile for non-image thumbs, so video, audio and documents read
      // as tiles with a glyph rather than thin outlined icons.
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
      color: theme.muted,
      fontSize: 13,
      marginTop: 2,
      fontWeight: "500",
    },
    bar: { marginTop: 6 },
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
