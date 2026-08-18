import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type NameShareModalProps = {
  visible: boolean;
  /** Prefilled name; user can edit before confirming. */
  defaultName: string;
  /** How many files this share will bundle — surfaced in the subtitle so
   *  the user knows what they're naming. Ignored when `subtitle` is set. */
  fileCount: number;
  onCancel: () => void;
  /** Fires with the trimmed name once the user taps Share. */
  onConfirm: (name: string) => void;
  // Copy overrides, so the same one-field prompt can serve the debug-log
  // export without share-specific wording. Defaults reproduce the share
  // behaviour, leaving existing call sites unchanged.
  title?: string;
  subtitle?: string;
  placeholder?: string;
  confirmLabel?: string;
  confirmIcon?: React.ComponentProps<typeof Ionicons>["name"];
};

/**
 * One-step name prompt shown after a multi-file / multi-photo pick. The
 * confirmed name is stored on the hosted-share flags row so the list card
 * and File-info modal both read it back as the drive title.
 */
export default function NameShareModal({
  visible,
  defaultName,
  fileCount,
  onCancel,
  onConfirm,
  title = "Name this share",
  subtitle,
  placeholder = "e.g. Trip photos",
  confirmLabel = "Share",
  confirmIcon = "share-outline",
}: NameShareModalProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => createStyles(theme, insets.top + 24),
    [theme, insets.top],
  );
  const [name, setName] = useState(defaultName);

  // Reset the field each time the modal reopens so a stale draft from a
  // previous share doesn't leak into the next one.
  useEffect(() => {
    if (visible) setName(defaultName);
  }, [visible, defaultName]);

  const trimmed = name.trim();
  const canConfirm = trimmed.length > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          style={styles.backdrop}
          onPress={onCancel}
          accessibilityLabel="Cancel"
        >
          <Pressable
            style={styles.card}
            onPress={() => {
              // Absorb inner taps so tapping the card doesn't close it.
            }}
          >
            <View style={styles.headerRow}>
              <View style={styles.headerTitleSlot} />
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Pressable
                onPress={onCancel}
                style={styles.closeCircle}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Ionicons name="close" size={16} color={theme.onPrimary} />
              </Pressable>
            </View>

            <Text style={styles.subtitle}>
              {subtitle ??
                (fileCount === 1
                  ? "1 file will share under this name."
                  : `${fileCount} files will share under this name.`)}
            </Text>

            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder={placeholder}
              placeholderTextColor={theme.muted}
              autoFocus
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (canConfirm) onConfirm(trimmed);
              }}
              accessibilityLabel="Share name"
            />

            <View style={styles.actions}>
              <Pressable
                style={styles.cancelBtn}
                onPress={onCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.confirmBtn,
                  !canConfirm && styles.confirmBtnDisabled,
                ]}
                onPress={() => canConfirm && onConfirm(trimmed)}
                disabled={!canConfirm}
                accessibilityRole="button"
                accessibilityLabel={confirmLabel}
              >
                <Ionicons
                  name={confirmIcon}
                  size={16}
                  color={theme.onPrimary}
                />
                <Text style={styles.confirmBtnText}>{confirmLabel}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(theme: AppTheme, topInset: number) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.pad,
      paddingTop: topInset,
      paddingBottom: theme.pad,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      borderRadius: 20,
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: theme.pad,
      gap: 12,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    headerTitleSlot: { width: 28, height: 28 },
    title: {
      flex: 1,
      textAlign: "center",
      color: theme.text,
      fontSize: 16,
      fontWeight: "700",
    },
    closeCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
    subtitle: {
      color: theme.muted,
      fontSize: 13,
      textAlign: "center",
    },
    input: {
      color: theme.text,
      fontSize: 15,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    actions: {
      flexDirection: "row",
      gap: 8,
      marginTop: 4,
    },
    cancelBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: "transparent",
      borderRadius: 12,
      paddingVertical: 12,
    },
    cancelBtnText: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    confirmBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.primary,
      borderRadius: 12,
      paddingVertical: 12,
    },
    confirmBtnDisabled: {
      opacity: 0.5,
    },
    confirmBtnText: {
      color: theme.onPrimary,
      fontSize: 15,
      fontWeight: "700",
    },
  });
}
