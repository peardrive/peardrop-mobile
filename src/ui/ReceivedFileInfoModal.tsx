import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import QRCode from "react-native-qrcode-svg";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { formatBytes, formatRelativeOrDate } from "../lib/format";
import { baseName, fileIcon, fileExt } from "../lib/files";
import BottomSheet from "./BottomSheet";

export type ReceivedFileInfoModalProps = {
  visible: boolean;
  onClose: () => void;
  file?: {
    name: string;
    size?: number;
    downloadedAt: number;
    shareLink?: string;
  };
  onCopyLink?: (link: string) => void;
  onShareLink?: (link: string) => void;
};

/**
 * Read-only "where did this come from" surface for a received file. The
 * share link is rendered as a forwarding affordance — passing on what the
 * user already has, not seeding a new drive.
 */
export default function ReceivedFileInfoModal({
  visible,
  onClose,
  file,
  onCopyLink,
  onShareLink,
}: ReceivedFileInfoModalProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const name = file ? baseName(file.name) : "";
  const ext = file ? fileExt(file.name) : "";
  const receivedLabel = formatRelativeOrDate(file?.downloadedAt);
  const sizeLabel =
    file?.size != null && file.size > 0 ? formatBytes(file.size) : null;
  const link = file?.shareLink ?? "";
  const hasLink = !!link;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="File info"
      dangerClose
      maxHeight="92%"
    >
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          {file ? (
            <>
              <View style={styles.fileHeader}>
                <Text style={styles.fileIcon}>{fileIcon(file.name)}</Text>
                <Text style={styles.fileName} numberOfLines={2}>
                  {name}
                </Text>
                {sizeLabel ? (
                  <Text style={styles.fileSubtitle}>{sizeLabel}</Text>
                ) : null}
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoLabel}>FILE INFO</Text>
                {receivedLabel ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Received</Text>
                    <Text style={styles.infoRowValue}>{receivedLabel}</Text>
                  </View>
                ) : null}
                {ext ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Type</Text>
                    <Text style={styles.infoRowValue}>{ext}</Text>
                  </View>
                ) : null}
                {sizeLabel ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Size</Text>
                    <Text style={styles.infoRowValue}>{sizeLabel}</Text>
                  </View>
                ) : null}
              </View>

              {hasLink ? (
                <View style={styles.linkSection}>
                  <Text style={styles.infoLabel}>PASS THIS LINK ON</Text>
                  <View style={styles.qrWrap}>
                    <QRCode
                      value={link}
                      size={180}
                      backgroundColor="#ffffff"
                      color="#000000"
                      ecl="M"
                    />
                  </View>
                  <Text style={styles.link} numberOfLines={2} selectable>
                    {link}
                  </Text>
                  <View style={styles.actions}>
                    {onCopyLink ? (
                      <Pressable
                        style={styles.btn}
                        onPress={() => onCopyLink(link)}
                        accessibilityRole="button"
                        accessibilityLabel="Copy link"
                      >
                        <Ionicons name="copy-outline" size={16} color={theme.text} />
                        <Text style={styles.btnText}>Copy</Text>
                      </Pressable>
                    ) : null}
                    {onShareLink ? (
                      <Pressable
                        style={styles.btn}
                        onPress={() => onShareLink(link)}
                        accessibilityRole="button"
                        accessibilityLabel="Send link to someone"
                      >
                        <Ionicons name="share-outline" size={16} color={theme.text} />
                        <Text style={styles.btnText}>Send to…</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : (
                <View style={styles.noLinkSection}>
                  <Text style={styles.noLinkText}>
                    No link saved for this file.
                  </Text>
                </View>
              )}
            </>
          ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    body: { gap: 12 },
    fileHeader: {
      alignItems: "center",
      gap: 4,
      paddingVertical: 4,
    },
    fileIcon: { fontSize: 32 },
    fileName: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
      textAlign: "center",
    },
    fileSubtitle: { color: theme.muted, fontSize: 12 },
    infoSection: {
      marginTop: 4,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      gap: 6,
    },
    infoLabel: {
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.6,
      color: theme.muted,
      marginBottom: 4,
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
    },
    infoRowLabel: { color: theme.muted, fontSize: 13 },
    infoRowValue: {
      color: theme.text,
      fontSize: 13,
      fontWeight: "500",
      flexShrink: 1,
      textAlign: "right",
    },
    linkSection: {
      marginTop: 4,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      gap: 10,
    },
    qrWrap: {
      alignSelf: "center",
      padding: 10,
      borderRadius: 12,
      backgroundColor: "#ffffff",
    },
    link: { color: theme.muted, fontSize: 12, textAlign: "center" },
    actions: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 8,
      marginTop: 2,
    },
    btn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    btnText: { color: theme.text, fontWeight: "600", fontSize: 13 },
    noLinkSection: {
      marginTop: 4,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    noLinkText: {
      color: theme.muted,
      fontSize: 12,
      fontStyle: "italic",
      textAlign: "center",
    },
  });
}
