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
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { haptics } from "../lib/haptics";
import {
  REVEAL_WIDTH,
  SELECT_WIDTH,
  swipeRelease,
  swipeTravel,
  wantsSwipe,
} from "../lib/swipeRow";

type Props = {
  children: React.ReactNode;
  onDelete: () => void;
  /** Label shown on the reveal button. Defaults to "Delete". */
  deleteLabel?: string;
  /**
   * Given, a swipe to the right selects the row: it travels a short way over a tick and, let go
   * past the mark, calls this. Left out, the row does not move right at all.
   */
  onSelect?: () => void;
  /** What a screen reader calls the select action. Defaults to "Select". */
  selectLabel?: string;
  /**
   * True from the moment the row takes the finger until it lets go. The list must stop scrolling
   * for that time (`setNativeProps({ scrollEnabled: false })`): on iPhone a row holding the finger
   * does not stop the list taking it back, and the list does so as soon as the finger has drifted
   * a few points up or down, which every thumb swipe does. The row then snapped shut mid-swipe.
   */
  onSwipeActive?: (active: boolean) => void;
  /** A11y label for the row itself; the action menu reuses it. */
  accessibilityLabel?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /**
   * Must be opaque or the red delete backer bleeds through gaps in the row. Defaults to `theme.bg`,
   * the only colour guaranteed opaque in every theme; `theme.card` is translucent in most.
   */
  frontBackground?: string;
  /**
   * One-shot peek cueing that the row can be swiped. The pan responder is unaffected: peek snaps
   * to 0 before any user gesture can race it.
   */
  peek?: boolean;
  onPeekDone?: () => void;
  /** Any change of value snaps the row back to rest, for parents that open a confirmation after
   *  `onDelete`. Pass `undefined` or a stable value to opt out. */
  closeSignal?: number | string | boolean;
};

/**
 * Swipe left for Delete, right to select, on Animated and PanResponder, to avoid a native gesture
 * dependency. The rules (when a finger counts as swiping, how far the row goes, what letting go
 * means) are in `src/lib/swipeRow.ts`, where jest can reach them.
 */
export default function SwipeableRow({
  children,
  onDelete,
  deleteLabel = "Delete",
  onSelect,
  selectLabel = "Select",
  onSwipeActive,
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
  // The pan responder is made once, so it reads what the row was last given from here rather
  // than from the first render's props.
  const latest = useRef({ onDelete, onSelect, onSwipeActive });
  latest.current = { onDelete, onSelect, onSwipeActive };

  const commit = () => {
    Animated.timing(translateX, {
      toValue: -600,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      offsetRef.current = 0;
      translateX.setValue(0);
      latest.current.onDelete();
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
      onMoveShouldSetPanResponder: (_, gs) => wantsSwipe(gs.dx, gs.dy),
      // Once the row has the finger nothing else in the app may ask for it back.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        latest.current.onSwipeActive?.(true);
        translateX.setOffset(offsetRef.current);
        translateX.setValue(0);
      },
      onPanResponderMove: (_, gs) => {
        translateX.setValue(swipeTravel(offsetRef.current, gs.dx, !!latest.current.onSelect));
      },
      onPanResponderRelease: (_, gs) => {
        latest.current.onSwipeActive?.(false);
        translateX.flattenOffset();
        const outcome = swipeRelease(offsetRef.current, gs.dx, !!latest.current.onSelect);
        if (outcome === "delete") {
          commit();
          return;
        }
        if (outcome === "select") {
          haptics.selection();
          latest.current.onSelect?.();
        }
        snapTo(outcome === "reveal" ? -REVEAL_WIDTH : 0);
      },
      onPanResponderTerminate: () => {
        latest.current.onSwipeActive?.(false);
        translateX.flattenOffset();
        snapTo(0);
      },
    })
  ).current;

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "delete") commit();
    if (e.nativeEvent.actionName === "select") latest.current.onSelect?.();
  };

  // Force the row closed when the parent toggles closeSignal. The first
  // render with a defined signal is treated as the baseline (no-op).
  const lastCloseSignalRef = useRef<typeof closeSignal>(closeSignal);
  useEffect(() => {
    if (closeSignal === undefined) return;
    if (lastCloseSignalRef.current === closeSignal) return;
    lastCloseSignalRef.current = closeSignal;
    snapTo(0);
    // snapTo is a stable inline closure over the Animated.Value ref, so it is not in deps.
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

  // The row sits on red, for Delete. The moment it moves right instead, this covers the red with
  // the select colour; at rest and to the left it is not there at all.
  const selectShown = useMemo(
    () => translateX.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    [translateX],
  );

  return (
    <View
      style={[styles.row, containerStyle]}
      accessibilityActions={[
        { name: "delete", label: deleteLabel },
        ...(onSelect ? [{ name: "select", label: selectLabel }] : []),
      ]}
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
      {onSelect ? (
        <Animated.View
          style={[styles.selectBacker, { opacity: selectShown }]}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={styles.selectMark}>
            <Ionicons name="checkbox" size={26} color={theme.onPrimary} />
          </View>
        </Animated.View>
      ) : null}
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
    selectBacker: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.primary,
      justifyContent: "center",
    },
    selectMark: {
      width: SELECT_WIDTH,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
