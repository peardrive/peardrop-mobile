import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";

/**
 * PingLogo — the PearDrop logo with the radio-ping animation, drawn natively.
 *
 * Same geometry and timing as `_assets/peardrop/official/peardrop-ping.html`
 * (preset "quick"): the pear pops with an overshoot and glows, a wave of light
 * runs out through the three arcs, each arc breathes outward as it lights, and
 * a faint echo ring leaves the outer arc. Pings stack: every tap starts another
 * one on its own slot and the lights add up.
 *
 * The arcs are SVG paths measured off the official icon (they are slightly
 * elliptical, with round caps); the pear is the icon's own pear as a PNG.
 * At rest the logo matches the icon. Everything animated runs on the native
 * driver (opacity, scale), so a dozen stacked pings leave the JS thread alone.
 *
 * @example <PingLogo size={168} auto />
 */
export type PingLogoProps = {
  /** Width and height in dp. */
  size: number;
  /** Fire a ping every `period` ms on its own (loading screens). */
  auto?: boolean;
  /** Tap to ping. Default true. */
  interactive?: boolean;
  /** Set on light backgrounds: the unlit arcs switch to greens that read on a pale surface. */
  onLight?: boolean;
  /** How many pings can overlap. Default 6. */
  slots?: number;
  style?: StyleProp<ViewStyle>;
};


const DESIGN = 1250; // design space of the icon, in px
const ARCS = [
  { d: "M444.9 772.1 A248.51 255.74 0 1 1 805.4 772.1", color: "#abd142", width: 52.6, cx: 625.15, cy: 596.02, rMid: 252.1, at: 83 },
  { d: "M380.5 860.8 A358.42 366.64 0 1 1 871.2 860.1", color: "#58ae48", width: 52.8, cx: 625.53, cy: 593.2, rMid: 362.5, at: 237 },
  { d: "M308.4 947.5 A470.73 480.85 0 1 1 942.7 947.5", color: "#1e4f33", width: 53.0, cx: 625.56, cy: 592.18, rMid: 475.8, at: 394 },
] as const;
const OUTER = ARCS[2];
const PEAR = { x: 423, y: 501, w: 399, h: 635 };
const GLOW_PAD = 120; // pear-glow.png is the pear padded by this much on every side
const PIVOT = { x: 622, y: 870 }; // the pear scales about this point
/** Colours per background. Dark is the icon itself; light swaps the arcs for greens that hold up on a pale surface. */
const PALETTE = {
  dark: { arcs: ["#abd142", "#58ae48", "#1e4f33"], hot: "#d6ff6e", glow: "#b6ff3c" },
  light: { arcs: ["#a8cf3a", "#75bf52", "#4d7c0f"], hot: "#c6f23a", glow: "#9ee81c" },
} as const;
const T = {
  period: 1500,
  popAmp: 0.08,
  popRise: 170,
  popFall: 550,
  arcRise: 90,
  arcFall: 600,
  ghost: 700,
  breathe: 11, // px (design) each arc moves outward when fully lit
  first: 150,
};
const PEAR_SRC = require("../../assets/images/ping/pear.png");
const PEAR_LIT_SRC = require("../../assets/images/ping/pear-lit.png");
const PEAR_GLOW_SRC = require("../../assets/images/ping/pear-glow.png");

type Slot = { pop: Animated.Value; lit: Animated.Value[]; ghost: Animated.Value; running?: Animated.CompositeAnimation };

const sum = (vals: Animated.Value[]): Animated.AnimatedAddition<number> =>
  vals.slice(1).reduce((acc, v) => Animated.add(acc, v), Animated.add(vals[0]!, 0));

export default function PingLogo({ size, auto = false, interactive = true, onLight = false, slots: slotCount = 6, style }: PingLogoProps) {
  const k = size / DESIGN;
  const { arcs: arcColors, hot: HOT, glow: GLOW } = PALETTE[onLight ? "light" : "dark"];
  const [reduceMotion, setReduceMotion] = useState(false);
  const next = useRef(0);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => mounted && setReduceMotion(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => mounted && setReduceMotion(v));
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const slots = useMemo<Slot[]>(
    () =>
      Array.from({ length: slotCount }, () => ({
        pop: new Animated.Value(0),
        lit: ARCS.map(() => new Animated.Value(0)),
        ghost: new Animated.Value(0),
      })),
    [slotCount],
  );

  const ping = useCallback(() => {
    const s = slots[next.current % slots.length]!;
    next.current += 1;
    s.running?.stop();
    s.pop.setValue(0);
    s.ghost.setValue(0);
    s.lit.forEach((v) => v.setValue(0));
    const native = { useNativeDriver: true } as const;
    s.running = Animated.parallel([
      Animated.sequence([
        Animated.timing(s.pop, { toValue: 1, duration: T.popRise, easing: Easing.out(Easing.back(1.7)), ...native }),
        Animated.timing(s.pop, { toValue: 0, duration: T.popFall, easing: Easing.inOut(Easing.cubic), ...native }),
      ]),
      ...ARCS.map((a, i) =>
        Animated.sequence([
          Animated.delay(Math.max(0, a.at - T.arcRise)),
          Animated.timing(s.lit[i]!, { toValue: 1, duration: T.arcRise, easing: Easing.out(Easing.quad), ...native }),
          Animated.timing(s.lit[i]!, { toValue: 0, duration: T.arcFall, easing: Easing.out(Easing.exp), ...native }),
        ]),
      ),
      Animated.sequence([
        Animated.delay(OUTER.at),
        Animated.timing(s.ghost, { toValue: 1, duration: T.ghost, easing: Easing.out(Easing.cubic), ...native }),
      ]),
    ]);
    s.running.start();
  }, [slots]);

  useEffect(() => {
    if (!auto || reduceMotion) return;
    const first = setTimeout(ping, T.first);
    const every = setInterval(ping, T.period);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [auto, reduceMotion, ping]);

  useEffect(() => () => slots.forEach((s) => s.running?.stop()), [slots]);

  // Derived values (all native-driver nodes): stacked pops drive the pear, stacked lights drive each arc.
  const popSum = useMemo(() => sum(slots.map((s) => s.pop)), [slots]);
  const pearScale = useMemo(
    () => popSum.interpolate({ inputRange: [0, 2.2, 100], outputRange: [1, 1 + T.popAmp * 2.2, 1 + T.popAmp * 2.2] }),
    [popSum],
  );
  const glowOpacity = useMemo(() => popSum.interpolate({ inputRange: [0, 1, 100], outputRange: [0, 0.85, 0.85] }), [popSum]);
  const litOpacity = useMemo(() => popSum.interpolate({ inputRange: [0, 1, 100], outputRange: [0, 0.5, 0.5] }), [popSum]);
  const arcScale = useMemo(
    () =>
      ARCS.map((a, i) =>
        sum(slots.map((s) => s.lit[i]!)).interpolate({
          inputRange: [0, 1, 100],
          outputRange: [1, 1 + T.breathe / a.rMid, 1 + T.breathe / a.rMid],
        }),
      ),
    [slots],
  );

  const box = { width: size, height: size };
  const svgProps = { width: size, height: size, viewBox: `0 0 ${DESIGN} ${DESIGN}` } as const;

  return (
    <Pressable
      onPressIn={interactive && !reduceMotion ? ping : undefined}
      disabled={!interactive || reduceMotion}
      accessibilityRole="image"
      accessibilityLabel="PearDrop"
      style={[box, styles.box, style]}
    >
      {/* Echo rings, one per slot, behind everything */}
      {slots.map((s, si) => (
        <Animated.View
          key={`ghost-${si}`}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              transformOrigin: [OUTER.cx * k, OUTER.cy * k, 0],
              opacity: s.ghost.interpolate({ inputRange: [0, 0.02, 1], outputRange: [0, 0.32, 0] }),
              transform: [{ scale: s.ghost.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + 170 / OUTER.rMid] }) }],
            },
          ]}
        >
          <Svg {...svgProps}>
            <Path d={OUTER.d} stroke={GLOW} strokeWidth={12} strokeLinecap="round" fill="none" />
          </Svg>
        </Animated.View>
      ))}

      {/* Arcs: base colour, with one hot layer per slot fading in over it */}
      {ARCS.map((a, i) => (
        <Animated.View
          key={a.color}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { transformOrigin: [a.cx * k, a.cy * k, 0], transform: [{ scale: arcScale[i]! }] },
          ]}
        >
          <Svg {...svgProps}>
            <Path d={a.d} stroke={arcColors[i] ?? a.color} strokeWidth={a.width} strokeLinecap="round" fill="none" />
          </Svg>
          {slots.map((s, si) => (
            <Animated.View key={`hot-${si}`} style={[StyleSheet.absoluteFill, { opacity: s.lit[i]! }]}>
              <Svg {...svgProps}>
                <Path d={a.d} stroke={GLOW} strokeWidth={a.width + 40} strokeOpacity={0.22} strokeLinecap="round" fill="none" />
                <Path d={a.d} stroke={GLOW} strokeWidth={a.width + 14} strokeOpacity={0.3} strokeLinecap="round" fill="none" />
                <Path d={a.d} stroke={HOT} strokeWidth={a.width * 1.05} strokeOpacity={0.85} strokeLinecap="round" fill="none" />
              </Svg>
            </Animated.View>
          ))}
        </Animated.View>
      ))}

      {/* Pear: glow behind, the pear, and a lit copy fading in on top */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: PEAR.x * k,
          top: PEAR.y * k,
          width: PEAR.w * k,
          height: PEAR.h * k,
          transformOrigin: [(PIVOT.x - PEAR.x) * k, (PIVOT.y - PEAR.y) * k, 0],
          transform: [{ scale: pearScale }],
        }}
      >
        <Animated.Image
          source={PEAR_GLOW_SRC}
          resizeMode="stretch"
          style={{
            position: "absolute",
            left: -GLOW_PAD * k,
            top: -GLOW_PAD * k,
            width: (PEAR.w + 2 * GLOW_PAD) * k,
            height: (PEAR.h + 2 * GLOW_PAD) * k,
            opacity: glowOpacity,
          }}
        />
        <Animated.Image source={PEAR_SRC} resizeMode="stretch" style={{ width: PEAR.w * k, height: PEAR.h * k }} />
        <Animated.Image
          source={PEAR_LIT_SRC}
          resizeMode="stretch"
          style={[StyleSheet.absoluteFill, { width: PEAR.w * k, height: PEAR.h * k, opacity: litOpacity }]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { overflow: "visible" },
});
