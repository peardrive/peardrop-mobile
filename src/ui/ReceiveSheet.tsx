import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useAppTheme } from "../state/ThemeContext";
import { haptics } from "../lib/haptics";
import type { AppTheme } from "./themes";

export type ReceiveSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Current value of the paste-link field. */
  linkDraft: string;
  onLinkDraftChange: (next: string) => void;
  /** True while the pasted link is being resolved. */
  resolving: boolean;
  /** Cancel any in-flight resolve. */
  onAbortResolving: () => void;
  /** Fired when the embedded camera decodes a QR — parent hands off to
   *  the existing link-flow resolveFromScan pipeline. */
  onScan: (data: string) => void;
  /** Inline error message if the link couldn't resolve. */
  linkError?: string | null;
  /** Retry a failed link resolve. */
  onRetry?: () => void;
  /**
   * When true, focus the paste input after the modal appears. Used by
   * the "Enter link manually" affordance and by other callers that need
   * to skip past the scanner.
   */
  focusPaste?: boolean;
};

/**
 * v5 Receive: centered modal card with the camera preview in a bordered
 * square. Presented via a middle-of-screen dialog over a dim scrim (per
 * design). Paste-link row lives beneath the square with a green "Paste"
 * button that pulls from clipboard. The polish-round removal of
 * "Import Qrcode Image" is preserved — this modal does not surface it.
 */
export default function ReceiveSheet({
  visible,
  onClose,
  linkDraft,
  onLinkDraftChange,
  resolving,
  onAbortResolving,
  onScan,
  linkError,
  onRetry,
  focusPaste,
}: ReceiveSheetProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const pasteRef = useRef<TextInput>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const flash = useRef(new Animated.Value(0)).current;
  const [scanFlash, setScanFlash] = useState(false);

  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
      setScanFlash(false);
      flash.setValue(0);
    }
  }, [visible, flash]);

  useEffect(() => {
    if (!visible || !focusPaste) return;
    const t = setTimeout(() => pasteRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [visible, focusPaste]);

  const canScan = permission?.granted === true;
  const canRequest = permission?.canAskAgain !== false;

  const onBarcode = (data: string) => {
    if (!data || scannedRef.current) return;
    scannedRef.current = true;
    setScanFlash(true);
    haptics.actionDone();
    Animated.sequence([
      Animated.timing(flash, {
        toValue: 1,
        duration: 120,
        useNativeDriver: false,
      }),
      Animated.timing(flash, {
        toValue: 0,
        duration: 220,
        useNativeDriver: false,
      }),
    ]).start();
    onScan(data);
  };

  const AnimatedView = Animated.createAnimatedComponent(View);
  const borderColor = flash.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.border, theme.primary],
  });

  const onPastePress = async () => {
    try {
      const raw = await Clipboard.getStringAsync();
      const trimmed = (raw || "").trim();
      if (!trimmed) return;
      onLinkDraftChange(trimmed);
    } catch {
      // Clipboard read can fail on locked-down platforms — silently ignore;
      // the user can still type manually.
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityLabel="Close Receive"
        >
          <Pressable
            style={styles.card}
            onPress={() => {
              // Absorb inner taps so they don't dismiss via the backdrop.
            }}
          >
            <View style={styles.titleRow}>
              <Text style={styles.title}>Receive</Text>
              <Pressable
                onPress={onClose}
                style={styles.closeCircle}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={16} color={theme.onPrimary} />
              </Pressable>
            </View>

            <AnimatedView style={[styles.camWrap, { borderColor }]}>
              {Platform.OS === "web" ? (
                <View style={styles.camPlaceholder}>
                  <Text style={styles.camLabel}>QR Code Scan</Text>
                  <Text style={styles.camHint}>
                    Scanning doesn&apos;t work on web — use a pear.
                  </Text>
                </View>
              ) : !permission ? (
                <View style={styles.camPlaceholder}>
                  <Text style={styles.camLabel}>QR Code Scan</Text>
                  <ActivityIndicator color={theme.primary} />
                </View>
              ) : !canScan ? (
                <View style={styles.camPlaceholder}>
                  <Text style={styles.camLabel}>QR Code Scan</Text>
                  <Ionicons
                    name="camera-outline"
                    size={32}
                    color={theme.primary}
                  />
                  <Text style={styles.permBody}>
                    {canRequest
                      ? "Allow camera access to scan QR codes."
                      : "Turn on camera access in Settings to scan codes."}
                  </Text>
                  <Pressable
                    style={styles.permBtn}
                    onPress={
                      canRequest
                        ? () => void requestPermission()
                        : () => void Linking.openSettings()
                    }
                    accessibilityRole="button"
                    accessibilityLabel={
                      canRequest ? "Allow camera" : "Open settings"
                    }
                  >
                    <Text style={styles.permBtnLabel}>
                      {canRequest ? "Allow camera" : "Open settings"}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <CameraView
                    style={styles.cam}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={({ data }) => onBarcode(data)}
                  />
                  {scanFlash ? (
                    <View style={styles.camScanBadge} pointerEvents="none">
                      <Text style={styles.camScanBadgeText}>
                        Got it — opening…
                      </Text>
                    </View>
                  ) : null}
                </>
              )}
            </AnimatedView>

            <View style={styles.orRow}>
              <View style={styles.orRule} />
              <Text style={styles.orLabel}>Or</Text>
              <View style={styles.orRule} />
            </View>

            <View style={styles.pasteRow}>
              <TextInput
                ref={pasteRef}
                style={styles.pasteInput}
                value={linkDraft}
                onChangeText={onLinkDraftChange}
                placeholder="Paste link here"
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!resolving}
                accessibilityLabel="Paste share link"
              />
              {resolving ? (
                <ActivityIndicator
                  color={theme.primary}
                  style={styles.pasteAdornment}
                />
              ) : null}
              {linkDraft.length > 0 ? (
                <Pressable
                  style={styles.pasteAdornment}
                  onPress={() => {
                    if (resolving) onAbortResolving();
                    onLinkDraftChange("");
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={
                    resolving ? "Cancel and clear link" : "Clear link"
                  }
                >
                  <Ionicons
                    name="close-circle"
                    size={18}
                    color={theme.muted}
                  />
                </Pressable>
              ) : null}
              <Pressable
                onPress={onPastePress}
                disabled={resolving}
                style={[styles.pasteBtn, resolving && styles.pasteBtnDisabled]}
                accessibilityRole="button"
                accessibilityLabel="Paste link from clipboard"
              >
                <Text style={styles.pasteBtnText}>Paste</Text>
              </Pressable>
            </View>

            {linkError ? (
              <View style={styles.errorRow}>
                <Text style={styles.errorText} numberOfLines={2}>
                  {linkError}
                </Text>
                {onRetry && linkDraft.trim().length > 0 ? (
                  <Pressable
                    onPress={onRetry}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Retry"
                  >
                    <Ionicons
                      name="refresh-outline"
                      size={18}
                      color={theme.primary}
                    />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
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
      padding: theme.pad,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      borderRadius: 20,
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: theme.pad,
      gap: 14,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: { color: theme.text, fontWeight: "700", fontSize: 20 },
    closeCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
    camWrap: {
      alignSelf: "center",
      width: "100%",
      aspectRatio: 1,
      borderRadius: theme.radius,
      overflow: "hidden",
      borderWidth: 1.5,
      backgroundColor: theme.surfaceSubtle,
      position: "relative",
    },
    cam: { ...StyleSheet.absoluteFillObject },
    camPlaceholder: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: 20,
    },
    camLabel: {
      color: theme.muted,
      fontSize: 15,
      fontWeight: "600",
    },
    camHint: {
      color: theme.muted,
      fontSize: 13,
      textAlign: "center",
    },
    camScanBadge: {
      position: "absolute",
      bottom: 12,
      alignSelf: "center",
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: theme.primary,
    },
    camScanBadgeText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 12,
    },
    permBody: {
      color: theme.muted,
      fontSize: 12,
      textAlign: "center",
      lineHeight: 16,
    },
    permBtn: {
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
      marginTop: 4,
    },
    permBtnLabel: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 13,
    },
    orRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 4,
    },
    orRule: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    orLabel: {
      color: theme.muted,
      fontSize: 13,
      fontWeight: "600",
    },
    pasteRow: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      paddingLeft: 12,
      paddingRight: 4,
      paddingVertical: 4,
    },
    pasteInput: {
      flex: 1,
      color: theme.text,
      fontSize: 15,
      paddingVertical: 10,
    },
    pasteAdornment: { marginLeft: 4, padding: 4 },
    pasteBtn: {
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 12,
      marginLeft: 6,
    },
    pasteBtnDisabled: {
      opacity: 0.5,
    },
    pasteBtnText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 13,
    },
    errorRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 2,
    },
    errorText: {
      flex: 1,
      color: theme.danger,
      fontSize: 13,
      lineHeight: 18,
    },
  });
}
