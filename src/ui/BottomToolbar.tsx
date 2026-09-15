import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type BottomToolbarProps = {
  onSend: () => void;
  onReceive: () => void;
  onSettings: () => void;
};

/**
 * v5 floating bottom toolbar: three circular icon-only buttons sitting on
 * a lighter parent panel (`theme.card` fill + border), lifted off the
 * bottom edge so it reads as a floating bar rather than flush chrome.
 */
export default function BottomToolbar({
  onSend,
  onReceive,
  onSettings,
}: BottomToolbarProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View
      style={[
        styles.wrap,
        // Lift: safe-area bottom + a generous extra 20 so the panel sits
        // above the home-indicator zone instead of hugging it.
        { paddingBottom: insets.bottom + 20 },
      ]}
      pointerEvents="box-none"
    >
      <View style={styles.panel}>
        <CircleBtn theme={theme} icon="arrow-up" label="Send" onPress={onSend} />
        <CircleBtn theme={theme} icon="arrow-down" label="Receive" onPress={onReceive} />
        <CircleBtn theme={theme} icon="settings" label="Settings" onPress={onSettings} />
      </View>
    </View>
  );
}

function CircleBtn({
  theme,
  icon,
  label,
  onPress,
}: {
  theme: AppTheme;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: 60,
        height: 60,
        borderRadius: 30,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.surfaceSubtle,
        borderWidth: 2,
        borderColor: theme.primary,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={26} color={theme.primary} />
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    wrap: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      alignItems: "center",
    },
    panel: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 36,
      paddingHorizontal: 28,
      paddingVertical: 12,
      // Lighter parent to group the three buttons into a visual unit
      // (per design deck). theme.card is opaque in every theme so the
      // panel reads as a distinct floating card, not a translucent tint.
      backgroundColor: theme.card,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.border,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 14,
      elevation: 8,
    },
  });
}
