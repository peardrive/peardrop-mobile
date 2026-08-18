import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  ListRenderItem,
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
import { type IconName } from "../lib/files";
import { useVideoThumbnail } from "../lib/videoThumbnail";

export type FolderContentsTone = "warning" | "primary" | "danger" | "muted";

export type FolderContentsFile = {
  id: string;
  name: string;
  iconName: IconName;
  /** Local image URI to render as the row thumbnail. Ignored when `videoUri`
   *  produces a frame first (they're never both set in practice). */
  previewUri?: string | null;
  /** Local video URI; a one-frame thumbnail is generated on demand and
   *  cached module-wide, then swapped in place of the type-icon tile. */
  videoUri?: string | null;
  statusLabel: string;
  statusTone: FolderContentsTone;
  /** When true, the row's right-side control renders a red circle-X
   *  (active-share stop). When false, the open-external icon is shown. */
  isActiveShare?: boolean;
  /** When true, the row is dimmed (not-on-device / missing). */
  dim?: boolean;
  /** Child-blink flash. */
  blink?: boolean;
  onPress?: () => void;
  onRightControlPress?: () => void;
};

export type FolderContentsStatus = {
  label: string;
  tone: FolderContentsTone;
};

export type FolderContentsModalProps = {
  visible: boolean;
  onClose: () => void;
  folderName: string;
  /** Ionicons glyph shown in the header (folder-outline for regular folders). */
  headerIcon?: IconName;
  /** e.g. "12 Files · 4.5 GB" */
  metaLine: string;
  status?: FolderContentsStatus | null;
  files: FolderContentsFile[];
  /** When present, enables the Copy Link CTA at the bottom. */
  shareLink?: string | null;
  onCopyLink: () => void;
  /** When set, renders a primary "Start sharing" CTA at the bottom. Wired
   *  for inactive hosted folders so users can activate the whole bundle
   *  from the same surface they browse it in. */
  onStartSharing?: () => void;
  /** Header overflow-dots (top-left). Optional. */
  onOverflowPress?: () => void;
};

export default function FolderContentsModal({
  visible,
  onClose,
  folderName,
  headerIcon = "folder-outline",
  metaLine,
  status,
  files,
  shareLink,
  onCopyLink,
  onStartSharing,
  onOverflowPress,
}: FolderContentsModalProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const bottomToolbarClearance = insets.bottom + 20 + 84 + 12;
  const styles = useMemo(
    () => createStyles(theme, bottomToolbarClearance),
    [theme, bottomToolbarClearance],
  );
  const [search, setSearch] = useState("");

  // Reset the search box each time the modal opens so a stale query from
  // one folder never leaks into the next.
  useEffect(() => {
    if (visible) setSearch("");
  }, [visible]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, search]);

  const statusColor = toneToColor(theme, status?.tone ?? "muted");

  const renderItem: ListRenderItem<FolderContentsFile> = ({ item }) => (
    <FileRow file={item} theme={theme} styles={styles} />
  );

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
          accessibilityLabel="Close folder contents"
        >
          <Pressable
            style={styles.card}
            onPress={() => {
              // Absorb inner taps.
            }}
          >
            <View style={styles.headerRow}>
              {onOverflowPress ? (
                <Pressable
                  onPress={onOverflowPress}
                  style={styles.headerBtn}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="More folder options"
                >
                  <Ionicons
                    name="ellipsis-horizontal"
                    size={20}
                    color={theme.text}
                  />
                </Pressable>
              ) : (
                <View style={styles.headerBtn} />
              )}
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

            <View style={styles.folderMetaBlock}>
              <View style={styles.folderIconWrap}>
                <Ionicons name={headerIcon} size={32} color={theme.primary} />
              </View>
              <Text style={styles.folderName} numberOfLines={1}>
                {folderName}
              </Text>
              <Text style={styles.folderMeta}>{metaLine}</Text>
              {status ? (
                <Text style={[styles.folderStatus, { color: statusColor }]}>
                  {status.label}
                </Text>
              ) : null}
            </View>

            <View style={styles.divider} />

            <View style={styles.searchRow}>
              <Ionicons
                name="search-outline"
                size={16}
                color={theme.muted}
              />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search"
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Search files"
              />
              {search.length > 0 ? (
                <Pressable
                  onPress={() => setSearch("")}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                >
                  <Ionicons
                    name="close-circle"
                    size={16}
                    color={theme.muted}
                  />
                </Pressable>
              ) : null}
            </View>

            <FlatList
              data={filtered}
              keyExtractor={(f) => f.id}
              renderItem={renderItem}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  {files.length === 0
                    ? "No files in this folder."
                    : "No matches for that search."}
                </Text>
              }
            />

            {/* onStartSharing wins over shareLink: an inactive folder can
              *  still carry a persistent shareLink from a prior session,
              *  but Copy Link on an inactive folder is misleading — the
              *  drive isn't seeding, so the link won't resolve for peers.
              *  Start sharing is the meaningful next step. Its outlined-
              *  green treatment matches ShareQrModal's startBtn so users
              *  see one consistent affordance across surfaces. */}
            {onStartSharing ? (
              <Pressable
                style={styles.startBtn}
                onPress={onStartSharing}
                accessibilityRole="button"
                accessibilityLabel="Start sharing"
              >
                <Ionicons
                  name="share-outline"
                  size={16}
                  color={theme.primary}
                />
                <Text style={styles.startBtnText}>Start sharing</Text>
              </Pressable>
            ) : shareLink ? (
              <Pressable
                style={styles.copyBtn}
                onPress={onCopyLink}
                accessibilityRole="button"
                accessibilityLabel="Copy share link"
              >
                <Ionicons
                  name="link-outline"
                  size={18}
                  color={theme.onPrimary}
                />
                <Text style={styles.copyBtnText}>Copy Link</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function FileRow({
  file,
  theme,
  styles,
}: {
  file: FolderContentsFile;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const blinkAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!file.blink) return;
    blinkAnim.setValue(1);
    const anim = Animated.timing(blinkAnim, {
      toValue: 0,
      duration: 900,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [file.blink, blinkAnim]);
  const subColor = toneToColor(theme, file.statusTone);
  const videoThumb = useVideoThumbnail(
    file.previewUri ? null : file.videoUri ?? null,
  );
  const thumbUri = file.previewUri ?? videoThumb;
  return (
    <Pressable
      style={[styles.row, file.dim && styles.rowDim]}
      onPress={file.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${file.statusLabel}`}
    >
      {file.blink ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.blinkOverlay,
            {
              opacity: blinkAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 0.18],
              }),
            },
          ]}
        />
      ) : null}
      <View style={styles.rowThumb}>
        {thumbUri ? (
          <Image
            source={{ uri: thumbUri }}
            style={styles.rowThumbImage}
            resizeMode="cover"
          />
        ) : (
          <Ionicons name={file.iconName} size={22} color={theme.text} />
        )}
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>
          {file.name}
        </Text>
        <Text
          style={[styles.rowStatus, { color: subColor }]}
          numberOfLines={1}
        >
          {file.statusLabel}
        </Text>
      </View>
      {file.isActiveShare ? (
        <Pressable
          onPress={file.onRightControlPress}
          hitSlop={8}
          style={styles.rowStopCircle}
          accessibilityRole="button"
          accessibilityLabel={`Stop sharing ${file.name}`}
        >
          <Ionicons name="close" size={14} color={theme.onPrimary} />
        </Pressable>
      ) : (
        <Pressable
          onPress={file.onRightControlPress}
          hitSlop={8}
          style={styles.rowKebab}
          accessibilityRole="button"
          accessibilityLabel={`Open ${file.name} in another app`}
        >
          <Ionicons
            name="open-outline"
            size={18}
            color={theme.muted}
          />
        </Pressable>
      )}
    </Pressable>
  );
}

function toneToColor(theme: AppTheme, tone: FolderContentsTone): string {
  switch (tone) {
    case "warning":
      return theme.warning;
    case "primary":
      return theme.primary;
    case "danger":
      return theme.danger;
    default:
      return theme.muted;
  }
}

function createStyles(theme: AppTheme, bottomClearance: number) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.pad,
      paddingTop: theme.pad,
      // Reserve room at the bottom so the centered card never overlaps
      // the floating BottomToolbar (Send / Receive / Settings buttons).
      paddingBottom: bottomClearance,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      maxHeight: "88%",
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
      justifyContent: "space-between",
    },
    headerBtn: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
    },
    closeCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
    folderMetaBlock: {
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
    },
    folderIconWrap: {
      width: 60,
      height: 60,
      borderRadius: 16,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
    },
    folderName: {
      color: theme.text,
      fontSize: 18,
      fontWeight: "700",
      textAlign: "center",
    },
    folderMeta: {
      color: theme.muted,
      fontSize: 12,
    },
    folderStatus: {
      fontSize: 12,
      fontWeight: "700",
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    searchInput: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      paddingVertical: 8,
    },
    list: {
      flexGrow: 0,
      flexShrink: 1,
    },
    listContent: {
      paddingVertical: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
      position: "relative",
    },
    rowDim: { opacity: 0.6 },
    blinkOverlay: {
      position: "absolute",
      top: 2,
      left: 0,
      right: 0,
      bottom: 2,
      borderRadius: 8,
      backgroundColor: theme.primaryMuted,
    },
    rowThumb: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: theme.cardStrong,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    rowThumbImage: { width: "100%", height: "100%" },
    rowMain: { flex: 1, minWidth: 0 },
    rowName: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    rowStatus: {
      fontSize: 12,
      marginTop: 2,
      fontWeight: "500",
    },
    rowKebab: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    rowStopCircle: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
    emptyText: {
      color: theme.muted,
      fontSize: 13,
      textAlign: "center",
      paddingVertical: 20,
    },
    copyBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderRadius: 14,
      marginTop: 4,
    },
    copyBtnText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 15,
    },
    // Mirrors ShareQrModal.startBtn — outlined green so Start sharing
    // reads identically across every surface that offers it.
    startBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: theme.primary,
      backgroundColor: "transparent",
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginTop: 4,
    },
    startBtnText: {
      color: theme.primary,
      fontWeight: "600",
      fontSize: 13,
    },
  });
}
