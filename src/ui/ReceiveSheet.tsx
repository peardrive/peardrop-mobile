import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
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
import Ionicons from "@expo/vector-icons/Ionicons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useAppTheme } from "../state/ThemeContext";
import { haptics } from "../lib/haptics";
import {
  RESOLVE_HINTS,
  RESOLVE_LOOKING_LABEL,
  resolveHintFor,
} from "../lib/resolveHint";
import { indicatorColor } from "../lib/indicatorColor";
import PearSonarLite from "./PearSonarLite";
// The scan payload is classified before anything is claimed about it.
// Copy lives there, not here.
import { classifyScan, type ScanOutcome } from "../lib/scanOutcome";
// the inline notice carries a tone — "wait" renders muted
// with an info icon, "error" stays theme.danger.
import type { LinkNotice } from "../lib/resolveNotice";
import type { AppTheme } from "./themes";
import { ToastOutlet } from "./Toast";

/**
 * how often the elapsed-resolve clock is
 * re-read.
 *
 * 1 s, because the hint thresholds (`RESOLVE_HINT_FIRST_MS` = 5 s,
 * `RESOLVE_HINT_SECOND_MS` = 15 s) are whole seconds: a coarser tick would let
 * a hint land visibly late, and a finer one re-renders this sheet — which owns
 * a camera preview — for nothing. Nothing reads the elapsed value except
 * `resolveHintFor`, so the tick only ever needs to be fine enough to cross a
 * threshold promptly.
 */
const RESOLVE_TICK_MS = 1_000;

/**
 * Module scope, NOT the render body.
 *
 * `createAnimatedComponent` returns a new component *type* on every call, and
 * React reconciles by type identity — a changed type unmounts the whole
 * subtree and mounts a fresh one. This wraps `CameraView`, so building it
 * per-render tore down and re-created the camera on every render of this
 * sheet. That is the black / flickering preview: a camera that is destroyed
 * and re-initialised repeatedly has nothing to show in between.
 *
 * Re-rendering this sheet is ordinary and frequent — it is a child of
 * MainScreen, which subscribes to `transfers`, and any engine event stream
 * drives it. The fix is to make re-render cheap rather than to chase the
 * things that cause one. `TopTabs.tsx:45-46` is the same call in the correct
 * place, hoisted to module scope for the same reason.
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
  /** Fired when the embedded camera decodes a QR — parent hands off to
   *  the existing link-flow resolveFromScan pipeline. */
  onScan: (data: string) => void;
  /** Inline notice if the link couldn't resolve — tone-tagged. */
  linkError?: LinkNotice | null;
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
  /** Re-reads the permission without prompting: once declined for good, nothing else ever re-reads it. */
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const flash = useRef(new Animated.Value(0)).current;
  const [scanFlash, setScanFlash] = useState(false);
  // The last rejected scan, rendered in place
  // of the "Got it — opening…" badge. Cleared by the next accepted scan.
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

  /** Re-read the camera permission on open and on every return to the foreground. */
  // The foreground edge is load-bearing: it is the one signal that the user may have changed the answer in Settings.
  useEffect(() => {
    if (!visible || Platform.OS === "web") return;
    void getPermission();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void getPermission();
    });
    return () => sub.remove();
  }, [visible, getPermission]);

  /** The elapsed-resolve clock, a wall-clock delta rather than a tick count. */
  // Timers stop in the background here, so counting intervals would show the hint late exactly when the wait is longest.
  const [resolveElapsedMs, setResolveElapsedMs] = useState(0);
  useEffect(() => {
    if (!resolving) {
      setResolveElapsedMs(0);
      // Leaving the looking state re-mounts the camera, so clear the latch or
      // it ignores every later code. Covers Cancel and a failed resolve alike.
      scannedRef.current = false;
      // The "Got it — opening…" badge must go with it: it is the first arm of
      // the badge ternary, so a stale one hides every later rejection.
      setScanFlash(false);
      setScanError(null);
      return;
    }
    const startedAt = Date.now();
    setResolveElapsedMs(0);
    const id = setInterval(() => {
      setResolveElapsedMs(Date.now() - startedAt);
    }, RESOLVE_TICK_MS);
    return () => clearInterval(id);
  }, [resolving]);

  // `null` until the first threshold, which is what keeps the spinner alone for
  // the first few seconds. The copy and the thresholds live in
  // `src/lib/resolveHint.ts` — a .tsx cannot be imported by jest in this
  // project, so keeping them out of here is what makes the copy deny-list
  // testable.
  const resolveHint = resolving ? resolveHintFor(resolveElapsedMs) : null;

  const canScan = permission?.granted === true;
  const canRequest = permission?.canAskAgain !== false;

  /**
   * The payload is classified before anything is claimed about it. Flashing
   * the frame, firing the **success** haptic, and rendering "Got it —
   * opening…" for every QR code regardless of content would hand the payload
   * to a caller that can do nothing with an unusable one — nothing happens,
   * but the user has been told it worked — and would latch `scannedRef`
   * before that is known, leaving the scanner dead, under a success message,
   * until the sheet is closed and reopened.
   *
   * The decision and the copy live in `src/lib/scanOutcome.ts` (this file is
   * `.tsx` and unreachable from the suite); it reuses the deep-link path's
   * parser and its one-message-per-rejection rule rather than inventing a
   * second taxonomy.
   *
   * A rejected scan does **not** latch: the camera is still pointed at
   * something, so the next code is read. That is the one way the scan path
   * differs from the deep-link path, which arrives exactly once.
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
              {/* First arm on purpose: unmounting CameraView is the only
                  thing that releases the Android camera. Hiding would not.

                  `visible &&` closes an iOS-only path: Modal keeps its
                  children rendered after the first open there (`isRendered`),
                  so a hidden sheet would mount a second, invisible sonar
                  whenever the picker resolves. No-op on Android, which
                  unmounts the subtree outright. */}
              {visible && resolving ? (
                <View style={styles.lookingPanel}>
                  <PearSonarLite
                    size={120}
                    color={indicatorColor(theme)}
                    label={RESOLVE_LOOKING_LABEL}
                  />
                  <Text
                    style={styles.lookingText}
                    accessibilityLiveRegion="polite"
                  >
                    {resolveHint ?? RESOLVE_HINTS.initial}
                  </Text>
                  <Pressable
                    style={styles.lookingCancel}
                    onPress={onAbortResolving}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                  >
                    <Text style={styles.lookingCancelLabel}>Cancel</Text>
                  </Pressable>
                </View>
              ) : Platform.OS === "web" ? (
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
                    /* The badge does not claim success for a code that is
                       not a PearDrop link. It stays until the next code is
                       read — the scanner is deliberately NOT latched on a
                       rejection. */
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

            {/* The hint used to render here too. The looking panel owns it now,
                and two polite live regions announced the same sentence twice. */}

            {linkError ? (
              <View style={styles.errorRow}>
                {/* A "wait" notice is a normal wait, not a
                    failure — muted text + info icon, same rationale as the
                    resolveHint style below. "error" stays red. */}
                {linkError.tone === "wait" ? (
                  <Ionicons
                    name="information-circle-outline"
                    size={16}
                    color={theme.muted}
                  />
                ) : null}
                {/* no numberOfLines — the notice wraps
                    instead of truncating with "…", same as SharePreviewModal's
                    errBanner. Copy length is capped upstream (check:copy
                    global 120; per-constant jest caps at 100). */}
                <Text
                  style={
                    linkError.tone === "wait" ? styles.waitText : styles.errorText
                  }
                >
                  {linkError.text}
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
      {/* last child on purpose: this Modal is its own Android window,
          and a root-level toast would be painted under it (and untappable).
          While this sheet is open its outlet is the last registered, so it
          owns the toast; it unregisters on close and the root takes over.
          See src/lib/toastOutletSelect.ts. */}
      {visible && <ToastOutlet />}
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // A dialog window OCCLUDES an activity-window toast, it does not dim it,
      // so dropping the wash never made one tappable — it only left a theme.bg
      // card on a theme.bg screen. Edge-to-edge is force-on here, so both
      // translucency getters return true whatever the JSX says and this wash
      // already reaches both system bars. Nothing to ADD, and nothing to
      // remove either: the `statusBarTranslucent` at :261 is a pre-existing
      // no-op that ruling 11 deliberately left alone (SharePreviewModal does
      // not carry it, and the dim covers its bars just the same).
      backgroundColor: theme.scrim,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.pad,
    },
    lookingPanel: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    // theme.muted, never theme.danger: a resolve still running has not failed,
    // and colouring it like the error row tells the user to give up too early.
    lookingText: {
      marginTop: 16,
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
    },
    lookingCancel: {
      marginTop: 24,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
    },
    lookingCancelLabel: {
      color: theme.text,
      fontWeight: "600",
      fontSize: 13,
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
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 10,
      elevation: 4,
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
    // The second line of a rejected-scan
    // badge. Same pill, so the badge does not jump position between outcomes.
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
    // the "wait"-tone notice. `theme.muted`, not
    // `theme.danger`, for the same reason as `resolveHint` above — a sender
    // that has not answered yet has not failed.
    waitText: {
      flex: 1,
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
    },
  });
}
