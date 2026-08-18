import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type TopTabId<Value extends string = string> = {
  value: Value;
  label: string;
  accessibilityLabel?: string;
};

export type TopTabsProps<Value extends string> = {
  /** Exactly two tabs. First is the "left" segment, second is the "right". */
  tabs: TopTabId<Value>[];
  value: Value;
  onChange: (next: Value) => void;
};

const HEIGHT = 44;
const INSET = 4;
const OUTER_R = 14;
const INNER_R = 10;
// Seam geometry: the shared edge is mostly a straight vertical line at
// horizontal center, but ends in a small quarter-arc hook at the top and
// another at the bottom that point in opposite directions.
//   • Top hook: starts `HOOK_W` left of center and curls down-right,
//     landing on the vertical middle at `HOOK_H` below the top edge.
//     Favorites' top-left corner tucks under the hook, curving into Files.
//   • Bottom hook: starts on the vertical middle at `HOOK_H` above the
//     bottom edge and curls down-right, landing `HOOK_W` right of center.
//     Files' bottom-right corner rides the hook, curving into Favorites.
const HOOK_W = 8;
const HOOK_H = 12;
const DURATION = 250;

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedText = Animated.createAnimatedComponent(Text);

/**
 * Segmented Files / Favorites tabs with an interlocking S-curve seam.
 *
 * The shared edge is a mostly-vertical line at horizontal center with a
 * small quarter-arc hook at each end. The top hook curls down and to the
 * right, so Favorites' top-left tucks under it and reads as flowing into
 * Files. The bottom hook curls the opposite way — down and to the right at
 * the other end — so Files' bottom-right rides over it into Favorites.
 * The two shapes interlock like a puzzle instead of meeting at a straight
 * vertical divider.
 *
 * The seam geometry is stable; only which region is elevated changes. On
 * selection we crossfade the two region fills, so the curved seam is
 * preserved throughout the transition and the highlight visually flows
 * from one side to the other in ~250ms.
 *
 * All colors resolve from the active theme (`surfaceSubtle` track, `card`
 * elevation, `text`/`muted` labels) so the control adapts to every app
 * theme with no hardcoded values.
 */
export default function TopTabs<Value extends string>({
  tabs,
  value,
  onChange,
}: TopTabsProps<Value>) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.value === value),
  );
  const target = activeIndex === 0 ? 0 : 1;

  const [width, setWidth] = useState(0);
  const anim = useRef(new Animated.Value(target)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: target,
      duration: DURATION,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      useNativeDriver: false,
    }).start();
  }, [anim, target]);

  const leftOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });
  const rightOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };

  const leftPath = width > 0 ? buildLeftPath(width) : "";
  const rightPath = width > 0 ? buildRightPath(width) : "";

  return (
    <View style={styles.wrap} onLayout={onLayout} accessibilityRole="tablist">
      {width > 0 ? (
        <Svg
          width={width}
          height={HEIGHT}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <Rect
            x={0.5}
            y={0.5}
            width={width - 1}
            height={HEIGHT - 1}
            rx={OUTER_R}
            ry={OUTER_R}
            fill={theme.surfaceSubtle}
            stroke={theme.border}
            strokeWidth={1}
          />
          <AnimatedPath
            d={leftPath}
            fill={theme.card}
            opacity={leftOpacity}
          />
          <AnimatedPath
            d={rightPath}
            fill={theme.card}
            opacity={rightOpacity}
          />
        </Svg>
      ) : null}

      <View style={styles.row}>
        {tabs.map((tab, index) => {
          const selected = tab.value === value;
          const color = anim.interpolate({
            inputRange: [0, 1],
            outputRange:
              index === 0
                ? [theme.text, theme.muted]
                : [theme.muted, theme.text],
          });
          return (
            <Pressable
              key={tab.value}
              style={styles.tab}
              onPress={() => onChange(tab.value)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={tab.accessibilityLabel ?? tab.label}
            >
              <AnimatedText
                style={[
                  styles.label,
                  selected && styles.labelActive,
                  { color },
                ]}
                numberOfLines={1}
              >
                {tab.label}
              </AnimatedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Left region (Files side). Outer three edges track the container's rounded
 * corners; the right edge is the seam — top hook, vertical middle, bottom
 * hook. Each hook is a single quadratic bezier whose control point sits at
 * the "elbow" so tangents leave/enter horizontally at the container edge
 * and vertically at the vertical middle.
 */
function buildLeftPath(width: number): string {
  const left = INSET;
  const top = INSET;
  const bottom = HEIGHT - INSET;
  const halfW = width / 2;
  const r = INNER_R;

  return [
    `M ${left + r},${top}`,
    `L ${halfW - HOOK_W},${top}`,
    `Q ${halfW},${top} ${halfW},${top + HOOK_H}`,
    `L ${halfW},${bottom - HOOK_H}`,
    `Q ${halfW},${bottom} ${halfW + HOOK_W},${bottom}`,
    `L ${left + r},${bottom}`,
    `Q ${left},${bottom} ${left},${bottom - r}`,
    `L ${left},${top + r}`,
    `Q ${left},${top} ${left + r},${top}`,
    "Z",
  ].join(" ");
}

/** Right region (Favorites side). Mirrors `buildLeftPath` across the seam. */
function buildRightPath(width: number): string {
  const right = width - INSET;
  const top = INSET;
  const bottom = HEIGHT - INSET;
  const halfW = width / 2;
  const r = INNER_R;

  return [
    `M ${halfW - HOOK_W},${top}`,
    `L ${right - r},${top}`,
    `Q ${right},${top} ${right},${top + r}`,
    `L ${right},${bottom - r}`,
    `Q ${right},${bottom} ${right - r},${bottom}`,
    `L ${halfW + HOOK_W},${bottom}`,
    `Q ${halfW},${bottom} ${halfW},${bottom - HOOK_H}`,
    `L ${halfW},${top + HOOK_H}`,
    `Q ${halfW},${top} ${halfW - HOOK_W},${top}`,
    "Z",
  ].join(" ");
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrap: {
      height: HEIGHT,
      marginHorizontal: theme.pad,
      marginVertical: 8,
      position: "relative",
    },
    row: {
      flexDirection: "row",
      height: HEIGHT,
    },
    tab: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    label: {
      fontSize: 14,
      fontWeight: "500",
    },
    labelActive: {
      fontWeight: "600",
    },
  });
}
