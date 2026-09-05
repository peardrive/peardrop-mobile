import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

type Props = {
  children: React.ReactNode;
  onDelete: () => void;
  /** Label shown on the reveal button. Defaults to "Delete". */
  deleteLabel?: string;
  /** A11y label for the row itself; the action menu reuses it. */
  accessibilityLabel?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /**
   * Background color for the moving "front" surface. Must be opaque so the
   * red delete backer doesn't bleed through gaps in row content. Defaults
   * to `theme.bg` — the only AppTheme color guaranteed to be fully opaque
   * across all 10 themes. (`theme.card` is translucent — alpha
   * 0.05–0.08 — in 8 of 10 themes, which lets the row's red
   * `theme.danger` background bleed through at rest, so it must not be
   * used here.) Pass an explicit color when the row's parent has
   * a different backdrop and you want the front to match.
   */
  frontBackground?: string;
  /**
   * One-shot peek animation for the swipe-discoverability cue (Phase W.1).
   * When this transitions to true, the row slides ~30 px left over 400 ms,
   * holds 200 ms, then slides back over 400 ms — total ~1000 ms. Calls
   * `onPeekDone` when the sequence finishes so the parent can clear the
   * trigger and persist the "seen" flag. Subsequent transitions to true
   * after that are no-ops in the parent (the AsyncStorage flag prevents
   * re-firing). PanResponder is unaffected — peek snaps cleanly to 0
   * before any user gesture can race it.
   */
  peek?: boolean;
  onPeekDone?: () => void;
  /**
   * Imperative close-from-outside trigger. When this value changes (any
   * non-equal value vs. the previous render), the row snaps back to its
   * resting position. Used by parents that take a deliberate action after
   * `onDelete` fires (e.g. open a confirmation modal) and then need to
   * close the swipe regardless of whether the user confirmed or cancelled.
   * Pass `undefined` (or a stable value) to opt out.
   */
  closeSignal?: number | string | boolean;
};

const REVEAL_WIDTH = 96;
const REVEAL_THRESHOLD = -REVEAL_WIDTH * 0.4;
const COMMIT_THRESHOLD = -REVEAL_WIDTH * 1.6;

/**
 * Swipe-to-delete row built on Animated + PanResponder so we don't drag in
 * react-native-gesture-handler / reanimated as new native deps. Behavior:
 *
 *  - Drag left to peek the delete affordance; release past 40% of REVEAL_WIDTH
 *    snaps it open, otherwise it springs back closed.
 *  - Drag past 1.6× REVEAL_WIDTH commits delete on release (long flick).
 *  - PanResponder only claims movement when horizontal motion dominates, so
 *    the parent FlatList keeps its vertical scroll.
 *  - accessibilityActions exposes a "delete" action for TalkBack users who
 *    can't gesture.
 */
export default function SwipeableRow({
  children,
  onDelete,
  deleteLabel = "Delete",
  accessibilityLabel,
  containerStyle,
  frontBackground,
  peek = false,
  onPeekDone,
  closeSignal,
}: Props) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const frontBg = frontBackground ?? theme.bg;
  const translateX = useRef(new Animated.Value(0)).current;
  const offsetRef = useRef(0);
  // Phase W.1: peek animation. Drives translateX through a one-shot
  // -30 → hold → 0 sequence. We track `running` so a re-render with
  // peek still true (e.g., parent re-renders before clearing) doesn't
  // re-trigger.
  const peekRunning = useRef(false);

  const commit = () => {
    Animated.timing(translateX, {
      toValue: -600,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      offsetRef.current = 0;
      translateX.setValue(0);
      onDelete();
    });
  };

  const snapTo = (target: number) => {
    offsetRef.current = target;
    Animated.spring(translateX, {
      toValue: target,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 12 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.4,
      onPanResponderGrant: () => {
        translateX.setOffset(offsetRef.current);
        translateX.setValue(0);
      },
      onPanResponderMove: (_, gs) => {
        // Cap so the combined translation never goes past the resting
        // position (0). From a revealed state (offset = -REVEAL_WIDTH),
        // the max allowed positive dx is +REVEAL_WIDTH, which lets the
        // user drag the row back to close — the piece the earlier
        // `Math.min(0, gs.dx)` implementation blocked.
        const maxDx = -offsetRef.current;
        const dx = Math.min(maxDx, gs.dx);
        translateX.setValue(dx);
      },
      onPanResponderRelease: (_, gs) => {
        translateX.flattenOffset();
        const maxDx = -offsetRef.current;
        const dx = Math.min(maxDx, gs.dx);
        const final = offsetRef.current + dx;
        if (final < COMMIT_THRESHOLD) {
          commit();
          return;
        }
        snapTo(final < REVEAL_THRESHOLD ? -REVEAL_WIDTH : 0);
      },
      onPanResponderTerminate: () => {
        translateX.flattenOffset();
        snapTo(0);
      },
    })
  ).current;

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "delete") commit();
  };

  // Force the row closed when the parent toggles closeSignal. The first
  // render with a defined signal is treated as the baseline (no-op).
  const lastCloseSignalRef = useRef<typeof closeSignal>(closeSignal);
  useEffect(() => {
    if (closeSignal === undefined) return;
    if (lastCloseSignalRef.current === closeSignal) return;
    lastCloseSignalRef.current = closeSignal;
    snapTo(0);
    // snapTo intentionally not in deps: it's a stable inline function
    // closure over the Animated.Value ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeSignal]);

  useEffect(() => {
    if (!peek || peekRunning.current) return;
    peekRunning.current = true;
    const seq = Animated.sequence([
      Animated.timing(translateX, {
        toValue: -30,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.delay(200),
      Animated.timing(translateX, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]);
    seq.start(({ finished }) => {
      peekRunning.current = false;
      // Make sure we land at exactly 0 in case the animation was interrupted.
      if (!finished) translateX.setValue(0);
      offsetRef.current = 0;
      onPeekDone?.();
    });
    return () => {
      seq.stop();
    };
  }, [peek, onPeekDone, translateX]);

  return (
    <View
      style={[styles.row, containerStyle]}
      accessibilityActions={[{ name: "delete", label: deleteLabel }]}
      onAccessibilityAction={onAccessibilityAction}
      {...(accessibilityLabel ? { accessibilityLabel } : null)}
    >
      <View style={styles.deleteBacker} pointerEvents="box-none">
        <Pressable
          onPress={commit}
          style={styles.deleteBtn}
          accessibilityRole="button"
          accessibilityLabel={deleteLabel}
        >
          <Text style={styles.deleteText}>{deleteLabel}</Text>
        </Pressable>
      </View>
      <Animated.View
        style={[styles.front, { backgroundColor: frontBg, transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      position: "relative",
      backgroundColor: theme.danger,
      overflow: "hidden",
    },
    front: {},
    deleteBacker: {
      position: "absolute",
      right: 0,
      top: 0,
      bottom: 0,
      width: REVEAL_WIDTH,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
    deleteBtn: {
      flex: 1,
      alignSelf: "stretch",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    deleteText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  });
}
