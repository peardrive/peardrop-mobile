import React, { useMemo, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import QRCode from "react-native-qrcode-svg";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { formatAbsoluteDate, formatBytes } from "../lib/format";
import { type IconName } from "../lib/files";
import { useVideoThumbnail } from "../lib/videoThumbnail";
import ConfirmModal from "./ConfirmModal";

/** QR box side length. Kept equal to the placeholder tile size so the
 *  modal footprint is identical whether or not a live link is present. */
const QR_SIZE = 200;

export type ShareQrModalInfoFile = {
  /** Storage path or bare filename. The modal calls `baseName` on it so
   *  bundle entries never render with a leading slash. */
  name: string;
  size?: number;
  /** Local file URI (for images). Rendered as a row thumbnail. */
  previewUri?: string | null;
  /** Local video URI. A one-frame thumbnail is generated on demand. */
  videoUri?: string | null;
};

export type ShareQrModalHeader = {
  /** Fallback glyph when no thumbnail resolves. */
  iconName: IconName;
  /** Local image URI for the header thumbnail (single-file image rows). */
  previewUri?: string | null;
  /** Local video URI for the header thumbnail (generated on demand). */
  videoUri?: string | null;
  /** Bold row-title — usually the file/folder name. */
  name: string;
  /** Muted sub-line, e.g. "Video" or "12 Files". */
  subline?: string;
  /** Bundle tile styling (filled folder over `theme.secondary`). */
  isBundle?: boolean;
};

export type ShareQrModalProps = {
  visible: boolean;
  /** Persistent share link. Always rendered as a QR when non-empty,
   *  regardless of whether the drive is currently seeding. */
  link: string;
  /** Header title. Defaults to "File info" / "Folder info". */
  title?: string;
  /** Item identity block rendered directly under the title. */
  header?: ShareQrModalHeader;
  /** Whether the drive is currently seeding. Controls which action button
   *  set the modal renders at the bottom. */
  isActive?: boolean;
  onClose: () => void;
  /** Copy the link to the clipboard. Rendered as the primary bottom
   *  action when the drive is active. */
  onCopy?: () => void;
  /** Delete the (inactive) drive. Rendered as the "Remove" outline-red
   *  button; only shown when the drive is inactive. */
  onRemove?: () => void;
  /** Activate the drive so peers can grab it. Rendered as the
   *  outline-green "Start sharing" button when inactive. */
  onActivate?: () => void;
  info?: {
    /** "live" → green dot + "Active". "dormant" → muted + "Inactive".
     * "failed" → danger + "Couldn't restore". */
    status?: "live" | "dormant" | "failed";
    /** ms since epoch. Rendered as an absolute date in the Details section. */
    createdAt?: number;
    /** Files carried by this drive. Rendered as an inline list for
     *  folders in every state; hidden for single-file drives. */
    files?: ShareQrModalInfoFile[];
    /** Sum of file sizes. Passed in (not recomputed) to match what the
     * card shows. */
    totalBytes?: number;
    /** Rendered directly in Share info. Zero is a valid, visible value. */
    peerCount?: number;
    /** "hosted" → Source: "Created by me". "received" → "Received". */
    origin?: "hosted" | "received";
    /** Human file-type label ("Mp4 Video", "Jpg Photo") — only meaningful
     *  for single-file drives. Callers set null for folders so the row
     *  is skipped. */
    typeLabel?: string | null;
    /** True while bytes are actively moving to a peer. Lights the header
     *  status chip on folders as "Sharing" (amber) instead of the plain
     *  "Active" green. */
    transferring?: boolean;
  };
};

function formatStatus(s?: "live" | "dormant" | "failed") {
  if (s === "live") return "Active";
  if (s === "dormant") return "Inactive";
  if (s === "failed") return "Couldn't restore";
  return null;
}

export default function ShareQrModal({
  visible,
  link,
  title,
  header,
  isActive,
  onClose,
  onCopy,
  onRemove,
  onActivate,
  info,
}: ShareQrModalProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  // Top inset: safe-area (status bar) + a fixed 24 breathing gap so the
  // card floats clear of the top edge of the app instead of butting up
  // against the status bar / notch.
  const topInset = insets.top + 24;
  // BottomToolbar footprint clearance so the card never overlaps the
  // floating Send / Receive / Settings toolbar.
  const bottomToolbarClearance = insets.bottom + 20 + 84 + 12;
  const styles = useMemo(
    () => createStyles(theme, topInset, bottomToolbarClearance),
    [theme, topInset, bottomToolbarClearance],
  );
  const [confirming, setConfirming] = useState(false);
  // Absolutely positioned so it can never eat into the ScrollView's flex
  // allocation — the RN flex + ScrollView interaction overlaps the last
  // section otherwise. Its measured height sets the scroll body's
  // paddingBottom so content clears the pinned buttons.
  const [actionsHeight, setActionsHeight] = useState(0);

  const statusLabel = formatStatus(info?.status);
  const statusColor =
    info?.status === "live"
      ? theme.primary
      : info?.status === "failed"
        ? theme.danger
        : theme.muted;
  const addedLabel = formatAbsoluteDate(info?.createdAt);
  const sizeLabel =
    info?.totalBytes != null && info.totalBytes > 0
      ? formatBytes(info.totalBytes)
      : null;
  const peerCount = info?.peerCount ?? 0;
  const origin = info?.origin;
  const sourceLabel =
    origin === "received"
      ? "Received"
      : origin === "hosted"
        ? "Created by me"
        : null;
  const typeLabel = info?.typeLabel ?? null;
  const isBundle = !!header?.isBundle;
  const transferring = !!info?.transferring;

  // Header status chip — Active / Sharing / Not active. Only surfaced on
  // folders (per polish: single-file rows carry their type on the subline
  // already and the Share info section duplicates the status text).
  const chipLabel = transferring
    ? "Sharing"
    : isActive
      ? "Active"
      : "Not active";
  const chipColor = transferring
    ? theme.warning
    : isActive
      ? theme.primary
      : theme.muted;

  const headerVideoThumb = useVideoThumbnail(
    header?.previewUri ? null : header?.videoUri ?? null,
  );
  const headerThumbUri = header?.previewUri ?? headerVideoThumb;

  const onPressRemove = () => {
    if (!onRemove) return;
    setConfirming(true);
  };

  const onConfirmRemove = () => {
    setConfirming(false);
    if (!onRemove) return;
    onRemove();
    // Parent unmounts modal as part of teardown; close defensively.
    onClose();
  };

  const defaultTitle = isBundle ? "Folder info" : "File info";
  const headerTitle = title ?? defaultTitle;

  const hasLink = link.length > 0;

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
          accessibilityLabel="Close"
        >
          <Pressable
            style={styles.card}
            onPress={() => {
              // Absorb inner taps so tapping the card doesn't close it.
            }}
          >
            {/* Pinned header: title bar + item identity. Consistent
              *  across every state (folder/file × active/inactive). */}
            <View style={styles.titleRow}>
              <View style={styles.titleSlot} />
              <Text style={styles.title} numberOfLines={1}>
                {headerTitle}
              </Text>
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

            {header ? (
              <View style={styles.itemHeader}>
                <View style={styles.itemThumb}>
                  {headerThumbUri ? (
                    <Image
                      source={{ uri: headerThumbUri }}
                      style={styles.itemThumbImage}
                      resizeMode="cover"
                    />
                  ) : isBundle ? (
                    // Unified folder treatment — same outline glyph +
                    // brand green as every other folder surface.
                    <Ionicons
                      name="folder-outline"
                      size={26}
                      color={theme.primary}
                    />
                  ) : (
                    <Ionicons
                      name={header.iconName}
                      size={24}
                      color={theme.text}
                    />
                  )}
                </View>
                <View style={styles.itemHeaderMain}>
                  <Text style={styles.itemName} numberOfLines={1}>
                    {header.name}
                  </Text>
                  {header.subline ? (
                    <Text style={styles.itemSubline} numberOfLines={1}>
                      {header.subline}
                    </Text>
                  ) : null}
                  {isBundle ? (
                    <View
                      style={[
                        styles.statusChip,
                        { borderColor: chipColor },
                      ]}
                    >
                      <View
                        style={[
                          styles.statusChipDot,
                          { backgroundColor: chipColor },
                        ]}
                      />
                      <Text
                        style={[
                          styles.statusChipText,
                          { color: chipColor },
                        ]}
                      >
                        {chipLabel}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Scrolling middle: QR + Details + Share info + Files. */}
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[
                styles.body,
                // Reserve exactly the actions row's height + a small
                // margin so the last section (Share info / Files) is
                // always visible above the pinned buttons.
                { paddingBottom: actionsHeight + 12 },
              ]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* QR + link block is rendered for both files and folders.
                *  Active drives show the live QR; inactive drives show
                *  the same-sized placeholder tile so the modal footprint
                *  stays consistent across states. */}
              {isActive && hasLink ? (
                <View style={styles.qrBlock}>
                  <View style={styles.qrWrap}>
                    <QRCode
                      value={link}
                      size={QR_SIZE}
                      backgroundColor="#ffffff"
                      color="#000000"
                      ecl="M"
                    />
                  </View>
                  <Text
                    style={styles.linkText}
                    numberOfLines={2}
                    selectable
                  >
                    {link}
                  </Text>
                </View>
              ) : (
                <View style={styles.qrBlock}>
                  <View
                    style={styles.hintTile}
                    accessibilityLabel="Not currently sharing"
                  >
                    <Ionicons
                      name="link-outline"
                      size={64}
                      color={theme.muted}
                    />
                    <Text style={styles.hintTileTitle}>
                      Not currently sharing
                    </Text>
                  </View>
                  <Text style={styles.hintBody}>
                    Start sharing to generate a link and QR you can hand
                    to another pear.
                  </Text>
                </View>
              )}

              <View style={styles.section}>
                <Text style={styles.sectionLabel}>Details</Text>
                {sizeLabel ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Size</Text>
                    <Text style={styles.infoRowValue}>{sizeLabel}</Text>
                  </View>
                ) : null}
                {typeLabel && !isBundle ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Type</Text>
                    <Text style={styles.infoRowValue}>{typeLabel}</Text>
                  </View>
                ) : null}
                {addedLabel ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Added</Text>
                    <Text style={styles.infoRowValue}>{addedLabel}</Text>
                  </View>
                ) : null}
              </View>

              {/* Share info section is single-file only — folders carry
                *  their live/dormant/transferring signal via the header
                *  status chip and don't need a duplicated row block. */}
              {!isBundle ? (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Share info</Text>
                  {statusLabel ? (
                    <View style={styles.infoRow}>
                      <Text style={styles.infoRowLabel}>Status</Text>
                      <View style={styles.infoStatusValue}>
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: statusColor },
                          ]}
                        />
                        <Text
                          style={[
                            styles.infoRowValue,
                            { color: statusColor },
                          ]}
                        >
                          {statusLabel}
                        </Text>
                      </View>
                    </View>
                  ) : null}
                  {sourceLabel ? (
                    <View style={styles.infoRow}>
                      <Text style={styles.infoRowLabel}>Source</Text>
                      <Text style={styles.infoRowValue}>
                        {sourceLabel}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.infoRow}>
                    <Text style={styles.infoRowLabel}>Peers</Text>
                    <Text style={styles.infoRowValue}>{peerCount}</Text>
                  </View>
                </View>
              ) : null}

              {/* Files list retired — the folder-contents modal is the
                *  canonical surface for per-file browsing, and the
                *  folder more-info modal is intentionally trimmed to
                *  Details + status. */}
            </ScrollView>

            {/* Pinned actions: status-driven, single button set per row.
              *  Absolutely positioned at the bottom of the card so the
              *  ScrollView above is never squeezed by these buttons. */}
            <View
              style={styles.actions}
              onLayout={(e) =>
                setActionsHeight(e.nativeEvent.layout.height)
              }
            >
              {isActive ? (
                onCopy ? (
                  <Pressable
                    style={styles.primaryBtn}
                    onPress={onCopy}
                    accessibilityRole="button"
                    accessibilityLabel="Copy link"
                  >
                    <Ionicons
                      name="link-outline"
                      size={18}
                      color={theme.onPrimary}
                    />
                    <Text style={styles.primaryBtnText}>Copy Link</Text>
                  </Pressable>
                ) : null
              ) : (
                <>
                  {onActivate ? (
                    <Pressable
                      style={styles.startBtn}
                      onPress={onActivate}
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
                  ) : null}
                  {onRemove ? (
                    <Pressable
                      style={styles.removeBtn}
                      onPress={onPressRemove}
                      accessibilityRole="button"
                      accessibilityLabel="Remove"
                    >
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color={theme.danger}
                      />
                      <Text style={styles.removeBtnText}>Remove</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
      <ConfirmModal
        visible={confirming}
        title="Remove this share?"
        body="Removes the data from your device. Can't undo."
        confirmLabel="Remove"
        cancelLabel="Keep"
        tone="destructive"
        onCancel={() => setConfirming(false)}
        onConfirm={onConfirmRemove}
      />
    </Modal>
  );
}

function createStyles(
  theme: AppTheme,
  topInset: number,
  bottomClearance: number,
) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      // Horizontal centering only. Vertical layout is driven by the
      // explicit paddings below + card's flex:1, so justifyContent
      // must NOT be "center" — that collapses the card's flex growth
      // in some RN versions and lets the pinned actions overlap the
      // scrolling middle.
      alignItems: "center",
      paddingHorizontal: theme.pad,
      // Safe-area + breathing room above so the card never touches the
      // status bar / top edge of the app.
      paddingTop: topInset,
      // Reserve room at the bottom so the card never overlaps the
      // floating BottomToolbar (Send / Receive / Settings buttons).
      paddingBottom: bottomClearance,
    },
    // Card takes the full available vertical space (constrained by the
    // backdrop's paddings above). That gives every state — folder/file ×
    // active/inactive — the same modal footprint; only the middle
    // ScrollView content differs.
    card: {
      flex: 1,
      width: "100%",
      maxWidth: 420,
      borderRadius: 20,
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: theme.pad,
      gap: 12,
      // Clip children at the card boundary so scroll content can't
      // visually leak behind the pinned actions.
      overflow: "hidden",
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      // Pinned regions must not shrink — the scroll takes the slack.
      flexShrink: 0,
    },
    // Empty slot mirroring the close-circle so the title stays centered.
    titleSlot: { width: 28, height: 28 },
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
    itemHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flexShrink: 0,
    },
    itemThumb: {
      width: 52,
      height: 52,
      borderRadius: 14,
      backgroundColor: theme.cardStrong,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    itemThumbImage: { width: "100%", height: "100%" },
    itemHeaderMain: { flex: 1, minWidth: 0 },
    itemName: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "700",
    },
    itemSubline: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 2,
      fontWeight: "500",
    },
    // Compact pill sitting under the folder subline. Borrows the row's
    // color-coded tone (primary / warning / muted) for both the dot and
    // the outline so status reads at a glance from the modal header.
    statusChip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      marginTop: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
    },
    statusChipDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    statusChipText: {
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    // ScrollView occupies whatever the pinned regions leave over.
    // `minHeight: 0` is a defensive-flex-basis hint so RN never
    // grants the scroll a min-content height that would overlap
    // the actions below.
    scroll: { flex: 1, minHeight: 0 },
    // Trailing padding so the last section (Share info or Files)
    // isn't visually flush with the pinned actions row.
    body: { gap: 14, paddingBottom: 16 },
    qrBlock: {
      alignItems: "center",
      gap: 6,
    },
    qrWrap: {
      padding: 12,
      borderRadius: 12,
      backgroundColor: "#ffffff",
    },
    linkText: {
      color: theme.muted,
      fontSize: 12,
      textAlign: "center",
      paddingHorizontal: 8,
    },
    // Same-sized rounded tile as the QR wrap so the block stays visually
    // balanced whether the item is active or dormant. Painted with the
    // themed subtle-surface so it clearly reads as a placeholder rather
    // than a scannable code.
    hintTile: {
      width: QR_SIZE + 24,
      height: QR_SIZE + 24,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      paddingHorizontal: 16,
    },
    hintTileTitle: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "700",
      textAlign: "center",
    },
    hintBody: {
      color: theme.muted,
      fontSize: 12,
      textAlign: "center",
      paddingHorizontal: 8,
      lineHeight: 16,
    },
    section: {
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      gap: 8,
    },
    sectionLabel: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      marginBottom: 2,
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
    },
    infoRowLabel: {
      color: theme.muted,
      fontSize: 13,
    },
    infoRowValue: {
      color: theme.text,
      fontSize: 13,
      fontWeight: "500",
      flexShrink: 1,
      textAlign: "right",
    },
    infoStatusValue: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    // Actions row pinned at the bottom of the card via absolute
    // positioning. Using the card's own padding for left/right/bottom
    // so the buttons align with the rest of the card's chrome.
    actions: {
      gap: 8,
      position: "absolute",
      left: theme.pad,
      right: theme.pad,
      bottom: theme.pad,
      // Solid card background so any scrolling content behind the
      // buttons (during over-scroll) is cleanly masked.
      backgroundColor: theme.bg,
    },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderRadius: 14,
    },
    primaryBtnText: {
      color: theme.onPrimary,
      fontWeight: "700",
      fontSize: 15,
    },
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
    },
    startBtnText: {
      color: theme.primary,
      fontWeight: "600",
      fontSize: 13,
    },
    removeBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: theme.danger,
      backgroundColor: "transparent",
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    removeBtnText: {
      color: theme.danger,
      fontWeight: "600",
      fontSize: 13,
    },
  });
}
