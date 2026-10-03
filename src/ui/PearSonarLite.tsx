// Looking indicator: rings pulse out from the pear. No native dependency.
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";

const RINGS = 3;
// Proportions of the 860-unit master artwork.
const PEAR_W = 296 / 860;
const PEAR_H = 574 / 860;
const PEAR_TOP = (294 - 218) / 860;
const RING_MIN = 82 / 429;
const pearPng = require("./pear.png");

type Props = {
  size?: number;
  color: string;
  label: string;
  period?: number;
  reduceMotion?: boolean;
};

function useReduceMotion(override?: boolean) {
  const [system, setSystem] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setSystem(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setSystem);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return override ?? system;
}

export default function PearSonarLite({ size = 120, color, label, period = 2700, reduceMotion }: Props) {
  const still = useReduceMotion(reduceMotion);
  const rings = useRef(Array.from({ length: RINGS }, () => new Animated.Value(0))).current;
  const beat = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (still) return;
    const ease = Easing.bezier(0.2, 0.6, 0.4, 1);
    // A loop of a single timing runs natively; a loop of a sequence restarts from JS each cycle.
    const ringLoops = rings.map((v, i) =>
      Animated.sequence([
        Animated.delay((period / RINGS) * i),
        Animated.loop(Animated.timing(v, { toValue: 1, duration: period, easing: ease, useNativeDriver: true })),
      ]),
    );
    const pulse = Animated.loop(
      Animated.timing(beat, { toValue: 1, duration: period, easing: Easing.linear, useNativeDriver: true }),
    );
    ringLoops.forEach((a) => a.start());
    pulse.start();
    return () => {
      ringLoops.forEach((a) => a.stop());
      pulse.stop();
      rings.forEach((v) => v.setValue(0));
      beat.setValue(0);
    };
  }, [still, period, rings, beat]);

  const ringPx = size;
  const strokePx = Math.max(1.5, (16 / 860) * size);
  const pearStyle = {
    position: "absolute" as const,
    width: PEAR_W * size,
    height: PEAR_H * size,
    top: PEAR_TOP * size,
    left: (size - PEAR_W * size) / 2,
    tintColor: color,
  };

  return (
    <View
      accessible
      accessibilityRole={still ? "image" : "progressbar"}
      accessibilityLabel={label}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {still ? (
        <View
          style={[
            styles.ring,
            { width: ringPx * 0.7, height: ringPx * 0.7, borderRadius: ringPx, borderWidth: strokePx, borderColor: color, opacity: 0.55 },
          ]}
        />
      ) : (
        rings.map((v, i) => (
          <Animated.View
            key={i}
            style={[
              styles.ring,
              {
                width: ringPx,
                height: ringPx,
                borderRadius: ringPx / 2,
                borderWidth: strokePx,
                borderColor: color,
                opacity: v.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.9, 0] }),
                transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [RING_MIN, 1] }) }],
              },
            ]}
          />
        ))
      )}
      <Animated.Image
        source={pearPng}
        resizeMode="contain"
        style={[
          pearStyle,
          still
            ? null
            : { transform: [{ scale: beat.interpolate({ inputRange: [0, 0.08, 0.2, 1], outputRange: [1, 1.07, 1, 1] }) }] },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute", alignSelf: "center" },
});
