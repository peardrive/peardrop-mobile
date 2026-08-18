import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type DotPagerProps = {
  count: number;
  activeIndex: number;
};

/**
 * Themed dot pager for a paginated carousel. The active dot is a widened
 * pill in `theme.primary`; inactive dots are muted circles.
 */
export default function DotPager({ count, activeIndex }: DotPagerProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View
      style={styles.row}
      accessibilityRole="tablist"
      accessibilityLabel={`Page ${activeIndex + 1} of ${count}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={[styles.dot, i === activeIndex && styles.dotActive]}
        />
      ))}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.border,
    },
    dotActive: {
      width: 22,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.primary,
    },
  });
}
