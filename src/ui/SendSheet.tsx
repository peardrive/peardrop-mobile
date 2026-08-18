import React, { useMemo } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

export type RecentShareItem = {
  id: string;
  name: string;
  meta: string;
  /** Ionicons glyph to show in the left square. */
  icon: React.ComponentProps<typeof Ionicons>["name"];
  /** Present when the share still has a live link to copy. */
  shareLink?: string;
};

export type SendSheetProps = {
  visible: boolean;
  onClose: () => void;
  onPickFiles: () => void;
  onPickPhotos: () => void;
  /**
   * Folder sharing is hidden from the Send surface for now. The prop is kept
   * optional so callers can keep wiring the handler without a rebuild churn;
   * the entry point can be re-added here later without touching parents.
   */
  onPickFolder?: () => void;
  /** Recent hosted shares, ordered most-recent first. Empty list = section hidden. */
  recentShares: RecentShareItem[];
  /** Copy the share link to clipboard (parent owns the toast). */
  onCopyRecentLink: (link: string) => void;
};

/**
 * v5 Send: centered modal card (matching the Receive dialog) with two large
 * Files + Photos cards, then a Recent Shares list with a "Link" copy button.
 */
export default function SendSheet({
  visible,
  onClose,
  onPickFiles,
  onPickPhotos,
  onPickFolder: _onPickFolder,
  recentShares,
  onCopyRecentLink,
}: SendSheetProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close Send"
      >
        <Pressable
          style={styles.card}
          onPress={() => {
            // Absorb inner taps so they don't dismiss via the backdrop.
          }}
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>Send</Text>
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

          <View style={styles.cardsRow}>
            <SendCard
              theme={theme}
              icon="document-attach-outline"
              label="Files"
              onPress={onPickFiles}
            />
            <SendCard
              theme={theme}
              icon="images-outline"
              label="Photos"
              onPress={onPickPhotos}
            />
          </View>

          {recentShares.length > 0 ? (
            <>
              <View style={styles.sectionDivider} />
              <Text style={styles.sectionLabel}>Recent Shares</Text>
              <ScrollView
                style={styles.recentList}
                keyboardShouldPersistTaps="handled"
              >
                {recentShares.map((r, i) => (
                  <React.Fragment key={r.id}>
                    {i > 0 ? <View style={styles.divider} /> : null}
                    <View style={styles.recentRow}>
                      <View style={styles.recentIconWrap}>
                        <Ionicons name={r.icon} size={20} color={theme.text} />
                      </View>
                      <View style={styles.recentMain}>
                        <Text style={styles.recentName} numberOfLines={1}>
                          {r.name}
                        </Text>
                        <Text style={styles.recentMeta} numberOfLines={1}>
                          {r.meta}
                        </Text>
                      </View>
                      {r.shareLink ? (
                        <Pressable
                          style={styles.linkBtn}
                          onPress={() =>
                            onCopyRecentLink(r.shareLink as string)
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`Copy link for ${r.name}`}
                        >
                          <Ionicons
                            name="link"
                            size={14}
                            color={theme.primary}
                          />
                          <Text style={styles.linkBtnText}>Link</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </React.Fragment>
                ))}
              </ScrollView>
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SendCard({
  theme,
  icon,
  label,
  onPress,
}: {
  theme: AppTheme;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        aspectRatio: 1.15,
        borderRadius: theme.radius,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.cardStrong,
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          backgroundColor: theme.surfaceSubtle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={28} color={theme.primary} />
      </View>
      <Text style={{ color: theme.text, fontWeight: "700", fontSize: 15 }}>
        {label}
      </Text>
    </Pressable>
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
    cardsRow: {
      flexDirection: "row",
      gap: 12,
    },
    sectionDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginTop: 4,
    },
    sectionLabel: {
      color: theme.muted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    recentList: {
      maxHeight: 260,
    },
    recentRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
    },
    recentIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
    },
    recentMain: { flex: 1, minWidth: 0 },
    recentName: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    recentMeta: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 2,
    },
    linkBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.primaryMuted,
      backgroundColor: theme.surfaceSubtle,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    linkBtnText: {
      color: theme.primary,
      fontSize: 12,
      fontWeight: "700",
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
  });
}
