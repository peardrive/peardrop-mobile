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
   * Background color for the moving "front" surface. Must be opaque or the
   * red delete backer bleeds through gaps in the row content. Defaults to
   * `theme.bg`, the only color guaranteed opaque in every theme; `theme.card`
   * is translucent in most. Pass a color when the parent backdrop differs.
   */
  frontBackground?: string;
  /**
   * One-shot peek animation cueing that the row can be swiped. Calls
   * `onPeekDone` when the sequence finishes so the parent can clear the
   * trigger and persist the seen flag. The pan responder is unaffected:
   * peek snaps to 0 before any user gesture can race it.
   */
  peek?: boolean;
  onPeekDone?: () => void;
  /**
   * Close-from-outside trigger: any change of value snaps the row back to
   * rest. For parents that open a confirmation after `onDelete` and must
   * close the swipe whether the user confirms or cancels. Pass `undefined`
   * or a stable value to opt out.
   */
  closeSignal?: number | string | boolean;
};

const REVEAL_WIDTH = 96;
const REVEAL_THRESHOLD = -REVEAL_WIDTH * 0.4;
const COMMIT_THRESHOLD = -REVEAL_WIDTH * 1.6;

/**
 * Swipe-to-delete row built on Animated and PanResponder, to avoid adding a
 * gesture library as a native dependency. The responder claims movement only
 * when horizontal motion dominates, so the parent list keeps its vertical
 * scroll, and an accessibility action exposes delete to users who cannot
 * gesture.
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
  // Tracked so a re-render while `peek` is still true does not re-trigger
  // the one-shot sequence.
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
        // Cap so the combined translation never passes the resting position.
        // From a revealed state this still lets the user drag back to close.
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
      // Land at exactly 0 in case the animation was interrupted.
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
