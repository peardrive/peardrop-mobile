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

export type SplashScreenProps = {
  /** Called once the two-beat intro finishes (or immediately if reduce-motion). */
  onFinish: () => void;
};

const PULSE_MS = 900;
const WORDMARK_FADE_MS = 300;
const HOLD_MS = 600;
const DOT_SIZE = 40;
const RING_PEAK_SCALE = 3.2;

/**
 * Two-beat splash: pear-pulse (borrows the ActiveIndicator motion language —
 * ring scale + opacity on the native driver), then the wordmark fades in.
 * Total ~1.8s. Reduce-motion collapses the whole thing to an instant reveal.
 */
export default function SplashScreen({ onFinish }: SplashScreenProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const wordmark = useRef(new Animated.Value(0)).current;
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

  useEffect(() => {
    if (reduceMotion) {
      wordmark.setValue(1);
      const t = setTimeout(onFinish, 400);
      return () => clearTimeout(t);
    }
    const makeRing = (val: Animated.Value): Animated.CompositeAnimation =>
      Animated.loop(
        Animated.timing(val, {
          toValue: 1,
          duration: PULSE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      );
    ring1.setValue(0);
    ring2.setValue(0);
    wordmark.setValue(0);
    const a1 = makeRing(ring1);
    const a2 = makeRing(ring2);
    a1.start();
    const startRing2 = setTimeout(() => a2.start(), PULSE_MS / 2);
    const fadeIn = setTimeout(() => {
      Animated.timing(wordmark, {
        toValue: 1,
        duration: WORDMARK_FADE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }, PULSE_MS);
    const done = setTimeout(onFinish, PULSE_MS + WORDMARK_FADE_MS + HOLD_MS);
    return () => {
      clearTimeout(startRing2);
      clearTimeout(fadeIn);
      clearTimeout(done);
      a1.stop();
      a2.stop();
    };
  }, [reduceMotion, ring1, ring2, wordmark, onFinish]);

  const ringStyle = (val: Animated.Value) => ({
    opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
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
    <View style={styles.root} accessibilityRole="none">
      <View style={styles.pulseWrap} pointerEvents="none">
        {!reduceMotion ? (
          <>
            <Animated.View style={[styles.ring, ringStyle(ring1)]} />
            <Animated.View style={[styles.ring, ringStyle(ring2)]} />
          </>
        ) : null}
        <View style={styles.dot} />
      </View>
      <Animated.Text
        style={[styles.wordmark, { opacity: wordmark }]}
        accessibilityRole="header"
      >
        PearDrop
      </Animated.Text>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.bg,
      gap: 28,
    },
    pulseWrap: {
      width: DOT_SIZE * RING_PEAK_SCALE,
      height: DOT_SIZE * RING_PEAK_SCALE,
      alignItems: "center",
      justifyContent: "center",
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      backgroundColor: theme.primary,
    },
    ring: {
      position: "absolute",
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      backgroundColor: theme.primary,
    },
    wordmark: {
      color: theme.text,
      fontSize: 32,
      fontWeight: "800",
      letterSpacing: 0.5,
    },
  });
}
