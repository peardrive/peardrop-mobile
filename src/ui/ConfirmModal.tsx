import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type ConfirmModalProps = {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "destructive" paints the confirm button red; "primary" paints it brand. */
  tone?: "destructive" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Themed confirmation prompt. Replaces native `Alert.alert` so destructive
 * actions match the rest of the app's typography, theme colors, and modal
 * style instead of falling back to the OS chrome.
 */
export default function ConfirmModal({
  visible,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Keep",
  tone = "destructive",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const confirmStyle = tone === "destructive" ? styles.btnDestructive : styles.btnPrimary;
  const confirmTextStyle =
    tone === "destructive" ? styles.btnDestructiveText : styles.btnPrimaryText;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={styles.backdrop}
        onPress={onCancel}
        accessibilityLabel={`Dismiss ${title}`}
      >
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          {body ? <Text style={styles.body}>{body}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              style={[styles.btn, styles.btnCancel]}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
            >
              <Text style={styles.btnCancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, confirmStyle]}
              onPress={onConfirm}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
            >
              <Text style={confirmTextStyle}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 340,
      borderRadius: 16,
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 20,
      gap: 8,
    },
    title: {
      color: theme.text,
      fontSize: 17,
      fontWeight: "700",
    },
    body: {
      color: theme.muted,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 2,
    },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 12,
    },
    btn: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 10,
      minWidth: 90,
      alignItems: "center",
      justifyContent: "center",
    },
    btnCancel: {
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: "transparent",
    },
    btnCancelText: {
      color: theme.text,
      fontWeight: "600",
      fontSize: 14,
    },
    btnDestructive: {
      backgroundColor: theme.danger,
    },
    btnDestructiveText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 14,
    },
    btnPrimary: {
      backgroundColor: theme.primary,
    },
    btnPrimaryText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 14,
    },
  });
}
