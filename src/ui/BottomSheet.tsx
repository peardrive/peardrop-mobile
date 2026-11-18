import React, { useMemo } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppModal as Modal } from "./AppModal";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useScreenInsets } from "./useScreenInsets";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { ToastOutlet } from "./Toast";

export type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Optional sheet title (shown at top-left, bold). */
  title?: string;
  /** Dismissing a sheet destroys nothing, so both branches draw a `muted` glyph and `theme.danger`
   *  stays reserved for genuinely destructive controls. */
  filledClose?: boolean;
  /** Show the drag handle at top of sheet. Default true. */
  showHandle?: boolean;
  /** Optional max height, e.g. `"88%"`. Default: no cap (natural). */
  maxHeight?: string | number;
  /** Inset from the screen edges so it reads as a floating card. Off by default: callers rely on full width. */
  sideInset?: boolean;
  children?: React.ReactNode;
};

/**
 * Base bottom sheet. Uses `theme.bg`, the only token guaranteed opaque across every theme —
 * many themes' `theme.card` is translucent and lets the UI underneath bleed in.
 */
export default function BottomSheet({
  visible,
  onClose,
  title,
  filledClose,
  showHandle = true,
  maxHeight,
  sideInset,
  children,
}: BottomSheetProps) {
  const { theme } = useAppTheme();
  const insets = useScreenInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
      <View style={styles.backdrop}>
        {/* The dimmed area that closes the window is a SIBLING of the card, never its parent: a
            pressable round the card makes it one element to VoiceOver and the test robot, and
            on iPhone stops a scroll area inside from scrolling. See ShareQrModal.tsx. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close sheet"
          accessibilityRole="button"
        />
        <View
          style={[
            styles.sheet,
            sideInset ? styles.sheetInset : null,
            maxHeight != null ? ({ maxHeight } as { maxHeight: number }) : null,
            { paddingBottom: insets.bottom + 16 },
          ]}
        >
          {showHandle ? <View style={styles.handle} /> : null}
          {title != null ? (
            <View style={styles.titleRow}>
              <Text style={styles.title}>{title}</Text>
              {filledClose ? (
                <Pressable
                  onPress={onClose}
                  style={styles.closeCircle}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={16} color={theme.muted} />
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
      </View>
      </KeyboardAvoidingView>
      {visible && <ToastOutlet />}
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // Full-screen scrim — tapping anywhere outside the sheet dismisses.
      backgroundColor: theme.scrim,
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
      backgroundColor: theme.tabBadgeBg,
    },
  });
}
