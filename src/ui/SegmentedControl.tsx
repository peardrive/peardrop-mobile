import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type SegmentedOption<Value extends string> = {
  value: Value;
  label: string;
  /** Optional accessibility label if `label` isn't descriptive enough. */
  accessibilityLabel?: string;
};

export type SegmentedControlProps<Value extends string> = {
  options: SegmentedOption<Value>[];
  value: Value;
  onChange: (next: Value) => void;
};

/**
 * Data-driven pill-track segmented control. Track/thumb reuse
 * `surfaceSubtle` and `cardStrong` from the theme (no new tokens) so it
 * survives all 11 themes automatically.
 */
export default function SegmentedControl<Value extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<Value>) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.segment, selected && styles.segmentActive]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.accessibilityLabel ?? opt.label}
          >
            <Text
              style={[styles.label, selected && styles.labelActive]}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    track: {
      flexDirection: "row",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      padding: 2,
      gap: 2,
    },
    segment: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 8,
      borderRadius: 8,
    },
    segmentActive: {
      backgroundColor: theme.cardStrong,
    },
    label: {
      color: theme.muted,
      fontWeight: "600",
      fontSize: 13,
    },
    labelActive: {
      color: theme.text,
    },
  });
}
