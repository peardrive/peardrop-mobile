import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
} from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type ActiveIndicatorState =
  | "inactive"
  | "active-idle"
  | "active-broadcasting";

export type ActiveIndicatorProps = {
  state: ActiveIndicatorState;
  /** Diameter of the center dot in px. Rings scale outward from this. */
  size?: number;
};

const DOT_SIZE_DEFAULT = 9;
const RING_PEAK_SCALE = 2.8;
const CYCLE_MS = 2000;

/**
 * Tiered status overlay anchored to a file icon's corner.
 *
 *  - inactive             → renders nothing
 *  - active-idle          → static green dot
 *  - active-broadcasting  → static green dot + two concentric rings pulsing
 *                            outward (phase-offset by half a cycle so the
 *                            visual wave is continuous)
 *
 * Honors the OS reduce-motion setting — in that case `active-broadcasting`
 * collapses to the same visual as `active-idle` (no rings).
 *
 * Animation: native-driver `transform: scale` + `opacity` only, so the JS
 * thread stays clear even with many rows active at once.
 */
export default function ActiveIndicator({
  state,
  size = DOT_SIZE_DEFAULT,
}: ActiveIndicatorProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme, size), [theme, size]);

  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduceMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (v) => {
        if (mounted) setReduceMotion(v);
      },
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const broadcasting = state === "active-broadcasting" && !reduceMotion;

  useEffect(() => {
    if (!broadcasting) {
      ring1.setValue(0);
      ring2.setValue(0);
      return;
    }
    // Phase-offset the two rings so one is always visible while the other
    // resets. The delay on ring2 is one-shot (only the first cycle); after
    // that, Animated.loop keeps both in lockstep against their own period
    // but they remain offset because the first cycle established that.
    const makeRing = (val: Animated.Value): Animated.CompositeAnimation =>
      Animated.loop(
        Animated.timing(val, {
          toValue: 1,
          duration: CYCLE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      );
    ring1.setValue(0);
    ring2.setValue(0);
    const a1 = makeRing(ring1);
    const a2 = makeRing(ring2);
    a1.start();
    // Offset the second ring's start so the pulses interleave.
    const t = setTimeout(() => a2.start(), CYCLE_MS / 2);
    return () => {
      clearTimeout(t);
      a1.stop();
      a2.stop();
      ring1.setValue(0);
      ring2.setValue(0);
    };
  }, [broadcasting, ring1, ring2]);

  if (state === "inactive") return null;

  const ringStyle = (val: Animated.Value) => ({
    opacity: val.interpolate({
      inputRange: [0, 1],
      outputRange: [0.6, 0],
    }),
    transform: [
      {
        scale: val.interpolate({
          inputRange: [0, 1],
          outputRange: [1, RING_PEAK_SCALE],
        }),
      },
    ],
  });

  return (
    <View style={styles.wrap} pointerEvents="none" accessibilityElementsHidden>
      {broadcasting ? (
        <>
          <Animated.View style={[styles.ring, ringStyle(ring1)]} />
          <Animated.View style={[styles.ring, ringStyle(ring2)]} />
        </>
      ) : null}
      <View style={styles.dot} />
    </View>
  );
}

function createStyles(theme: AppTheme, size: number) {
  const radius = size / 2;
  return StyleSheet.create({
    // Absolute-positioned overlay parented to the row's iconWrap. The wrap
    // itself is point-sized — only the dot + rings draw inside it.
    wrap: {
      position: "absolute",
      bottom: -2,
      right: -2,
      width: size,
      height: size,
      alignItems: "center",
      justifyContent: "center",
    },
    dot: {
      width: size,
      height: size,
      borderRadius: radius,
      backgroundColor: theme.primary,
      // Theme-surface ring separates the dot from a similarly-colored
      // pixel in the icon underneath.
      borderWidth: 1,
      borderColor: theme.bg,
    },
    ring: {
      position: "absolute",
      width: size,
      height: size,
      borderRadius: radius,
      backgroundColor: theme.primary,
    },
  });
}
