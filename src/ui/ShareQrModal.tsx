import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppModal as Modal } from "./AppModal";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useScreenInsets } from "./useScreenInsets";
import QRCode from "react-native-qrcode-svg";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { formatAbsoluteDate, formatBytes } from "../lib/format";
import { type IconName } from "../lib/files";
import { useVideoThumbnail } from "../lib/videoThumbnail";
import ConfirmModal from "./ConfirmModal";
import CopyGlyph from "./CopyGlyph";
import { ToastOutlet } from "./Toast";

/** QR box side length. */
const QR_SIZE = 200;
/** How long the copy mark stays a tick after a copy. */
const COPIED_MS = 1500;

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
  /**
   * Which of its two faces this window shows.
   *
   * "share" is for handing the thing to someone: the QR code, the link under it, a button that
   * sends the link through the phone's own share sheet, and nothing about the file itself.
   *
   * "info" (the default) is about the file: a Copy link and a Show QR button, the link, then
   * Details and Share info. The QR code stays folded away until Show QR is pressed.
   */
  mode?: "share" | "info";
  /** Header title. Defaults to "File info" / "Folder info". */
  title?: string;
  /** Item identity block rendered directly under the title. */
  header?: ShareQrModalHeader;
  /** Whether the drive is currently seeding. Controls which action button
   *  set the modal renders at the bottom. */
  isActive?: boolean;
  /**
   * May this modal show the QR
   * and the Copy Link button at all?
   *
   * **Defaults to `isActive`, which is what it always used to be, and that was
   * wrong for received rows.** Boot hydration registers every received drive in
   * the engine's active set with no swarm attached, so `isActive` is true for a
   * copy this phone announces nothing about — and the modal rendered a live QR
   * and a Copy Link for a link no peer can resolve.
   *
   * The caller passes `mode === "server"` for a received row and
   * leaves this undefined for a hosted one, so hosted behaviour is byte-for-byte
   * unchanged. It gates ONLY the link surfaces; `isActive` still chooses which
   * action set the bottom bar shows, because that is a different question.
   */
  canOfferLink?: boolean;
  /**
   * Which half of the app this row belongs to.
   *
   * "hosted" (the default) keeps every word this modal has ever said. The
   * placeholder tile reads "Not currently sharing" and instructs the user to
   * Start sharing, and the Share-info block reports a seeding status — all
   * true of a share you created.
   *
   * "received" exists because none of that is true of a copy someone sent you,
   * and the modal was rendering it anyway: a received row reaches here through
   * `onTapRow`'s no-primary-file fallback, so a share with nothing downloaded
   * got a hosted panel telling it to Start sharing. The button behind that
   * instruction called `engineActivateDrive` with a synthetic `share:<key>` id
   * the engine cannot resolve, and answered with "Drive not found".
   *
   * The copy change is the point, not decoration: the old text tells the user
   * to do something the code cannot do.
   */
  presentation?: "hosted" | "received";
  onClose: () => void;
  /** Copy the link to the clipboard. The QR code, the link line and the
   *  Copy link button all call it. */
  onCopy?: () => void;
  /** Hand the link to the phone's share sheet (messages and the like).
   *  The "Send link" button of the share face; left out, no button. */
  onSendLink?: () => void;
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
  mode = "info",
  title,
  header,
  isActive,
  canOfferLink,
  presentation = "hosted",
  onClose,
  onCopy,
  onSendLink,
  onRemove,
  onActivate,
  info,
}: ShareQrModalProps) {
  const isReceivedPresentation = presentation === "received";
  const isShareMode = mode === "share";
  const { theme } = useAppTheme();
  const insets = useScreenInsets();
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
  /**
   * Clear the nested confirm when this sheet is closed, matching the
   * precedent at `FilePickerSheet.tsx:169-174`.
   *
   * Every *user* exit from `confirming` already clears it, so this only
   * covers a programmatic close with the confirm still up. Without it, the
   * re-open mounts both sheets' children in ONE commit — and because React
   * flushes a child's effects before a later sibling's, the nested
   * ConfirmModal would register its toast outlet BEFORE this sheet's,
   * inverting "last registered = innermost" and painting toasts in this
   * window underneath the confirm dialog.
   */
  useEffect(() => {
    if (!visible) setConfirming(false);
  }, [visible]);

  // The info face keeps its QR code folded away until asked for. Folded again
  // each time the window opens or turns to another share.
  const [qrOpen, setQrOpen] = useState(false);
  useEffect(() => {
    setQrOpen(false);
  }, [visible, link, mode]);

  // The copy mark turns into a tick for a moment after a copy, so the press
  // is answered where the finger is as well as by the toast.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!visible) setCopied(false);
  }, [visible]);
  const copyNow = () => {
    if (!onCopy) return;
    onCopy();
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

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

  const defaultTitle = isShareMode
    ? "Share"
    : isBundle
      ? "Folder info"
      : "File info";
  const headerTitle = title ?? defaultTitle;

  const hasLink = link.length > 0;
  /**
   * `?? isActive` rather than `|| isActive`: an explicit `false` from the
   * caller must win, and `||` would quietly fall back to `isActive` for
   * exactly the received rows this gate exists for.
   */
  const linkOfferable = (canOfferLink ?? isActive) === true;
  /** There is a link, and this row may hand it out. */
  const showLink = linkOfferable && hasLink;
  /**
   * Start sharing and Remove follow `isActive`; the link follows the link gate.
   * They agree on a hosted row. On a received row that is active but announces
   * nothing they differ, and the answer is no link and no Start sharing.
   */
  const showStartRemove = !linkOfferable && !isActive;

  const qrCode = (
    <Pressable
      style={styles.qrWrap}
      onPress={copyNow}
      disabled={!onCopy}
      accessibilityRole="button"
      accessibilityLabel="QR code. Tap to copy the link"
    >
      <QRCode
        value={link}
        size={QR_SIZE}
        backgroundColor="#ffffff"
        color="#000000"
        ecl="M"
      />
    </Pressable>
  );

  // The link on one line, cut in the middle so both ends can be told apart,
  // with the copy mark at its right. The whole line copies.
  const linkRow = (
    <Pressable
      style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
      onPress={copyNow}
      disabled={!onCopy}
      accessibilityRole="button"
      accessibilityLabel="Tap to copy the link"
    >
      <Text style={styles.linkRowText} numberOfLines={1} ellipsizeMode="middle">
        {link}
      </Text>
      <CopyGlyph
        size={20}
        color={copied ? theme.primary : theme.text}
        done={copied}
      />
    </Pressable>
  );

  const startRemove = showStartRemove ? (
    <View style={styles.stack}>
      {onActivate ? (
        <Pressable
          style={styles.startBtn}
          onPress={onActivate}
          accessibilityRole="button"
          accessibilityLabel="Start sharing"
        >
          <Ionicons name="share-outline" size={16} color={theme.primary} />
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
          <Ionicons name="trash-outline" size={16} color={theme.danger} />
          <Text style={styles.removeBtnText}>Remove</Text>
        </Pressable>
      ) : null}
    </View>
  ) : null;

  // Shown in place of the link when there is none to give.
  const noLinkNote = (
    <View
      style={styles.note}
      accessible
      accessibilityLabel={
        isReceivedPresentation ? "Received share" : "Not currently sharing"
      }
    >
      <Ionicons
        name={isReceivedPresentation ? "download" : "link"}
        size={22}
        color={theme.muted}
      />
      <View style={styles.noteMain}>
        <Text style={styles.noteTitle}>
          {isReceivedPresentation ? "Received share" : "Not currently sharing"}
        </Text>
        <Text style={styles.noteBody}>
          {isReceivedPresentation
            ? "A copy someone sent you. There's no link to hand on from here."
            : "Start sharing to generate a link and QR you can hand to another pear."}
        </Text>
      </View>
    </View>
  );

  const shareFace = showLink ? (
    <>
      <View style={styles.qrBlock}>{qrCode}</View>
      {linkRow}
      {onSendLink ? (
        <Pressable
          style={styles.primaryBtn}
          onPress={onSendLink}
          accessibilityRole="button"
          accessibilityLabel="Send link"
        >
          <Ionicons name="paper-plane" size={17} color={theme.onPrimary} />
          <Text style={styles.primaryBtnText}>Send link</Text>
        </Pressable>
      ) : null}
    </>
  ) : (
    <>
      {noLinkNote}
      {startRemove}
    </>
  );

  const infoFace = (
    <>
      {showLink ? (
        <>
          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.primaryBtn, styles.buttonRowItem]}
              onPress={copyNow}
              disabled={!onCopy}
              accessibilityRole="button"
              accessibilityLabel="Copy link"
            >
              <CopyGlyph size={18} color={theme.onPrimary} done={copied} />
              <Text style={styles.primaryBtnText}>Copy link</Text>
            </Pressable>
            <Pressable
              style={[styles.outlineBtn, styles.buttonRowItem]}
              onPress={() => setQrOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel={qrOpen ? "Hide QR" : "Show QR"}
              accessibilityState={{ expanded: qrOpen }}
            >
              <Ionicons name="qr-code" size={17} color={theme.text} />
              <Text style={styles.outlineBtnText}>
                {qrOpen ? "Hide QR" : "Show QR"}
              </Text>
            </Pressable>
          </View>
          {qrOpen ? <View style={styles.qrBlock}>{qrCode}</View> : null}
          {linkRow}
        </>
      ) : (
        <>
          {noLinkNote}
          {startRemove}
        </>
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
          {/* Status and Peers are suppressed on a
            *  received row. Both describe seeding. A received synth row
            *  has the id `share:<shareKey>`, which is never in
            *  `activeDriveIds` and never a key in `transferByDriveId`,
            *  so Status was a hardcoded "Inactive" and Peers a
            *  hardcoded 0 — two fields that could not vary presented as
            *  if they were readings. Source stays; it is the one row
            *  here that says something true about a received copy. */}
          {statusLabel && !isReceivedPresentation ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoRowLabel}>Status</Text>
              <View style={styles.infoStatusValue}>
                <View
                  style={[styles.statusDot, { backgroundColor: statusColor }]}
                />
                <Text style={[styles.infoRowValue, { color: statusColor }]}>
                  {statusLabel}
                </Text>
              </View>
            </View>
          ) : null}
          {sourceLabel ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoRowLabel}>Source</Text>
              <Text style={styles.infoRowValue}>{sourceLabel}</Text>
            </View>
          ) : null}
          {!isReceivedPresentation ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoRowLabel}>Peers</Text>
              <Text style={styles.infoRowValue}>{peerCount}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.screen}>
        {/* The dimmed area that closes the window is a SIBLING of the card,
            never its parent. Two things broke while pressables wrapped the
            card. On iPhone the scroll area would not scroll when the finger
            went down on a plain part of it (a line of text, the QR picture):
            the pressable round it took the finger, and iOS will not scroll
            an area that sits inside whatever holds the finger. And a
            pressable makes everything inside it one element for VoiceOver
            and for the test robot. See _publishing/lessons. */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.frame} pointerEvents="box-none">
          {/* A plain View on purpose (see above): nothing round the scroll
              area may take the finger, Pressable or onStartShouldSetResponder. */}
          <View style={styles.card}>
            <View style={styles.titleRow}>
              <View style={styles.titleSlot} />
              <Text
                style={styles.title}
                numberOfLines={1}
                accessibilityRole="header"
              >
                {headerTitle}
              </Text>
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
                      style={[styles.statusChip, { borderColor: chipColor }]}
                    >
                      <View
                        style={[
                          styles.statusChipDot,
                          { backgroundColor: chipColor },
                        ]}
                      />
                      <Text
                        style={[styles.statusChipText, { color: chipColor }]}
                      >
                        {chipLabel}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Everything under the header scrolls as one piece. The card is
                as tall as what is in it, up to the room on the screen; past
                that this area shrinks and scrolls. */}
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.body}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {isShareMode ? shareFace : infoFace}
            </ScrollView>

            {isShareMode ? (
              <Pressable
                style={styles.doneBtn}
                onPress={onClose}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Done"
              >
                <Text style={styles.doneBtnText}>Done</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
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
      {/* last child on purpose: this Modal is its own Android window,
          and a root-level toast would be painted under it (and untappable).
          While this sheet is open its outlet is the last registered, so it
          owns the toast; it unregisters on close and the root takes over.
          See src/lib/toastOutletSelect.ts. */}
      {visible && <ToastOutlet />}
    </Modal>
  );
}

function createStyles(
  theme: AppTheme,
  topInset: number,
  bottomClearance: number,
) {
  return StyleSheet.create({
    screen: { flex: 1 },
    // Behind the card, edge to edge. A press on it closes the window.
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.scrim,
    },
    // Where the card may be: clear of the status bar above and of the
    // floating Send / Receive / Settings toolbar below. It takes no presses
    // itself (`box-none`), so the dimmed area around the card still closes.
    frame: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.pad,
      paddingTop: topInset,
      paddingBottom: bottomClearance,
    },
    // As tall as what is in it, and no taller than the frame: `flexShrink`
    // lets it give way, and the scroll area inside takes the squeeze.
    card: {
      flexShrink: 1,
      width: "100%",
      maxWidth: 420,
      borderRadius: 20,
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: theme.pad,
      gap: 12,
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
      backgroundColor: theme.tabBadgeBg,
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
    // Compact pill under the folder subline. Dot and outline share the row's
    // tone, so status reads at a glance from the modal header.
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
    // No taller than its content, and the one piece of the card that
    // shrinks when the card runs out of screen.
    scroll: { flexGrow: 0, flexShrink: 1 },
    body: { gap: 14 },
    qrBlock: { alignItems: "center" },
    qrWrap: {
      padding: 12,
      borderRadius: 12,
      backgroundColor: "#ffffff",
    },
    // The link on one line with the copy mark at its right.
    linkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    linkRowPressed: { backgroundColor: theme.cardStrong },
    linkRowText: {
      flex: 1,
      minWidth: 0,
      color: theme.muted,
      fontSize: 13,
      fontWeight: "500",
    },
    // In place of the link when there is none to give.
    note: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      padding: 14,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    noteMain: { flex: 1, minWidth: 0, gap: 3 },
    noteTitle: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "700",
    },
    noteBody: {
      color: theme.muted,
      fontSize: 12,
      lineHeight: 16,
    },
    stack: { gap: 8 },
    buttonRow: { flexDirection: "row", gap: 10 },
    buttonRowItem: { flex: 1, paddingHorizontal: 10 },
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
    outlineBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      paddingHorizontal: 16,
      paddingVertical: 13,
      borderRadius: 14,
    },
    outlineBtnText: {
      color: theme.text,
      fontWeight: "700",
      fontSize: 15,
    },
    // Quiet, under the scroll area of the share face.
    doneBtn: {
      alignSelf: "center",
      paddingHorizontal: 24,
      paddingVertical: 8,
    },
    doneBtnText: {
      color: theme.muted,
      fontWeight: "600",
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
