import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
} from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import PingLogo from "./PingLogo";
import { LIGHT_THEME_IDS, type AppTheme } from "./themes";

export type SplashScreenProps = {
  /** Called once the intro finishes (or immediately if reduce-motion). */
  onFinish: () => void;
};

const LOGO_SIZE = 168;
/** When the wordmark starts fading in: the first ping has popped and reached the inner arc. */
const WORDMARK_AT_MS = 450;
const WORDMARK_FADE_MS = 300;
const HOLD_MS = 1050;

/**
 * Two-beat splash: the logo pings (and keeps pinging; tap it for more), then
 * the wordmark fades in under it. Reduce-motion collapses it to an instant reveal.
 */
export default function SplashScreen({ onFinish }: SplashScreenProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
    wordmark.setValue(0);
    const fadeIn = setTimeout(() => {
      Animated.timing(wordmark, {
        toValue: 1,
        duration: WORDMARK_FADE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }, WORDMARK_AT_MS);
    const done = setTimeout(onFinish, WORDMARK_AT_MS + WORDMARK_FADE_MS + HOLD_MS);
    return () => {
      clearTimeout(fadeIn);
      clearTimeout(done);
    };
  }, [reduceMotion, wordmark, onFinish]);

  return (
    <View style={styles.root} accessibilityRole="none">
      <PingLogo size={LOGO_SIZE} auto onLight={LIGHT_THEME_IDS.includes(theme.id)} />
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
    wordmark: {
      color: theme.text,
      fontSize: 32,
      fontWeight: "800",
      letterSpacing: 0.5,
    },
  });
}
