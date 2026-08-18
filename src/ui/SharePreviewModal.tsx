import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import { useBackend } from "../state/backend";
import type { AppTheme } from "./themes";
import { formatBytes } from "../lib/format";
import { baseName, fileIcon } from "../lib/files";

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // 50% scrim over an opaque theme.bg sheet. theme.card is a near-
      // transparent tint in most themes, which lets underlying screen text
      // bleed through the modal.
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
      padding: 16,
    },
    sheet: {
      maxHeight: "88%",
      borderRadius: 20,
      borderWidth: 1,
      borderColor: theme.border,
      // theme.bg is the only AppTheme color guaranteed to be fully opaque
      // across every theme (paper / cream / void / etc. all use solid hex).
      // theme.card is the tint meant to overlay theme.bg, but the modal's
      // direct child rendering layered tint over the scrim instead of bg —
      // which destroyed opacity. Solid theme.bg is the simplest fix.
      backgroundColor: theme.bg,
      padding: 16,
    },
    title: { color: theme.text, fontWeight: "700", fontSize: 18, marginBottom: 4 },
    meta: { color: theme.muted, fontSize: 13, marginBottom: 12 },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10,
    },
    selectAll: { color: theme.primary, fontWeight: "600", fontSize: 13 },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    fileRowFirst: { borderTopWidth: 0 },
    // Dim already-downloaded rows so the new files draw the eye.
    fileRowAlreadyHave: { opacity: 0.7 },
    gotItBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.primaryMuted,
      backgroundColor: theme.surfaceSubtle,
    },
    gotItBadgeText: {
      color: theme.primary,
      fontSize: 11,
      fontWeight: "700",
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
    },
    checkboxChecked: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    icon: { width: 28, textAlign: "center", fontSize: 18 },
    fileMain: { flex: 1, minWidth: 0 },
    fileName: { color: theme.text, fontSize: 14, fontWeight: "500" },
    fileMeta: { color: theme.muted, fontSize: 12, marginTop: 2 },
    actions: { flexDirection: "row", gap: 10, marginTop: 16 },
    primaryBtn: {
      flex: 1,
      backgroundColor: theme.primary,
      paddingVertical: 14,
      borderRadius: 14,
      alignItems: "center",
    },
    primaryText: { color: theme.onPrimary, fontWeight: "700", fontSize: 15 },
    closeBtn: {
      alignSelf: "flex-end",
      paddingVertical: 8,
      paddingHorizontal: 4,
      marginBottom: 8,
    },
    closeText: { color: theme.muted, fontWeight: "600", fontSize: 14 },
    disabled: { opacity: 0.55 },
    errBanner: { color: theme.danger, fontSize: 13, marginBottom: 10, lineHeight: 18 },
    // Advisory, distinct from the red errBanner: the share might still work,
    // this only warns that the other side appears offline.
    offlineBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.primaryMuted,
      backgroundColor: theme.surfaceSubtle,
      marginBottom: 10,
    },
    offlineBannerText: {
      flex: 1,
      color: theme.muted,
      fontSize: 12,
      lineHeight: 16,
    },
  });
}

export default function SharePreviewModal() {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const {
    previewVisible,
    closePreview,
    openResult,
    linkError,
    downloadAllBusy,
    downloadAllFromPreview,
    downloadSelectedFromPreview,
    alreadyDownloadedNames,
    sessionDriveId,
    pendingPreselection,
  } = useShareLinkFlow();
  const { transfers } = useBackend();

  const files = useMemo(() => openResult?.files ?? [], [openResult]);
  const alreadySet = useMemo(
    () => new Set(alreadyDownloadedNames),
    [alreadyDownloadedNames],
  );
  const isPartialMatch = alreadySet.size > 0;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Offline detection while the preview is open. The receiver's drive stays
  // joined to the swarm after the resolve, so its peer events reflect whether
  // the sender is still reachable. Zero peers past the grace window surfaces a
  // warning banner; deliberately advisory, never an auto-close.
  const modalOpenedAtRef = useRef<number | null>(null);
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (previewVisible) {
      modalOpenedAtRef.current = Date.now();
      setTickNow(Date.now());
      const id = setInterval(() => setTickNow(Date.now()), 1000);
      return () => clearInterval(id);
    }
    modalOpenedAtRef.current = null;
    return undefined;
  }, [previewVisible]);
  const sessionTransfer = useMemo(
    () =>
      sessionDriveId
        ? transfers.find((t) => t.driveId === sessionDriveId)
        : undefined,
    [transfers, sessionDriveId],
  );
  const offlineBannerVisible =
    previewVisible &&
    !!sessionDriveId &&
    !!modalOpenedAtRef.current &&
    tickNow - modalOpenedAtRef.current > 10_000 &&
    (!sessionTransfer || sessionTransfer.peersConnected === 0);

  // Default selection on open depends on whether this is a partial match:
  //  - partial: pre-select only the new files, so "Grab N" fetches exactly
  //    what's missing. Already-downloaded files are unchecked, badged, dim.
  //  - no match: nothing selected, primary action reads "Grab everything".
  // Closing clears selection so the next open starts fresh.
  useEffect(() => {
    if (!previewVisible) {
      setSelected(new Set());
      return;
    }
    // Re-grab pre-selection wins. The hint comes from tapping a missing child
    // row in an expanded bundle and names exactly which file to pre-check.
    // Preselected names that are already downloaded are skipped.
    if (pendingPreselection && pendingPreselection.length > 0) {
      const manifestNames = new Set(files.map((f) => f.name));
      const initial = pendingPreselection.filter(
        (n) => manifestNames.has(n) && !alreadySet.has(n),
      );
      setSelected(new Set(initial));
      return;
    }
    if (isPartialMatch) {
      const newOnes = files
        .map((f) => f.name)
        .filter((n) => !alreadySet.has(n));
      setSelected(new Set(newOnes));
    } else {
      setSelected(new Set());
    }
  }, [previewVisible, openResult, isPartialMatch, files, alreadySet, pendingPreselection]);

  const allKeys = useMemo(() => files.map((f) => f.name), [files]);
  const selectedKeys = useMemo(() => allKeys.filter((k) => selected.has(k)), [allKeys, selected]);
  const selectedBytes = useMemo(
    () => files.filter((f) => selected.has(f.name)).reduce((acc, f) => acc + (f.size ?? 0), 0),
    [files, selected]
  );
  const someSelected = selectedKeys.length > 0;
  const allSelected = selectedKeys.length > 0 && selectedKeys.length === allKeys.length;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allKeys));
  }

  const primaryLabel = someSelected
    ? `Grab ${selectedKeys.length} (${formatBytes(selectedBytes)})`
    : "Grab everything";

  // No in-modal blink: the "Got it" badge already says which files are
  // downloaded, and the acknowledging blink lives on the main list's bundle
  // row instead.
  const onPressGrab = () => {
    if (someSelected) void downloadSelectedFromPreview(selectedKeys);
    else void downloadAllFromPreview();
  };

  return (
    <Modal visible={previewVisible} transparent animationType="slide" onRequestClose={closePreview}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={closePreview} />
        <View style={styles.sheet}>
          <Pressable style={styles.closeBtn} onPress={closePreview}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
          <Text style={styles.title}>{openResult?.shareName || "Share"}</Text>
          <Text style={styles.meta}>
            {files.length} {files.length === 1 ? "file" : "files"} in here
          </Text>
          <View style={styles.topRow}>
            <Text style={styles.meta}>
              {someSelected
                ? `${selectedKeys.length} picked`
                : "Tap any file to grab just that one"}
            </Text>
            {files.length > 1 && (
              <Pressable onPress={toggleAll} accessibilityRole="button" accessibilityLabel="Toggle select all">
                <Text style={styles.selectAll}>{allSelected ? "Clear all" : "Pick all"}</Text>
              </Pressable>
            )}
          </View>
          {!!linkError && <Text style={styles.errBanner}>{linkError}</Text>}
          {offlineBannerVisible && (
            <View style={styles.offlineBanner} accessibilityLiveRegion="polite">
              <Ionicons name="cloud-offline-outline" size={16} color={theme.muted} />
              <Text style={styles.offlineBannerText}>
                The other side seems to be offline. The download might not work.
              </Text>
            </View>
          )}
          <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
            {files.map((f, index) => {
              const name = baseName(f.displayName || f.name);
              const checked = selected.has(f.name);
              const alreadyHave = alreadySet.has(f.name);
              return (
                <Pressable
                  key={`${f.name}_${index}`}
                  style={[
                    styles.fileRow,
                    index === 0 && styles.fileRowFirst,
                    alreadyHave && styles.fileRowAlreadyHave,
                  ]}
                  onPress={() => toggle(f.name)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={
                    alreadyHave
                      ? `${name}, already downloaded`
                      : `Pick ${name}`
                  }
                >
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked ? <Ionicons name="checkmark" size={14} color={theme.onPrimary} /> : null}
                  </View>
                  <Text style={styles.icon}>{fileIcon(name)}</Text>
                  <View style={styles.fileMain}>
                    <Text style={styles.fileName} numberOfLines={2}>
                      {name}
                    </Text>
                    <Text style={styles.fileMeta}>{formatBytes(f.size)}</Text>
                  </View>
                  {alreadyHave && (
                    <View style={styles.gotItBadge}>
                      <Ionicons
                        name="checkmark"
                        size={12}
                        color={theme.primary}
                      />
                      <Text style={styles.gotItBadgeText}>Got it</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable
              style={[styles.primaryBtn, downloadAllBusy && styles.disabled]}
              onPress={onPressGrab}
              disabled={downloadAllBusy}
              accessibilityRole="button"
              accessibilityLabel={primaryLabel}
            >
              {downloadAllBusy ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Text style={styles.primaryText}>{primaryLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
