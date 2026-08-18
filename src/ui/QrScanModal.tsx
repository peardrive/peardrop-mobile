import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import { haptics } from "../lib/haptics";
import type { AppTheme } from "./themes";

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.pad,
      paddingBottom: 12,
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
      marginHorizontal: theme.pad,
      aspectRatio: 1,
      borderRadius: theme.radius,
      overflow: "hidden",
      backgroundColor: "#000",
      position: "relative",
    },
    cam: { ...StyleSheet.absoluteFillObject },
    overlayShade: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.28)",
    },
    finderCorners: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
    },
    finder: {
      width: "70%",
      aspectRatio: 1,
    },
    corner: {
      position: "absolute",
      width: 26,
      height: 26,
      borderColor: theme.primary,
    },
    cornerTL: {
      top: 0,
      left: 0,
      borderTopWidth: 3,
      borderLeftWidth: 3,
      borderTopLeftRadius: 6,
    },
    cornerTR: {
      top: 0,
      right: 0,
      borderTopWidth: 3,
      borderRightWidth: 3,
      borderTopRightRadius: 6,
    },
    cornerBL: {
      bottom: 0,
      left: 0,
      borderBottomWidth: 3,
      borderLeftWidth: 3,
      borderBottomLeftRadius: 6,
    },
    cornerBR: {
      bottom: 0,
      right: 0,
      borderBottomWidth: 3,
      borderRightWidth: 3,
      borderBottomRightRadius: 6,
    },
    hint: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
      paddingHorizontal: theme.pad,
      paddingVertical: 16,
    },
    actions: {
      paddingHorizontal: theme.pad,
      gap: 10,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.cardStrong,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 14,
    },
    actionIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    actionText: { flex: 1 },
    actionTitle: { color: theme.text, fontWeight: "600", fontSize: 14 },
    actionSubtitle: { color: theme.muted, fontSize: 12, marginTop: 2 },
    permissionBlock: {
      paddingHorizontal: theme.pad,
      paddingVertical: 24,
      gap: 12,
      alignItems: "center",
    },
    permissionTitle: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "700",
      textAlign: "center",
    },
    permissionBody: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
    },
    permissionBtnRow: {
      flexDirection: "row",
      gap: 10,
      marginTop: 6,
      flexWrap: "wrap",
      justifyContent: "center",
    },
    primaryBtn: {
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
    },
    primaryBtnText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 13,
    },
    ghostBtn: {
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
    },
    ghostBtnText: { color: theme.text, fontWeight: "600", fontSize: 13 },
  });
}

export default function QrScanModal() {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { qrVisible, setQrVisible, resolveFromScan, requestManualEntry } =
    useShareLinkFlow();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const [scanned, setScanned] = useState(false);
  const flash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (qrVisible) {
      scannedRef.current = false;
      setScanned(false);
      flash.setValue(0);
    }
  }, [qrVisible, flash]);

  const canScan = permission?.granted === true;
  const canRequest = permission?.canAskAgain !== false;

  const onScan = (data: string) => {
    if (!data || scannedRef.current) return;
    scannedRef.current = true;
    setScanned(true);
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
    void resolveFromScan(data);
  };

  // v5 polish: "Enter link manually" closes the scanner AND signals the
  // Receive sheet to reopen with the paste input focused.
  const enterManually = () => requestManualEntry();

  const cornerColor = flash.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.primary, theme.primary],
  });
  // Wrap corners in Animated so we can flash on scan.
  const AnimatedCorner = Animated.createAnimatedComponent(View);

  return (
    <Modal
      visible={qrVisible}
      animationType="slide"
      onRequestClose={() => setQrVisible(false)}
    >
      <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Scan QR Code</Text>
          <Pressable
            onPress={() => setQrVisible(false)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.closeCircle}
          >
            <Ionicons name="close" size={16} color={theme.onPrimary} />
          </Pressable>
        </View>

        {Platform.OS === "web" ? (
          <Text style={styles.hint}>
            Scanning doesn&apos;t work on web — use a pear.
          </Text>
        ) : !permission ? (
          <Text style={styles.hint}>Checking camera access…</Text>
        ) : !canScan ? (
          <View style={styles.permissionBlock}>
            <Ionicons name="camera-outline" size={40} color={theme.primary} />
            <Text style={styles.permissionTitle}>Camera access needed</Text>
            <Text style={styles.permissionBody}>
              {canRequest
                ? "Allow camera access to scan QR codes."
                : "You can turn camera access on in Settings."}
            </Text>
            <View style={styles.permissionBtnRow}>
              {canRequest ? (
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => void requestPermission()}
                  accessibilityRole="button"
                  accessibilityLabel="Allow camera access"
                >
                  <Text style={styles.primaryBtnText}>Allow camera</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => void Linking.openSettings()}
                  accessibilityRole="button"
                  accessibilityLabel="Open settings"
                >
                  <Text style={styles.primaryBtnText}>Open settings</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.ghostBtn}
                onPress={enterManually}
                accessibilityRole="button"
                accessibilityLabel="Enter link manually"
              >
                <Text style={styles.ghostBtnText}>Enter link manually</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.camWrap}>
              <CameraView
                style={styles.cam}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => onScan(data)}
              />
              <View style={styles.overlayShade} pointerEvents="none" />
              <View style={styles.finderCorners} pointerEvents="none">
                <View style={styles.finder}>
                  <AnimatedCorner
                    style={[
                      styles.corner,
                      styles.cornerTL,
                      { borderColor: cornerColor },
                    ]}
                  />
                  <AnimatedCorner
                    style={[
                      styles.corner,
                      styles.cornerTR,
                      { borderColor: cornerColor },
                    ]}
                  />
                  <AnimatedCorner
                    style={[
                      styles.corner,
                      styles.cornerBL,
                      { borderColor: cornerColor },
                    ]}
                  />
                  <AnimatedCorner
                    style={[
                      styles.corner,
                      styles.cornerBR,
                      { borderColor: cornerColor },
                    ]}
                  />
                </View>
              </View>
            </View>
            <Text style={styles.hint}>
              {scanned
                ? "Got it — opening…"
                : "Point at a QR code to receive."}
            </Text>
            <View style={styles.actions}>
              <Pressable
                style={styles.actionRow}
                onPress={enterManually}
                accessibilityRole="button"
                accessibilityLabel="Enter link manually"
              >
                <View style={styles.actionIconWrap}>
                  <Ionicons
                    name="link-outline"
                    size={22}
                    color={theme.primary}
                  />
                </View>
                <View style={styles.actionText}>
                  <Text style={styles.actionTitle}>Enter link manually</Text>
                  <Text style={styles.actionSubtitle}>
                    Paste a peardrop:// link.
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={theme.muted}
                />
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}
