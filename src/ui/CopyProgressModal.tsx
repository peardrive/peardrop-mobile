import React, { useMemo } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "../state/ThemeContext";
import { formatBytes } from "../lib/format";
import type { AppTheme } from "./themes";
import { ToastOutlet } from "./Toast";

export type CopyProgressModalProps = {
  visible: boolean;
  /** 1-based position in the share, for the "2 of 12" line. */
  index: number;
  count: number;
  copiedBytes: number;
  /** Zero when no provider stated a size; the bar then goes indeterminate. */
  totalBytes: number;
  displayName: string;
};

/** What the user sees while a shared file is copied in. No dismiss: the grant dies if the task
 *  goes, so a cancel here would leave a half-copied file and no way to finish it. */
export default function CopyProgressModal({
  visible,
  index,
  count,
  copiedBytes,
  totalBytes,
  displayName,
}: CopyProgressModalProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const known = totalBytes > 0;
  const pct = known
    ? Math.max(0, Math.min(100, Math.round((copiedBytes / totalBytes) * 100)))
    : 0;
  const counted = count > 1 ? `${Math.min(index + 1, count)} of ${count}` : "";

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Getting your files ready</Text>
          {displayName ? (
            <Text style={styles.body} numberOfLines={1}>
              {displayName}
            </Text>
          ) : null}
          <View style={styles.track}>
            <View style={[styles.fill, { width: known ? `${pct}%` : "25%" }]} />
          </View>
          <Text style={styles.meta}>
            {known
              ? `${formatBytes(copiedBytes)} of ${formatBytes(totalBytes)}`
              : formatBytes(copiedBytes)}
            {counted ? `  ·  ${counted}` : ""}
          </Text>
        </View>
      </View>
      {visible && <ToastOutlet />}
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
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
      gap: 10,
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
    },
    track: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.border,
      overflow: "hidden",
      marginTop: 2,
    },
    fill: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.primary,
    },
    meta: {
      color: theme.muted,
      fontSize: 12,
    },
  });
}
