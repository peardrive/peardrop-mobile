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
import { resolveHintFor } from "../lib/resolveHint";
// The scan payload is classified before anything is claimed about it, and
// the copy lives with the classifier so it stays testable outside a `.tsx`.
import { classifyScan, type ScanOutcome } from "../lib/scanOutcome";
import type { AppTheme } from "./themes";

/**
 * How often the elapsed-resolve clock is re-read. The hint thresholds are
 * whole seconds: a coarser tick lands a hint visibly late, and a finer one
 * re-renders a sheet that owns a camera preview for nothing.
 */
const RESOLVE_TICK_MS = 1_000;

/**
 * Must stay at module scope, not in the render body. `createAnimatedComponent`
 * returns a new component type per call and React reconciles by type
 * identity, so building it per render tears down and re-creates the camera —
 * a black, flickering preview. Re-rendering this sheet is frequent.
 */
const AnimatedView = Animated.createAnimatedComponent(View);

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
  /** Fired when the embedded camera decodes a QR. The parent hands off to
   *  the link-flow resolve pipeline. */
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
 * Receive: a centered modal card holding the camera preview in a bordered
 * square over a dim scrim, with the paste-link row beneath it. Importing a
 * QR code from an image file is deliberately not offered here.
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
  // The last rejected scan, rendered in place of the "Got it — opening…"
  // badge. Cleared by the next accepted scan.
  const [scanError, setScanError] = useState<
    Extract<ScanOutcome, { kind: "rejected" }> | null
  >(null);

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

  /**
   * The elapsed-resolve clock. Wall-clock delta, not a tick count: a count of
   * intervals under-reports whenever the JS thread is starved, and RN timers
   * stop entirely in the background, so the hint would appear late or never
   * exactly when the wait is longest. The cleanup clears the interval on both
   * transitions that matter, `resolving` going false and this sheet unmounting.
   */
  const [resolveElapsedMs, setResolveElapsedMs] = useState(0);
  useEffect(() => {
    if (!resolving) {
      setResolveElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setResolveElapsedMs(0);
    const id = setInterval(() => {
      setResolveElapsedMs(Date.now() - startedAt);
    }, RESOLVE_TICK_MS);
    return () => clearInterval(id);
  }, [resolving]);

  // `null` until the first threshold, so the spinner stands alone at first.
  // The copy and thresholds live in `src/lib/resolveHint.ts` to stay testable.
  const resolveHint = resolving ? resolveHintFor(resolveElapsedMs) : null;

  const canScan = permission?.granted === true;
  const canRequest = permission?.canAskAgain !== false;

  /**
   * The payload is classified before anything is claimed, through the same
   * parser the deep-link path uses rather than a second taxonomy. A rejected
   * scan does not latch `scannedRef`: the camera is still pointed at
   * something, so the next code is read. That is the one way this differs
   * from the deep-link path, which arrives exactly once.
   */
  const onBarcode = (data: string) => {
    if (!data || scannedRef.current) return;
    const outcome = classifyScan(data);
    if (outcome.kind === "rejected") {
      // `warning`, not `error`: pointing the camera at the wrong thing is a
      // soft miss the user fixes by moving the phone, not a failure.
      haptics.warning();
      setScanError(outcome);
      return;
    }
    scannedRef.current = true;
    setScanError(null);
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
    onScan(outcome.link);
  };

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
                <Ionicons name="close" size={16} color={theme.muted} />
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
                  ) : scanError ? (
                    /* The badge never claims success for a code that was not
                       a PearDrop link. It stays until the next code is read;
                       the scanner is deliberately not latched on rejection. */
                    <View style={styles.camScanBadge} pointerEvents="none">
                      <Text style={styles.camScanBadgeText}>
                        {scanError.title}
                      </Text>
                      <Text style={styles.camScanBadgeSub}>
                        {scanError.message}
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

            {/*
              Sits directly under the paste row that holds the spinner, so the
              words and the spinner read as one state. Polite live region
              because it appears mid-wait with no user action: a screen reader
              must announce it without stealing focus from the input.
            */}
            {resolveHint ? (
              <Text
                style={styles.resolveHint}
                accessibilityLiveRegion="polite"
              >
                {resolveHint}
              </Text>
            ) : null}

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
      backgroundColor: theme.tabBadgeBg,
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
      textAlign: "center",
    },
    // Second line of a rejected-scan badge. Same pill, so the badge does not
    // jump position between outcomes.
    camScanBadgeSub: {
      color: theme.onPrimary,
      fontWeight: "500",
      fontSize: 11,
      textAlign: "center",
      marginTop: 2,
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
    // `theme.muted`, not `theme.danger`: a resolve still running has not
    // failed, and error colouring would tell the user to give up too early.
    resolveHint: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      marginTop: 2,
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
