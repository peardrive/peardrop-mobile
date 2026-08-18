import React, { useMemo } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Optional sheet title (shown at top-left, bold). */
  title?: string;
  /**
   * Shows a red circle-X close button top-right when true (matches design).
   * Defaults to a subtle muted close.
   */
  dangerClose?: boolean;
  /** Show the drag handle at top of sheet. Default true. */
  showHandle?: boolean;
  /** Optional max height, e.g. `"88%"`. Default: no cap (natural). */
  maxHeight?: string | number;
  /**
   * Inset the sheet from the screen's left/right edges so it reads as a
   * floating card rather than edge-to-edge. Also bumps the top corner
   * radius. Off by default to preserve full-width behavior for existing
   * callers.
   */
  sideInset?: boolean;
  children?: React.ReactNode;
};

/**
 * Base bottom-sheet component: full-screen scrim (tap to dismiss) + safe-
 * area-inset sheet container + optional grab handle + optional title bar
 * with close button.
 *
 * Uses `theme.bg` for the sheet background — the only token that is
 * guaranteed opaque across every theme (many themes' `theme.card` is a
 * translucent rgba, which would let the underlying UI bleed through the
 * sheet body — the exact bug that surfaced in Send/Receive/Kebab on
 * v5.)
 */
export default function BottomSheet({
  visible,
  onClose,
  title,
  dangerClose,
  showHandle = true,
  maxHeight,
  sideInset,
  children,
}: BottomSheetProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close sheet"
      >
        <View
          style={[
            styles.sheet,
            sideInset ? styles.sheetInset : null,
            maxHeight != null ? ({ maxHeight } as { maxHeight: number }) : null,
            { paddingBottom: insets.bottom + 16 },
          ]}
          onStartShouldSetResponder={() => true}
        >
          {showHandle ? <View style={styles.handle} /> : null}
          {title != null ? (
            <View style={styles.titleRow}>
              <Text style={styles.title}>{title}</Text>
              {dangerClose ? (
                <Pressable
                  onPress={onClose}
                  style={styles.closeCircle}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={16} color={theme.onPrimary} />
                </Pressable>
              ) : (
                <Pressable
                  onPress={onClose}
                  style={styles.closeMuted}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={22} color={theme.muted} />
                </Pressable>
              )}
            </View>
          ) : null}
          {children}
        </View>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // Full-screen scrim — tapping anywhere outside the sheet dismisses.
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    sheet: {
      // theme.bg is guaranteed opaque; theme.card is translucent in every
      // dark theme and would let the toolbar / list bleed through.
      backgroundColor: theme.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderTopWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: theme.pad,
      paddingTop: 8,
    },
    sheetInset: {
      marginHorizontal: 12,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderLeftWidth: 1,
      borderRightWidth: 1,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.border,
      marginBottom: 12,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 16,
    },
    title: { color: theme.text, fontWeight: "700", fontSize: 20 },
    closeMuted: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    closeCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
  });
}
