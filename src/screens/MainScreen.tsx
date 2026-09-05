import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Linking,
  ListRenderItem,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystemLegacy from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import RNFS from "react-native-fs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { log as debugLog, logStructuredError } from "../lib/debugLog";
import { ensurePermission as ensureNotificationPermission } from "../lib/notifications";

import {
  pickFolder,
  enumerateFolder,
  materializeUriToCache,
  FolderTooLargeError,
} from "../lib/folderShare";
import { useAppTheme } from "../state/ThemeContext";
import { useBackend } from "../state/backend";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import type { DriveLocalFile, DriveRecord } from "../state/types";
import type { AppTheme } from "../ui/themes";
import {
  baseName,
  bundleIconName,
  fileIconName,
  humanFileType,
  mimeFromName,
  previewModeFor,
  truncateMiddle,
  type IconName,
  type PreviewMode,
} from "../lib/files";
import {
  loadSharedFilePaths,
  removeSharedFilePaths,
  saveSharedFilePathsEntry,
  subscribeSharedFilePaths,
  type SharedFilePath,
  type SharedFilePathsEntry,
} from "../state/sharedFilePathsStorage";
import {
  deleteShare,
  loadShares,
  setShareFavorite,
  setSharePinned,
  subscribeShares,
  type ReceivedShare,
} from "../state/receivedSharesStorage";
import {
  clearHostedShareFlags,
  loadHostedFlags,
  setHostedShareCustomName,
  setHostedShareFavorite,
  setHostedSharePinned,
  subscribeHostedFlags,
  type HostedShareFlags,
} from "../state/hostedShareFlagsStorage";
import { formatBytes, formatClock, formatRelativeOrDate } from "../lib/format";
import {
  classifyPickerResult,
  isPickerCancellation,
  mapImageAssets,
  pickerExitPlan,
  type PickerOutcome,
} from "../lib/pickerResult";
import {
  getPickerBackHintSeen,
  setPickerBackHintSeen,
} from "../state/pickerHintStorage";
import {
  partitionForMaterialization,
  toPickedFiles,
  type BrowseEntry,
} from "../lib/fileBrowse";
import { errorMessage } from "../lib/errorMessage";
import { haptics } from "../lib/haptics";
import { useToast } from "../ui/Toast";
import ShareQrModal from "../ui/ShareQrModal";
import ConfirmModal from "../ui/ConfirmModal";
import SwipeableRow from "../ui/SwipeableRow";
import { type ActiveIndicatorState } from "../ui/ActiveIndicator";
import EmptyState from "../ui/EmptyState";
import KebabActionSheet, { type KebabActionItem } from "../ui/KebabActionSheet";
import TopTabs from "../ui/TopTabs";
import ListToolbar, { type FilterId, type SortId } from "../ui/ListToolbar";
import BottomToolbar from "../ui/BottomToolbar";
import ReceiveSheet from "../ui/ReceiveSheet";
import ShareRow, { type ShareRowStatus } from "../ui/ShareRow";
import SendSheet, { type RecentShareItem } from "../ui/SendSheet";
import FolderContentsModal, {
  type FolderContentsFile,
} from "../ui/FolderContentsModal";
import NameShareModal from "../ui/NameShareModal";
import FilePickerSheet from "../ui/FilePickerSheet";

// Enable LayoutAnimation on Android. Standard one-shot init; the
// flag is no-op on iOS where LayoutAnimation works out of the box. Must
// run after the import block so `import/first` doesn't flag it.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type DriveRow = DriveRecord & {
  /** Computed: the file used when tapping a single-file row opens a preview.
   *  Undefined for multi-file bundles (which expand instead). */
  primaryFile?: DriveLocalFile;
  /** True when files.length > 1. Bundles expand on tap; single files preview. */
  isBundle?: boolean;
  /** Present for synthesized received-share rows. When set, the
   *  list-flattening logic reads child file states from here (with isDownloaded
   *  flags) instead of from the engine's `files` + `localFiles` join. */
  share?: ReceivedShare;
  /** Organizational flags. Sourced from the share's own record
   *  (received) or from hostedShareFlagsStorage (hosted). */
  isPinned?: boolean;
  isFavorite?: boolean;
};

/** Flattened list item — drives the FlatList. Bundles do not expand
 *  inline; folder contents open in FolderContentsModal instead. Kept the
 *  ListItem discriminated shape so the renderer signature stays stable. */
type ListItem = { kind: "drive"; drive: DriveRow };
/** File descriptor used to build the folder-contents modal's row list. */
type FolderModalChild = {
  parentId: string;
  indexInBundle: number;
  name: string;
  size?: number;
  localPath?: string;
  isMissing?: boolean;
  shareKey?: string;
  shareLink?: string;
};

type PreviewState = {
  file: DriveLocalFile;
  mode: PreviewMode;
  /** Parent drive id (or share synth id) so the preview's
   *  three-dots menu can route "Show QR" back to the right drive record. */
  parentDriveId?: string;
};

type PickerSheet = "share-files" | null;
type KebabSheet = { drive: DriveRow } | null;

function selectFiles(res: DocumentPicker.DocumentPickerResult): { name: string; size?: number; uri: string }[] {
  if (res.canceled) return [];
  const assets = "assets" in res ? res.assets : undefined;
  if (!assets?.length) return [];
  return assets
    .filter((a) => !!a.uri)
    .map((a) => ({
      name: a.name || a.uri.split("/").pop() || "file",
      size: a.size ?? undefined,
      uri: a.uri,
    }));
}

function rowPrimaryFile(d: DriveRecord): DriveLocalFile | undefined {
  if (Array.isArray(d.localFiles) && d.localFiles.length === 1) return d.localFiles[0];
  // For multi-file drives there is no single "primary" file — expansion
  // surfaces each one as its own child row.
  return undefined;
}

// Folder-share materialization uses the user's original filename (potentially
// with spaces or unicode) inside the cache filename. The URI returned by
// expo-file-system is URL-encoded — RNFS / bare-fs need the decoded form.
// Picker URIs don't trip this because their cache names are auto-generated.
function normalizeLocalPath(uri: string): string {
  let p = String(uri || "");
  if (p.startsWith("file://")) {
    p = p.slice(7);
    if (p.startsWith("//")) p = p.slice(1);
  }
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

// Match "uuid.ext" or "uuid" — so received shares whose filenames are
// synthesized as UUIDs by the peer don't display the raw hex to the user.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)?$/i;

function isUuidLikeName(name: string): boolean {
  return UUID_RE.test(name.trim());
}

function typeLabelForFile(name: string): string {
  const mode = previewModeFor(name);
  if (mode === "image") return "Shared photo";
  if (mode === "video") return "Shared video";
  if (mode === "audio") return "Shared audio";
  if (mode === "text") return "Shared document";
  return "Shared file";
}

function rowDisplayName(d: DriveRecord): string {
  const files = d.files ?? [];
  if (files.length === 1) {
    const raw = files[0]?.name?.trim();
    if (raw && !isUuidLikeName(baseName(raw))) {
      return truncateMiddle(baseName(raw), 32);
    }
    // Falls through when the only filename is UUID-shaped — use the drive's
    // own name if we have one, else a friendly type label.
    if (d.name && d.name.trim().length > 0 && !isUuidLikeName(d.name.trim())) {
      return truncateMiddle(d.name, 32);
    }
    if (raw) return typeLabelForFile(raw);
  }
  if (d.name && d.name.trim().length > 0 && !isUuidLikeName(d.name.trim())) {
    return truncateMiddle(d.name, 32);
  }
  return files.length > 0 ? `${files.length} files` : "Share";
}

function totalBytesOf(d: DriveRecord): number {
  if (typeof d.totalBytes === "number" && d.totalBytes > 0) return d.totalBytes;
  return (d.files ?? []).reduce((sum, f) => sum + (f.size ?? 0), 0);
}

function isOpenableInOtherApp(d: DriveRecord): boolean {
  return Array.isArray(d.localFiles) && d.localFiles.length > 0;
}

function driveIconName(d: DriveRecord): IconName {
  if ((d.files?.length ?? 0) > 1) return bundleIconName();
  const single = d.files?.[0]?.name ?? d.localFiles?.[0]?.name ?? d.name ?? "";
  return fileIconName(single);
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    // Multi-select header: replaces TopTabs + ListToolbar while active.
    selectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.pad,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    selectionHeaderBtn: { minWidth: 60 },
    selectionHeaderCancel: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "500",
    },
    selectionHeaderCount: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
    },
    selectionHeaderDelete: {
      color: theme.danger,
      fontSize: 15,
      fontWeight: "700",
      textAlign: "right",
    },
    selectionHeaderDeleteDisabled: { opacity: 0.4 },
    listFlex: { flex: 1, minHeight: 0 },
    list: { flex: 1 },
    listContent: { paddingBottom: 12 },
    listContentEmpty: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: theme.pad,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      position: "relative",
    },
    fileRowFirst: { borderTopWidth: 0 },
    fileRowDim: { opacity: 0.85 },
    iconWrap: { width: 28, alignItems: "center", justifyContent: "center", position: "relative" },
    iconText: { fontSize: 20, textAlign: "center" },
    stateDot: {
      position: "absolute",
      bottom: -2,
      right: -2,
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: theme.primary,
      borderWidth: 1.5,
      borderColor: theme.bg,
    },
    rowMain: { flex: 1, minWidth: 0 },
    // Name + optional pin marker side-by-side. Text shrinks
    // (numberOfLines={1}) and the pin icon stays anchored at the end.
    rowNameLine: { flexDirection: "row", alignItems: "center", minWidth: 0 },
    rowName: { color: theme.text, fontSize: 14, fontWeight: "500", flexShrink: 1 },
    rowPinMark: { marginLeft: 6 },
    rowMeta: { color: theme.muted, fontSize: 12, marginTop: 3 },
    kebabBtn: { paddingHorizontal: 6, paddingVertical: 8 },
    chevronBtn: {
      paddingHorizontal: 2,
      paddingVertical: 4,
      alignItems: "center",
      justifyContent: "center",
    },
    // Child row (file inside an expanded bundle).
    childRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: theme.pad,
      paddingLeft: theme.pad + 28, // indent: aligns child icon under bundle name
      backgroundColor: theme.surfaceSubtle,
      position: "relative",
    },
    // Subtle vertical line on the left edge of the children block, linking
    // them visually to the parent bundle row.
    childAccent: {
      position: "absolute",
      left: theme.pad + 12,
      top: 0,
      bottom: 0,
      width: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    childIconWrap: { width: 22, alignItems: "center", justifyContent: "center" },
    childMain: { flex: 1, minWidth: 0 },
    childName: { color: theme.text, fontSize: 13, fontWeight: "500" },
    childMeta: { color: theme.muted, fontSize: 11, marginTop: 2 },
    childOpenBtn: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    transferBar: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 2,
      backgroundColor: theme.primary,
    },
    previewBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      padding: 12,
    },
    previewCard: {
      maxHeight: "92%",
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      padding: 14,
      gap: 10,
    },
    previewTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    previewTitle: { color: theme.text, fontWeight: "700", fontSize: 16, flex: 1 },
    previewImage: { width: "100%", height: 360, borderRadius: 12, backgroundColor: theme.surfaceSubtle },
    previewVideo: { width: "100%", height: 360, borderRadius: 12, backgroundColor: "#000" },
    previewText: { color: theme.text, fontSize: 13, lineHeight: 20 },
    previewBtn: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: theme.border,
      minWidth: 88,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    previewBtnText: { color: theme.text, fontWeight: "700", fontSize: 12 },
    previewFooter: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    audioShell: {
      gap: 10,
      paddingTop: 4,
    },
    // Square cover placeholder keeps the audio modal's shape consistent
    // with image/video previews even when there's no album art to show.
    audioCover: {
      width: "100%",
      height: 220,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
    },
    audioMeta: { color: theme.text, fontSize: 14, fontWeight: "600", textAlign: "center" },
    audioControlsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 28,
      marginTop: 4,
    },
    audioCtrlBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    audioPlayBtn: {
      width: 60,
      height: 60,
      borderRadius: 30,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.primary,
    },
    audioScrubber: { height: 28, justifyContent: "center" },
    audioScrubberTrack: {
      height: 6,
      borderRadius: 999,
      backgroundColor: theme.surfaceSubtle,
      overflow: "hidden",
    },
    audioScrubberFill: { height: "100%", backgroundColor: theme.primary },
    audioTimeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    audioTimeText: { color: theme.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
    // Fullscreen takeover styles. Pure black background,
    // chrome floats over the media via absolute positioning.
    fsRoot: { flex: 1, backgroundColor: "#000" },
    fsMediaWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
    fsVideo: { width: "100%", height: "100%" },
    fsImage: { width: "100%", height: "100%" },
    // Tap-surface that toggles play/pause + chrome. Sits over the video,
    // below the chrome icons (z-order: video → tap layer → chrome).
    fsTapLayer: { ...StyleSheet.absoluteFillObject as object },
    fsTopBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      // Extra horizontal padding so the back arrow sits inboard,
      // not flush with the screen edge. Top inset added at render-time
      // via useSafeAreaInsets so the icon clears the status bar.
      paddingHorizontal: 12,
      paddingBottom: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-start",
      backgroundColor: "rgba(0,0,0,0.45)",
      // Make sure the chrome paints above the tap-layer regardless of any
      // child elevation quirks.
      zIndex: 10,
    },
    fsTopBtn: {
      // Bigger touch target — 48 with extra
      // visual padding so the icon doesn't sit hard against the edge.
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
    },
    fsShareBtnRow: {
      flexDirection: "row",
      justifyContent: "center",
      marginTop: 12,
    },
    fsShareBtn: {
      // Fixed width so "Share it" and "Stop sharing" don't
      // visually shift in size when toggled. Width chosen to comfortably
      // fit the longer label ("Stop sharing") with breathing room.
      width: 200,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 11,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.10)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.20)",
    },
    fsShareBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
    fsBottomBar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 18,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    fsScrubber: { height: 28, justifyContent: "center" },
    fsScrubberTrack: {
      height: 4,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.25)",
      overflow: "hidden",
    },
    fsScrubberFill: { height: "100%", backgroundColor: "#fff" },
    fsTimeRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 6,
    },
    fsTimeText: {
      color: "rgba(255,255,255,0.85)",
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    fsCenterPlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    fsCenterPlayBtn: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: "rgba(0,0,0,0.45)",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.35)",
    },
    // Audio takeover: centered cover + controls below. No auto-hide.
    fsAudioShell: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      gap: 18,
    },
    fsAudioCover: {
      width: "60%",
      aspectRatio: 1,
      maxWidth: 320,
      borderRadius: 16,
      backgroundColor: "rgba(255,255,255,0.05)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.12)",
      alignItems: "center",
      justifyContent: "center",
    },
    fsAudioMeta: { color: "rgba(255,255,255,0.92)", fontSize: 15, fontWeight: "600" },
    fsAudioControlsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 28,
      marginTop: 4,
    },
    fsAudioCtrlBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.08)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.18)",
    },
    fsAudioPlayBtn: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#fff",
    },
    fsAudioScrubberRow: { alignSelf: "stretch", marginTop: 12 },
    // Text takeover uses theme.bg for readability rather than pure black.
    fsTextRoot: { flex: 1, backgroundColor: theme.bg },
    fsTextScroll: { flex: 1, paddingHorizontal: 20, paddingTop: 64 },
    fsTextBody: { color: theme.text, fontSize: 14, lineHeight: 22 },
    // Three-dots action sheet — reuses the bottom-sheet pattern.
    fsMenuBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    fsMenuSheet: {
      backgroundColor: theme.bg,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
  });
}

export default function MainScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const navigation = useNavigation<any>();

  const {
    ready,
    drives,
    transfers,
    activeDriveIds,
    failedHydrationIds,
    sharePaths,
    cancelTransfer,
    activateDrive,
    deactivateDrive,
    refreshDrives,
  } = useBackend();

  const {
    linkDraft,
    setLinkDraft,
    resolving,
    linkError,
    retryResolve,
    setPendingPreselection,
    abortResolving,
    lastCompletedDownload,
    consumeCompletedDownload,
    manualEntryTick,
    resolveFromScan,
  } = useShareLinkFlow();

  const { show: showToastRaw } = useToast();
  const showToast = useCallback(
    (msg: string, kind: "info" | "success" | "error" = "info") =>
      showToastRaw(msg, { kind }),
    [showToastRaw],
  );

  const [pickerSheet, setPickerSheet] = useState<PickerSheet>(null);

  // The first time the user opens a
  // picker and backs out without selecting anything, show a one-time
  // educational toast. Some Android pickers (Google Drive especially) don't
  // expose an obvious back button — users got stuck repeatedly. We can't add
  // UI to the OS picker itself, but we can teach the gesture once on return.
  // Flag persisted in AsyncStorage so it never fires again after the first
  // appearance; Settings → "Show picker hint again" resets it.
  const maybeShowPickerBackHint = useCallback(() => {
    void getPickerBackHintSeen().then((seen) => {
      if (seen) return;
      void setPickerBackHintSeen(true);
      showToast("Tap back or swipe from the edge to return next time.", "info");
    });
  }, [showToast]);

  // The single exit path for every non-selected picker outcome.
  // Restores the Send sheet the picker was launched from so a cancel lands
  // the user exactly where they were, emits at most one plain toast, and
  // never falls through into share creation. Decision logic lives in
  // `lib/pickerResult` so it's testable without the native picker.
  const handlePickerExit = useCallback(
    (outcome: PickerOutcome, labels: { empty: string }) => {
      // Every non-selected pick outcome funnels through
      // here, so one line covers cancel/empty across all four picker
      // entry points (files, folder, photos, in-app).
      debugLog("info", "rn.pick", `picker exit: ${outcome.kind}`);
      const plan = pickerExitPlan(outcome, labels);
      if (plan.reopenSendSheet) setPickerSheet("share-files");
      if (plan.toast) showToast(plan.toast);
      if (plan.showBackHint) maybeShowPickerBackHint();
    },
    [showToast, maybeShowPickerBackHint],
  );

  // PearDrop's own file-selection screen. Primary path for
  // "Files"; the OS document picker is now the escape hatch behind it.
  const [inAppPickerOpen, setInAppPickerOpen] = useState(false);
  const [inAppPickerBusy, setInAppPickerBusy] = useState(false);

  const [kebabSheet, setKebabSheet] = useState<KebabSheet>(null);
  // Multi-file share: after the OS picker returns >1 asset, we park the
  // selection here and open NameShareModal. The user's confirmed name is
  // written into hostedShareFlagsStorage the moment we get a driveId back
  // from sharePaths, so the list card + File info modal read it back as
  // the drive title.
  type PendingNameShare = {
    kind: "files" | "photos";
    defaultName: string;
    files: { uri: string; name: string; size?: number }[];
  };
  const [pendingNameShare, setPendingNameShare] =
    useState<PendingNameShare | null>(null);
  // No shareBusy state: the pickers can't
  // be double-fired because they're modals. If a future spinner needs it
  // back, reintroduce here and thread through BottomToolbar's Send button.
  const setShareBusy = (_v: boolean) => {};
  const [qrDriveId, setQrDriveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewText, setPreviewText] = useState("");
  // Themed delete confirmation. Holds the drive pending deletion or null.
  // Replaces the native Alert.alert so the dialog matches the app theme.
  const [pendingDelete, setPendingDelete] = useState<DriveRow | null>(null);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [scrubWidth, setScrubWidth] = useState(0);
  // Fullscreen takeover preview state.
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [videoPosition, setVideoPosition] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoScrubWidth, setVideoScrubWidth] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const chromeHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drive IDs hidden from the UI because the user just confirmed delete —
  // engine purge is in-flight. Removed from the set once the engine's
  // drives list no longer contains the ID (refreshDrives caught up).
  const [optimisticallyDeleted, setOptimisticallyDeleted] = useState<Set<string>>(
    () => new Set(),
  );
  // Bumps every time a swipe-then-confirm flow opens — triggers SwipeableRow
  // to snap closed whether the user confirms or cancels.
  const [swipeCloseTick, setSwipeCloseTick] = useState(0);
  // Folder modal: tapping a bundle (or its chevron) opens a modal
  // showing the folder's contents. Replaced the earlier inline dropdown
  // expansion — the driveId here is whichever folder is currently open,
  // or null when the modal is dismissed.
  const [folderModalId, setFolderModalId] = useState<string | null>(null);
  const [sharedPaths, setSharedPaths] = useState<SharedFilePathsEntry[]>([]);
  const [receivedShares, setReceivedShares] = useState<ReceivedShare[]>([]);
  const [hostedFlags, setHostedFlags] = useState<HostedShareFlags[]>([]);
  // View-mode toggle. Always resets to "all" on mount — intentional;
  // no persistence to AsyncStorage. Favorites is a filterable subset.
  const [viewMode, setViewMode] = useState<"all" | "favorites">("all");
  // Shell state: search + filter + sort applied on top of viewMode.
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [sort, setSort] = useState<SortId>("recent");
  const [receiveSheetVisible, setReceiveSheetVisible] = useState(false);
  // Bumped when Receive should open with the paste input focused.
  const [receiveFocusPaste, setReceiveFocusPaste] = useState(false);
  // Multi-select mode: swaps kebab for checkboxes; header shows count +
  // Cancel/Delete. Entered via kebab → "Select multiple". Exited via Cancel
  // header button or after a batch action completes.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);
  // Watch the QR scanner's "Enter link manually" signal — open Receive
  // with the paste input focused. `manualEntryTick > 0` guard skips the
  // initial mount.
  useEffect(() => {
    if (manualEntryTick <= 0) return;
    setReceiveFocusPaste(true);
    setReceiveSheetVisible(true);
  }, [manualEntryTick]);
  // Target set for the post-grab child-row blink. Populated
  // by an effect that watches `lastCompletedDownload`. If the folder
  // modal isn't already open for the completed share, the effect opens
  // it first, then sets the blink target so the user sees the rows
  // arrive AND blink in sequence inside the modal.
  const [childBlinkTarget, setChildBlinkTarget] = useState<{
    shareKey: string;
    names: Set<string>;
  } | null>(null);

  // Subscribe to the RN-side cache-path side-store. Hosted drives don't
  // carry localFiles in the engine manifest (engine doesn't know about the
  // user's cache copies); this storage fills that gap.
  useEffect(() => {
    void loadSharedFilePaths().then(setSharedPaths);
    return subscribeSharedFilePaths(setSharedPaths);
  }, []);

  // Subscribe to the per-share storage so received bundles re-
  // render in place when downloads complete and flip files' isDownloaded.
  useEffect(() => {
    void loadShares().then(setReceivedShares);
    return subscribeShares(setReceivedShares);
  }, []);

  // Subscribe to hosted-share organizational flags so toggling
  // pin/favorite re-renders the list (and re-sorts) immediately.
  useEffect(() => {
    void loadHostedFlags().then(setHostedFlags);
    return subscribeHostedFlags(setHostedFlags);
  }, []);

  const hostedFlagsByDriveId = useMemo(() => {
    const m = new Map<string, HostedShareFlags>();
    for (const f of hostedFlags) m.set(f.driveId, f);
    return m;
  }, [hostedFlags]);

  // When a grab completes (newly-fetched or all already-on-disk),
  // open the folder-contents modal if it isn't already showing that folder,
  // then blink the completed rows inside it. Timer refs persist across the
  // re-renders that `consumeCompletedDownload` and `setFolderModalId`
  // trigger — refs let us cancel only on explicit re-trigger + unmount.
  const blinkStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (blinkStartTimerRef.current) clearTimeout(blinkStartTimerRef.current);
      if (blinkClearTimerRef.current) clearTimeout(blinkClearTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (!lastCompletedDownload) return;
    const synthId = `share:${lastCompletedDownload.shareKey}`;
    const names = new Set(lastCompletedDownload.names.map((n) => baseName(n)));
    const shareKey = lastCompletedDownload.shareKey;
    const alreadyOpen = folderModalId === synthId;
    if (blinkStartTimerRef.current) clearTimeout(blinkStartTimerRef.current);
    if (blinkClearTimerRef.current) clearTimeout(blinkClearTimerRef.current);
    consumeCompletedDownload();
    if (!alreadyOpen) setFolderModalId(synthId);
    // Small delay so the modal has mounted before the blink fires.
    const blinkDelay = alreadyOpen ? 0 : 240;
    blinkStartTimerRef.current = setTimeout(() => {
      setChildBlinkTarget({ shareKey, names });
    }, blinkDelay);
    blinkClearTimerRef.current = setTimeout(
      () => setChildBlinkTarget(null),
      blinkDelay + 900,
    );
  }, [lastCompletedDownload, folderModalId, consumeCompletedDownload]);

  const sharedPathsByDriveId = useMemo(() => {
    const m = new Map<string, SharedFilePath[]>();
    for (const e of sharedPaths) m.set(e.driveId, e.files);
    return m;
  }, [sharedPaths]);

  // Sort: most recent activity first. Active state does not affect ordering
  // — items don't jump as they transition.
  //
  // Two sources merged into one list.
  //   - Hosted drives: engine manifest (origin === "hosted"). `localFiles`
  //     synthesized from sharedFilePathsStorage so previewing hosted files
  //     works the same way as received.
  //   - Received shares: receivedSharesStorage entries — one row per share
  //     key regardless of how many engine drives that share has produced.
  //
  // The engine's received-side drives are intentionally hidden here —
  // they're a per-paste session detail, not a logical row in the list.
  const sortedDrives: DriveRow[] = useMemo(() => {
    const list: DriveRow[] = [];

    for (const d of drives ?? []) {
      if (d.origin === "received") continue;
      if (optimisticallyDeleted.has(d.id)) continue;
      let local = d.localFiles;
      const paths = sharedPathsByDriveId.get(d.id);
      if (paths && paths.length > 0) {
        local = paths.map((p) => ({
          name: p.name,
          path: p.localPath,
          size: p.size ?? 0,
        }));
      }
      const flags = hostedFlagsByDriveId.get(d.id);
      const enriched: DriveRow = {
        ...d,
        // User-supplied name (captured via NameShareModal) wins over the
        // engine-generated one. rowDisplayName reads `name` and already
        // handles truncation for the list card.
        name: flags?.customName ?? d.name,
        localFiles: local,
        isBundle: (d.files?.length ?? 0) > 1,
        isPinned: !!flags?.isPinned,
        isFavorite: !!flags?.isFavorite,
      };
      enriched.primaryFile = rowPrimaryFile(enriched);
      list.push(enriched);
    }

    for (const share of receivedShares) {
      const synthId = `share:${share.shareKey}`;
      if (optimisticallyDeleted.has(synthId)) continue;
      const localFiles: DriveLocalFile[] = share.files
        .filter((f) => f.isDownloaded && !!f.localPath)
        .map((f) => ({
          name: f.name,
          path: f.localPath as string,
          size: f.size,
        }));
      const fileEntries = share.files.map((f) => ({
        name: f.name,
        storagePath: f.path,
        size: f.size,
      }));
      const row: DriveRow = {
        id: synthId,
        key: share.shareKey,
        shareLink: share.shareLink,
        name: share.shareName,
        state: "inactive",
        origin: "received",
        isUpload: false,
        totalBytes: share.files.reduce((a, f) => a + (f.size ?? 0), 0),
        files: fileEntries,
        localFiles,
        createdAt: share.firstSeenAt,
        lastActivityAt: share.lastUpdatedAt,
        isBundle: share.files.length > 1,
        share,
        isPinned: !!share.isPinned,
        isFavorite: !!share.isFavorite,
      };
      row.primaryFile = rowPrimaryFile(row);
      list.push(row);
    }

    // Two-level sort — pinned shares first, then recency within
    // each group. Applies in both the All and Favorites views.
    list.sort((a, b) => {
      const pa = a.isPinned ? 1 : 0;
      const pb = b.isPinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
    return list;
  }, [drives, sharedPathsByDriveId, optimisticallyDeleted, receivedShares, hostedFlagsByDriveId]);

  const transferByDriveId = useMemo(() => {
    const m = new Map<string, (typeof transfers)[number]>();
    for (const t of transfers) m.set(t.driveId, t);
    return m;
  }, [transfers]);

  // Send sheet: recent hosted shares that still have a live link, most
  // recent first, capped at 5. Only hosted drives — received shares aren't
  // "yours to re-share" from this surface.
  const recentShares = useMemo<RecentShareItem[]>(() => {
    return sortedDrives
      .filter((d) => d.origin !== "received" && !!d.shareLink)
      .slice(0, 5)
      .map((d) => ({
        id: d.id,
        name: rowDisplayName(d),
        meta: `${formatBytes(totalBytesOf(d))} · ${
          formatRelativeOrDate(d.lastActivityAt ?? d.createdAt) ?? "—"
        }`,
        icon: driveIconName(d),
        shareLink: d.shareLink,
      }));
  }, [sortedDrives]);

  // viewMode filter applied AFTER the primary "recent" sort.
  // Search (name substring), filter (type/status), and a
  // user-selected sort (recent/name/size). Pinned always float to the top
  // within the active view.
  const visibleDrives = useMemo<DriveRow[]>(() => {
    let list = viewMode === "favorites"
      ? sortedDrives.filter((d) => d.isFavorite)
      : sortedDrives.slice();

    const q = search.trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((d) => (d.name ?? "").toLowerCase().includes(q));
    }

    switch (filter) {
      case "files":
        list = list.filter((d) => !d.isBundle);
        break;
      case "folders":
        list = list.filter((d) => !!d.isBundle);
        break;
      case "active":
        list = list.filter((d) => activeDriveIds.has(d.id));
        break;
      case "completed": {
        list = list.filter((d) => {
          const t = transferByDriveId.get(d.id);
          return !!t?.completed;
        });
        break;
      }
      case "all":
      default:
        break;
    }

    if (sort !== "recent") {
      // Re-sort while preserving pinned-first semantics.
      list.sort((a, b) => {
        const pa = a.isPinned ? 1 : 0;
        const pb = b.isPinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        if (sort === "name") {
          return (a.name ?? "").localeCompare(b.name ?? "");
        }
        // sort === "size"
        return (b.totalBytes ?? 0) - (a.totalBytes ?? 0);
      });
    }

    return list;
  }, [sortedDrives, viewMode, search, filter, sort, activeDriveIds, transferByDriveId]);

  // Reconcile the optimistic-delete set: drop any ID the engine has already
  // pruned from its drives list (purge round-trip complete). Without this
  // the set would grow forever in long sessions.
  useEffect(() => {
    if (optimisticallyDeleted.size === 0) return;
    const live = new Set((drives ?? []).map((d) => d.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of optimisticallyDeleted) {
      if (live.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) setOptimisticallyDeleted(next);
  }, [drives, optimisticallyDeleted]);

  // The list emits only drive rows — bundle contents live in the
  // folder-contents modal. Kept as a useMemo so downstream identity is
  // stable across re-renders that don't change the visible slice.
  const flattenedList = useMemo<ListItem[]>(
    () => visibleDrives.map((d) => ({ kind: "drive", drive: d })),
    [visibleDrives],
  );

  // Build the file list for a given bundle drive (used by the folder-
  // contents modal). Same join semantics as the prior inline expansion:
  //  - Received bundles read directly from `share.files[]`.
  //  - Hosted bundles join `files[]` to `localFiles[]` by index / name.
  const buildFolderChildren = useCallback(
    (d: DriveRow): FolderModalChild[] => {
      const out: FolderModalChild[] = [];
      if (d.share) {
        d.share.files.forEach((f, i) => {
          out.push({
            parentId: d.id,
            indexInBundle: i,
            name: f.name,
            size: f.size,
            localPath: f.isDownloaded ? f.localPath : undefined,
            isMissing: !f.isDownloaded,
            shareKey: d.share?.shareKey,
            shareLink: d.share?.shareLink,
          });
        });
        return out;
      }
      const localFiles = d.localFiles ?? [];
      const localByName = new Map<string, DriveLocalFile>();
      for (const lf of localFiles) localByName.set(baseName(lf.name), lf);
      (d.files ?? []).forEach((f, i) => {
        const byIndex = localFiles[i];
        const byName = localByName.get(baseName(f.name));
        const local =
          byIndex && baseName(byIndex.name) === baseName(f.name)
            ? byIndex
            : byName ?? byIndex;
        out.push({
          parentId: d.id,
          indexInBundle: i,
          name: f.name,
          size: f.size,
          localPath: local?.path,
        });
      });
      return out;
    },
    [],
  );

  // Auto-refresh on mount + when ready flips on.
  useEffect(() => {
    if (ready) void refreshDrives();
  }, [ready, refreshDrives]);

  // Resolve which drive is highlighted in the QR/info modal.
  const qrDrive = useMemo(
    () => (qrDriveId ? sortedDrives.find((d) => d.id === qrDriveId) : undefined),
    [sortedDrives, qrDriveId],
  );

  // Preview player wiring.
  // Resolve the preview's parent drive so the bottom share/
  // stop-sharing button knows the active state + identity to toggle.
  // Returns null if the parent was a received-share synth row — those
  // don't expose a clean activate path in this sprint, so we omit the
  // button for them.
  const previewParentDrive = useMemo(() => {
    if (!preview?.parentDriveId) return null;
    const found = sortedDrives.find((d) => d.id === preview.parentDriveId);
    if (!found) return null;
    if (found.share) return null; // received synth — no share-toggle
    return found;
  }, [sortedDrives, preview?.parentDriveId]);
  const previewParentIsActive = !!previewParentDrive && activeDriveIds.has(previewParentDrive.id);

  const previewUri = useMemo(() => {
    if (!preview?.file) return null;
    return preview.file.path.startsWith("file://")
      ? preview.file.path
      : `file://${preview.file.path}`;
  }, [preview]);
  const audioUri = preview?.mode === "audio" ? previewUri : null;
  const videoUri = preview?.mode === "video" ? previewUri : null;
  const audioPlayer = useAudioPlayer(audioUri);
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const videoPlayer = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  // Poll audio currentTime / duration at 4 Hz while audio preview is open.
  // expo-audio exposes `playing` reactively but not currentTime; we read it
  // directly from the player at a steady cadence to drive the scrubber.
  useEffect(() => {
    if (preview?.mode !== "audio" || !audioPlayer) {
      setAudioPosition(0);
      setAudioDuration(0);
      return;
    }
    const tick = () => {
      try {
        const pos = Number(audioPlayer.currentTime || 0);
        const dur = Number(audioPlayer.duration || 0);
        if (Number.isFinite(pos)) setAudioPosition(pos);
        if (Number.isFinite(dur) && dur > 0) setAudioDuration(dur);
      } catch {
        // expo-audio can throw mid-dispose; next tick resyncs.
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [preview?.mode, audioPlayer]);

  const onAudioSkip = useCallback(
    (deltaSeconds: number) => {
      if (!audioPlayer) return;
      try {
        const dur = Number(audioPlayer.duration || audioDuration || 0);
        const cur = Number(audioPlayer.currentTime || audioPosition || 0);
        const next = Math.max(0, Math.min(dur || cur + deltaSeconds, cur + deltaSeconds));
        audioPlayer.seekTo(next);
        setAudioPosition(next);
      } catch {
        // ignore — next poll tick will resync
      }
    },
    [audioPlayer, audioDuration, audioPosition],
  );

  const onAudioSeekToFraction = useCallback(
    (fraction: number) => {
      if (!audioPlayer) return;
      const dur = Number(audioPlayer.duration || audioDuration || 0);
      if (!Number.isFinite(dur) || dur <= 0) return;
      const target = Math.max(0, Math.min(dur, dur * fraction));
      try {
        audioPlayer.seekTo(target);
        setAudioPosition(target);
      } catch {
        // ignore — next poll tick will resync
      }
    },
    [audioPlayer, audioDuration],
  );

  // Poll video currentTime / duration / playing at 4 Hz while
  // the takeover is open, mirroring the audio pattern. expo-video doesn't
  // expose a reactive playing flag we can subscribe to without useEvent.
  useEffect(() => {
    if (preview?.mode !== "video" || !videoPlayer) {
      setVideoIsPlaying(false);
      setVideoPosition(0);
      setVideoDuration(0);
      return;
    }
    const tick = () => {
      try {
        setVideoIsPlaying(!!videoPlayer.playing);
        const pos = Number(videoPlayer.currentTime || 0);
        const dur = Number(videoPlayer.duration || 0);
        if (Number.isFinite(pos)) setVideoPosition(pos);
        if (Number.isFinite(dur) && dur > 0) setVideoDuration(dur);
      } catch {
        // expo-video can throw mid-dispose; next tick resyncs.
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [preview?.mode, videoPlayer]);

  // Chrome auto-hide for the video takeover. Chrome stays
  // visible while paused (the user is engaging); when playing, fades out
  // after 3 s of no taps. Any tap on the video tap-surface fades it back
  // in and resets the timer. Other media types (audio/image/text) keep
  // chrome visible always — `scheduleChromeHide` is a no-op outside video.
  const scheduleChromeHide = useCallback(() => {
    if (chromeHideTimerRef.current) {
      clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
    if (preview?.mode !== "video" || !videoIsPlaying) return;
    chromeHideTimerRef.current = setTimeout(() => {
      Animated.timing(chromeOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setChromeVisible(false);
      });
    }, 3000);
  }, [preview?.mode, videoIsPlaying, chromeOpacity]);

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    Animated.timing(chromeOpacity, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true,
    }).start();
    scheduleChromeHide();
  }, [chromeOpacity, scheduleChromeHide]);

  // Reset chrome state every time the preview opens / changes mode, and
  // reschedule the hide whenever playing-state flips while in video mode.
  useEffect(() => {
    if (!preview) {
      if (chromeHideTimerRef.current) {
        clearTimeout(chromeHideTimerRef.current);
        chromeHideTimerRef.current = null;
      }
      chromeOpacity.setValue(1);
      setChromeVisible(true);
      return;
    }
    chromeOpacity.setValue(1);
    setChromeVisible(true);
    scheduleChromeHide();
  }, [preview, videoIsPlaying, scheduleChromeHide, chromeOpacity]);

  const closePreview = useCallback(() => {
    if (audioPlayer?.playing) audioPlayer.pause();
    if (videoPlayer?.playing) videoPlayer.pause();
    setPreview(null);
    setPreviewText("");
    if (chromeHideTimerRef.current) {
      clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
  }, [audioPlayer, videoPlayer]);

  // Tap surface on the video toggles playback AND keeps chrome visible.
  // OS-player-style: tapping the video is the primary pause/play gesture
  // once a video is going. The center play button still works for the
  // "I just opened this and it's paused" case.
  const onVideoTap = useCallback(() => {
    showChrome();
    if (!videoPlayer) return;
    try {
      if (videoPlayer.playing) videoPlayer.pause();
      else videoPlayer.play();
    } catch {
      // expo-video can throw mid-dispose; ignore.
    }
  }, [videoPlayer, showChrome]);

  const onVideoSeekToFraction = useCallback(
    (fraction: number) => {
      if (!videoPlayer) return;
      const dur = Number(videoPlayer.duration || videoDuration || 0);
      if (!Number.isFinite(dur) || dur <= 0) return;
      const target = Math.max(0, Math.min(dur, dur * fraction));
      try {
        videoPlayer.currentTime = target;
        setVideoPosition(target);
        showChrome();
      } catch {
        // ignore
      }
    },
    [videoPlayer, videoDuration, showChrome],
  );

  const onOpenFile = useCallback(
    async (path: string) => {
      try {
        const fileUri = path.startsWith("file://") ? path : `file://${path}`;
        if (Platform.OS === "android") {
          const contentUri = await FileSystemLegacy.getContentUriAsync(fileUri);
          await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
            data: contentUri,
            flags: 1,
            type: mimeFromName(baseName(path)),
          });
          return;
        }
        await Linking.openURL(fileUri);
      } catch (e: unknown) {
        showToast(`Can't open that one — ${String((e as Error)?.message || e)}`, "error");
      }
    },
    [showToast],
  );

  // Bundle tap opens the folder-contents modal, not an inline dropdown.
  const openFolderModal = useCallback((driveId: string) => {
    setFolderModalId(driveId);
  }, []);

  const previewFile = useCallback(
    async (file: DriveLocalFile, parentDriveId?: string) => {
      // Cache-eviction guard. If the local copy is gone we surface a clear
      // toast instead of opening an empty preview that never resolves.
      let exists = true;
      try {
        exists = await RNFS.exists(file.path);
      } catch {
        exists = false;
      }
      if (!exists) {
        showToast("This file is no longer available locally.", "error");
        return;
      }
      const mode = previewModeFor(file.name);
      if (mode === "unsupported") {
        await onOpenFile(file.path);
        return;
      }
      if (audioPlayer?.playing) audioPlayer.pause();
      if (videoPlayer?.playing) videoPlayer.pause();
      setPreview({ file, mode, parentDriveId });
      if (mode === "text") {
        try {
          const txt = await RNFS.readFile(file.path, "utf8");
          setPreviewText(txt.slice(0, 4000));
        } catch (e: unknown) {
          setPreviewText(`Can't preview this one — ${String((e as Error)?.message || e)}`);
        }
      }
    },
    [audioPlayer, videoPlayer, onOpenFile, showToast],
  );

  const onTapRow = useCallback(
    async (drive: DriveRow) => {
      // Bundles open the folder-contents modal — there's no single content
      // to preview. The kebab continues to surface More info / Share it /
      // Delete for the whole folder.
      if (drive.isBundle) {
        openFolderModal(drive.id);
        return;
      }
      const primary = drive.primaryFile;
      if (!primary) {
        // Single-file drive with no resolvable local copy (e.g. an inactive
        // received drive that lost its file, or an active hosted drive
        // whose cache eviction beat the user to the tap). Open the info
        // modal so the user can still see status / activate / delete.
        setQrDriveId(drive.id);
        return;
      }
      await previewFile(primary, drive.id);
    },
    [previewFile, openFolderModal],
  );

  // Shared share-then-persist path used by the file-picker, photo-picker,
  // and folder-picker flows. `customName`, when non-empty, is stored on
  // the hosted-share flags so downstream reads (list card, File info
  // modal) show the user-supplied title.
  async function shareFilesAndTrack(
    files: { uri: string; name: string; size?: number }[],
    opts: {
      relPaths?: string[];
      customName?: string | null;
      errorLabel: string;
    },
  ) {
    if (!files.length) {
      debugLog("warn", "rn.share", "shareFilesAndTrack called with zero files");
      showToast("Nothing picked.");
      return;
    }
    // The single funnel for share creation from the UI —
    // every picker path lands here.
    debugLog(
      "info",
      "rn.share",
      `share create: files=${files.length} folderShare=${!!opts.relPaths} ` +
        `customName=${opts.customName ? JSON.stringify(opts.customName) : "-"} ` +
        `bytes=${files.reduce((a, f) => a + (f.size ?? 0), 0)}`,
    );
    const out = await sharePaths(
      files.map((f) => f.uri),
      opts.relPaths,
    );
    if (!out.ok || !out.shareLink) {
      logStructuredError("rn.share", "share create failed", out.error);
      showToast(opts.errorLabel, "error");
      return;
    }
    debugLog("info", "rn.share", `share created drive=${out.driveId ?? "?"}`);
    // Ask for notification permission here, at the first moment the user
    // has something worth being notified about. The lazy request inside
    // notifyTransferComplete stays as a backstop, but on its own it fires
    // at a backgrounded completion — prompting while the user is in
    // another app, which is the worst moment to ask and a likely denial.
    // Fire-and-forget: the share flow, haptics and QR modal below must not
    // wait on an OS dialog, and a denial stays silent by design.
    void ensureNotificationPermission();
    if (out.driveId) {
      void saveSharedFilePathsEntry({
        driveId: out.driveId,
        files: files.map((f, i) => ({
          name: opts.relPaths?.[i] || f.name,
          localPath: normalizeLocalPath(f.uri),
          size: f.size,
        })),
        savedAt: Date.now(),
      });
      const name = opts.customName?.trim();
      if (name) {
        void setHostedShareCustomName(out.driveId, name);
      }
    }
    haptics.success();
    void refreshDrives();
    if (out.driveId) setQrDriveId(out.driveId);
  }

  function defaultShareName(
    kind: "files" | "photos",
    fileCount: number,
  ): string {
    if (kind === "photos") {
      return fileCount === 1 ? "Photo" : "Photos";
    }
    return fileCount === 1 ? "File" : "Files";
  }

  /**
   * Selection confirmed in the in-app picker.
   *
   * SAF rows arrive as `content://` URIs the engine can't read, so those
   * get copied into cache first (same constraint folder sharing has).
   * Recents are already `file://` cache paths and pass straight through.
   * After that the selection is an ordinary PickedFile[] and joins the
   * exact same branches the OS picker's result does — >1 prompts for a
   * name, 1 shares immediately. No downstream share logic changes.
   */
  async function onConfirmInAppSelection(entries: BrowseEntry[]) {
    setInAppPickerBusy(true);
    try {
      const { needsCopy } = partitionForMaterialization(entries);
      const overrides: Record<string, string> = {};
      for (const e of needsCopy) {
        overrides[e.uri] = await materializeUriToCache(e.uri, e.name);
      }
      const files = toPickedFiles(entries, overrides);
      if (!files.length) {
        showToast("Nothing picked.");
        return;
      }
      setInAppPickerOpen(false);
      if (files.length > 1) {
        setPendingNameShare({
          kind: "files",
          defaultName: defaultShareName("files", files.length),
          files,
        });
        return;
      }
      await shareFilesAndTrack(files, {
        errorLabel: "Couldn't create that share — give it another go?",
      });
    } catch (e: unknown) {
      showToast(`Couldn't share — ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setInAppPickerBusy(false);
    }
  }

  /**
   * One-tap re-share from the "Recent shares" section.
   *
   * These rows point at cache copies from an earlier share, and the OS
   * evicts those over time. Guard first — same cache-eviction check
   * `previewFile` uses — so a stale row reports plainly instead of
   * failing downstream as "couldn't create that share", which would
   * blame the wrong thing.
   */
  async function onReshareEntry(entry: BrowseEntry) {
    let exists = true;
    try {
      exists = await RNFS.exists(entry.uri.replace(/^file:\/\//, ""));
    } catch {
      exists = false;
    }
    if (!exists) {
      showToast("This file is no longer available locally.", "error");
      return;
    }
    await onConfirmInAppSelection([entry]);
  }

  async function onPickAndShare() {
    setPickerSheet(null);
    // These double as the in-app picker's escape hatches, so
    // dismiss it before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: true,
      });
      // Cancel and empty both exit through `handlePickerExit` —
      // clean return to the Send sheet, no half-started share, no fallthrough.
      const outcome = classifyPickerResult(res.canceled, selectFiles(res));
      if (outcome.kind !== "selected") {
        handlePickerExit(outcome, { empty: "Nothing picked." });
        return;
      }
      const files = outcome.files;
      // >1 file → prompt for a share name. Single files skip the modal
      // and share immediately (their filename already reads as the name).
      if (files.length > 1) {
        setPendingNameShare({
          kind: "files",
          defaultName: defaultShareName("files", files.length),
          files,
        });
        return;
      }
      await shareFilesAndTrack(files, {
        errorLabel: "Couldn't create that share — give it another go?",
      });
    } catch (e: unknown) {
      if (isPickerCancellation(e)) {
        handlePickerExit({ kind: "cancelled" }, { empty: "Nothing picked." });
        return;
      }
      showToast(`Couldn't share — ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickFolderAndShare() {
    setPickerSheet(null);
    // These double as the in-app picker's escape hatches, so
    // dismiss it before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      const dir = await pickFolder();
      // `pickFolder` returns null on a back-out. Route it through
      // the shared exit so the folder picker behaves like the other two.
      if (!dir) {
        handlePickerExit(
          { kind: "cancelled" },
          { empty: "That folder had nothing to share." },
        );
        return;
      }
      let enumerated;
      try {
        enumerated = await enumerateFolder(dir, { maxFiles: 1000 });
      } catch (err) {
        if (err instanceof FolderTooLargeError) {
          showToast(`Folder is too big to share (limit: ${err.limit}).`, "error");
          return;
        }
        throw err;
      }
      if (!enumerated.length) {
        handlePickerExit(
          { kind: "empty" },
          { empty: "That folder had nothing to share." },
        );
        return;
      }
      const paths = enumerated.map((f) => f.uri);
      const relPaths = enumerated.map((f) => f.relPath);
      const out = await sharePaths(paths, relPaths);
      if (!out.ok || !out.shareLink) {
        showToast("Couldn't share that folder.", "error");
        return;
      }
      if (out.driveId) {
        void saveSharedFilePathsEntry({
          driveId: out.driveId,
          files: enumerated.map((f) => ({
            name: f.relPath || f.name,
            localPath: normalizeLocalPath(f.uri),
            size: f.size,
          })),
          savedAt: Date.now(),
        });
      }
      haptics.success();
      void refreshDrives();
      if (out.driveId) setQrDriveId(out.driveId);
    } catch (e: unknown) {
      // A back-out that surfaced as a throw is not an error — exit cleanly
      // rather than showing the user a red "Folder error" for a cancel.
      if (isPickerCancellation(e)) {
        handlePickerExit(
          { kind: "cancelled" },
          { empty: "That folder had nothing to share." },
        );
        return;
      }
      showToast(`Folder error: ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickPhotosAndShare() {
    setPickerSheet(null);
    // These double as the in-app picker's escape hatches, so
    // dismiss it before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      // On older Android / OEM ROMs `launchImageLibraryAsync` can throw
      // outright (permission denied, vendor gallery missing). Left unguarded
      // that throw reached the outer catch and dead-ended the user on a red
      // "Photo share error" toast. Now: a throw that reads as a back-out is
      // treated as a cancel, and anything else falls back to the SAF
      // document picker — the same path onPickAndShare uses — instead of
      // dead-ending.
      let outcome: PickerOutcome;
      try {
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsMultipleSelection: true,
          quality: 1,
          allowsEditing: false,
          selectionLimit: 0,
          exif: false,
          base64: false,
        });
        outcome = classifyPickerResult(
          res.canceled,
          mapImageAssets(res.assets, Date.now()),
        );
      } catch (err: unknown) {
        if (isPickerCancellation(err)) {
          outcome = { kind: "cancelled" };
        } else {
          const fallback = await DocumentPicker.getDocumentAsync({
            type: "image/*",
            copyToCacheDirectory: true,
            multiple: true,
          });
          outcome = classifyPickerResult(
            fallback.canceled,
            selectFiles(fallback),
          );
        }
      }
      if (outcome.kind !== "selected") {
        handlePickerExit(outcome, { empty: "No photos picked." });
        return;
      }
      const files = outcome.files;
      if (files.length > 1) {
        setPendingNameShare({
          kind: "photos",
          defaultName: defaultShareName("photos", files.length),
          files,
        });
        return;
      }
      await shareFilesAndTrack(files, {
        errorLabel: "Couldn't create that share.",
      });
    } catch (e: unknown) {
      if (isPickerCancellation(e)) {
        handlePickerExit({ kind: "cancelled" }, { empty: "No photos picked." });
        return;
      }
      showToast(`Photo share error: ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onShareIt(drive: DriveRow) {
    setKebabSheet(null);
    const res = await activateDrive(drive.id);
    if (!res.ok) {
      showToast(errorMessage(res.error) || "Couldn't activate that one.", "error");
      return;
    }
    haptics.success();
    setQrDriveId(drive.id);
    void refreshDrives();
  }

  // useCallback so the identity is stable across renders and the row
  // memo below doesn't invalidate every tick.
  const onStopSharing = useCallback(
    async (drive: DriveRow) => {
      setKebabSheet(null);
      const res = await deactivateDrive(drive.id);
      if (!res.ok) {
        showToast(errorMessage(res.error) || "Couldn't stop that one.", "error");
        return;
      }
      haptics.actionDone();
      showToast("Stopped sharing.");
      void refreshDrives();
    },
    [deactivateDrive, refreshDrives, showToast],
  );

  // Unified pin / favorite toggles. Route to the right storage
  // based on the share's origin. Received shares carry the flags on their
  // ReceivedShare record; hosted drives go through the hostedShareFlags
  // side-store keyed by engine driveId.
  const togglePinned = useCallback((drive: DriveRow) => {
    const next = !drive.isPinned;
    if (drive.share) {
      void setSharePinned(drive.share.shareKey, next);
    } else {
      void setHostedSharePinned(drive.id, next);
    }
    haptics.actionDone();
  }, []);

  const toggleFavorite = useCallback((drive: DriveRow) => {
    const next = !drive.isFavorite;
    if (drive.share) {
      void setShareFavorite(drive.share.shareKey, next);
    } else {
      void setHostedShareFavorite(drive.id, next);
    }
    haptics.actionDone();
  }, []);

  // Actual destructive operation — no confirmation prompt. Callers must
  // confirm with the user via ConfirmModal before invoking this. The row
  // disappears from the list immediately; engine purge + manifest refresh
  // happen in the background.
  const performDelete = useCallback(
    (drive: DriveRow) => {
      const id = drive.id;
      LayoutAnimation.configureNext({
        duration: 200,
        create: { type: "easeInEaseOut", property: "opacity" },
        update: { type: "easeInEaseOut" },
        delete: { type: "easeInEaseOut", property: "opacity" },
      });
      setOptimisticallyDeleted((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setFolderModalId((cur) => (cur === id ? null : cur));
      haptics.actionDone();
      showToast("Deleted.");
      if (drive.share) {
        // Received share. Drop the per-share record, then purge
        // every engine drive whose key matches — the share may have produced
        // several short-lived engine drive entries across re-pastes.
        const shareKey = drive.share.shareKey;
        void deleteShare(shareKey);
        const matchingEngineIds = (drives ?? [])
          .filter((d) => d.origin === "received" && d.key === shareKey)
          .map((d) => d.id);
        for (const eid of matchingEngineIds) {
          void cancelTransfer(eid, { purge: true });
        }
        void refreshDrives();
      } else {
        // Hosted drive — the existing fire-and-forget engine purge.
        void cancelTransfer(id, { purge: true }).then(() => {
          void refreshDrives();
        });
        void removeSharedFilePaths(id);
        // Drop the organizational flags too — a future fresh
        // share that happens to reuse the driveId shouldn't inherit them.
        void clearHostedShareFlags(id);
      }
    },
    [cancelTransfer, drives, refreshDrives, showToast],
  );

  const onDelete = useCallback((drive: DriveRow) => {
    setKebabSheet(null);
    setPendingDelete(drive);
    // Whatever the user picks in the confirm, the swipe should snap closed.
    // Bump the signal now so SwipeableRow runs its close animation while the
    // modal is up — by the time the modal dismisses, the row is at rest.
    setSwipeCloseTick((t) => t + 1);
  }, []);

  async function onCopyLink(link: string) {
    if (!link) return;
    await Clipboard.setStringAsync(link);
    haptics.actionDone();
    showToast("Link copied.", "success");
  }

  const renderRow: ListRenderItem<ListItem> = useCallback(
    ({ item, index }) => {
      // Drive row (ShareRow). The folder modal replaces the child branch.
      const drive = item.drive;
      const isActive = activeDriveIds.has(drive.id);
      const isFailed = failedHydrationIds.has(drive.id);
      const name = rowDisplayName(drive);
      const bytes = totalBytesOf(drive);
      const ts = drive.lastActivityAt ?? drive.createdAt;
      const meta = `${formatBytes(bytes)} · ${formatRelativeOrDate(ts) ?? "—"}`;
      const t = transferByDriveId.get(drive.id);
      const transferring =
        !!t && !t.completed && (t.percent ?? 0) > 0 && (t.percent ?? 0) < 100;
      const iconName = driveIconName(drive);
      const isBundle = !!drive.isBundle;
      const peers = t?.peersConnected ?? 0;
      const indicatorState: ActiveIndicatorState = isActive
        ? peers > 0
          ? "active-broadcasting"
          : "active-idle"
        : "inactive";

      // Status sub-line: `<Type> · <StateLabel>` pattern matching the
      // design deck. Type prefix comes from the primary file's mode for
      // single-file rows, or a "N files" summary for bundles.
      const typePrefix = ((): string => {
        const files = drive.files ?? [];
        if (isBundle) return `${files.length} Files`;
        const firstName = drive.primaryFile?.name ?? files[0]?.name ?? "";
        const mode = firstName ? previewModeFor(firstName) : "unsupported";
        if (mode === "image") return "Picture";
        if (mode === "video") return "Video";
        if (mode === "audio") return "Music";
        if (mode === "text") return "Document";
        return "File";
      })();
      let status: ShareRowStatus | null = null;
      if (isFailed) {
        status = { label: `${typePrefix} · Couldn't restore`, tone: "danger" };
      } else if (transferring) {
        const pct = Math.round(Math.max(0, Math.min(100, t?.percent ?? 0)));
        status = { label: `${typePrefix} · Sharing (${pct}%)`, tone: "warning" };
      } else if (t?.completed) {
        status = { label: `${typePrefix} · Completed`, tone: "primary" };
      } else if (isActive) {
        status = { label: `${typePrefix} · Active`, tone: "primary" };
      }

      // Thumbnail: show the primary file's image directly for single-file
      // image rows; video rows generate a one-frame thumbnail via
      // expo-video-thumbnails (cached module-wide). Everything else falls
      // back to the tokenized icon tile.
      const primaryPath = drive.primaryFile?.path;
      const primaryName = drive.primaryFile?.name ?? drive.name ?? "";
      const primaryMode =
        !isBundle && primaryPath ? previewModeFor(primaryName) : null;
      const primaryFileUri =
        !isBundle && primaryPath
          ? primaryPath.startsWith("file://")
            ? primaryPath
            : `file://${primaryPath}`
          : undefined;
      const previewUri =
        primaryMode === "image" ? primaryFileUri : undefined;
      const videoUri =
        primaryMode === "video" ? primaryFileUri ?? null : null;

      return (
        <SwipeableRow
          onDelete={() => onDelete(drive)}
          deleteLabel="Delete"
          accessibilityLabel={`${name}, ${status?.label ?? meta}`}
          frontBackground={theme.bg}
          closeSignal={swipeCloseTick}
        >
          <ShareRow
            iconName={iconName}
            previewUri={previewUri}
            videoUri={videoUri}
            name={name}
            meta={meta}
            status={status}
            isFavorite={drive.isFavorite}
            isPinned={drive.isPinned}
            indicatorState={indicatorState}
            isBundle={isBundle}
            dim={!isActive}
            onPress={
              selectionMode
                ? () => toggleSelected(drive.id)
                : () => void onTapRow(drive)
            }
            onKebabPress={() => setKebabSheet({ drive })}
            showTopDivider={index !== 0}
            selectionMode={selectionMode}
            selected={selectedIds.has(drive.id)}
          />
        </SwipeableRow>
      );
    },
    [
      activeDriveIds,
      failedHydrationIds,
      onDelete,
      onTapRow,
      selectedIds,
      selectionMode,
      swipeCloseTick,
      theme,
      toggleSelected,
      transferByDriveId,
    ],
  );

  const emptyState = useMemo(
    () =>
      viewMode === "favorites" ? (
        <EmptyState
          icon="heart-outline"
          title="No favorites yet"
          subtitle="Tap the heart on a share to add it."
        />
      ) : (
        <EmptyState
          icon="folder-open-outline"
          title="Nothing here yet"
          subtitle="Pick files above or paste a link."
        />
      ),
    [viewMode],
  );

  const kebabDrive = kebabSheet?.drive;
  const kebabActive = kebabDrive ? activeDriveIds.has(kebabDrive.id) : false;
  const kebabOpenable = kebabDrive ? isOpenableInOtherApp(kebabDrive) : false;

  // Identity header for the per-drive kebab sheet. Mirrors the
  // thumbnail/name/status derivation used by ShareRow so the sheet header
  // reads as the same row the user just tapped.
  const kebabHeader = useMemo(() => {
    if (!kebabDrive) return undefined;
    const isBundle = !!kebabDrive.isBundle;
    const files = kebabDrive.files ?? [];
    const firstName =
      kebabDrive.primaryFile?.name ?? files[0]?.name ?? "";
    const typePrefix = isBundle
      ? `${files.length} Files`
      : (() => {
          const mode = firstName ? previewModeFor(firstName) : "unsupported";
          if (mode === "image") return "Picture";
          if (mode === "video") return "Video";
          if (mode === "audio") return "Music";
          if (mode === "text") return "Document";
          return "File";
        })();
    const bytes = totalBytesOf(kebabDrive);
    const primaryPath = kebabDrive.primaryFile?.path;
    const primaryName = kebabDrive.primaryFile?.name ?? kebabDrive.name ?? "";
    const previewUri =
      !isBundle && primaryPath && previewModeFor(primaryName) === "image"
        ? primaryPath.startsWith("file://")
          ? primaryPath
          : `file://${primaryPath}`
        : null;
    return {
      iconName: driveIconName(kebabDrive),
      previewUri,
      name: rowDisplayName(kebabDrive),
      meta: `${typePrefix} · ${formatBytes(bytes)}`,
      isBundle,
    };
  }, [kebabDrive]);

  // Folder-contents modal: derive the drive + prepared file list from
  // the currently-open bundle id. Uses the same visible-drives slice as
  // the list so search / filter / sort mutations in the parent screen
  // don't strand a hidden folder open.
  const folderModalDrive = useMemo(
    () =>
      folderModalId
        ? visibleDrives.find((d) => d.id === folderModalId) ??
          sortedDrives.find((d) => d.id === folderModalId)
        : undefined,
    [folderModalId, visibleDrives, sortedDrives],
  );
  const folderModalTransfer = folderModalDrive
    ? transferByDriveId.get(folderModalDrive.id)
    : undefined;
  const folderModalIsActive =
    !!folderModalDrive && activeDriveIds.has(folderModalDrive.id);
  const folderModalTransferring =
    !!folderModalTransfer &&
    !folderModalTransfer.completed &&
    (folderModalTransfer.percent ?? 0) > 0 &&
    (folderModalTransfer.percent ?? 0) < 100;
  const folderModalFiles = useMemo<FolderContentsFile[]>(() => {
    if (!folderModalDrive) return [];
    const children = buildFolderChildren(folderModalDrive);
    const pct = Math.round(
      Math.max(0, Math.min(100, folderModalTransfer?.percent ?? 0)),
    );
    return children.map((c) => {
      const displayName = baseName(c.name);
      const hasLocal = !!c.localPath;
      const isMissing = !!c.isMissing;
      let statusLabel: string;
      let statusTone: FolderContentsFile["statusTone"];
      if (isMissing) {
        statusLabel = "Not on device";
        statusTone = "muted";
      } else if (folderModalTransferring) {
        statusLabel = `Sharing (${pct}%)`;
        statusTone = "warning";
      } else if (folderModalIsActive) {
        statusLabel = "Active";
        statusTone = "primary";
      } else if (hasLocal) {
        statusLabel = "Inactive";
        statusTone = "muted";
      } else {
        statusLabel = "Not on device";
        statusTone = "muted";
      }
      const blink =
        !!childBlinkTarget &&
        c.shareKey === childBlinkTarget.shareKey &&
        childBlinkTarget.names.has(displayName);
      const onPress = () => {
        if (isMissing && c.shareLink) {
          setPendingPreselection([c.name]);
          setLinkDraft(c.shareLink);
          setFolderModalId(null);
          return;
        }
        if (!hasLocal || !c.localPath) {
          showToast("This file is no longer available locally.", "error");
          return;
        }
        void previewFile(
          {
            name: displayName,
            path: c.localPath,
            size: c.size ?? 0,
          },
          c.parentId,
        );
      };
      const onRightControlPress = () => {
        if (statusTone === "warning" && folderModalDrive) {
          void onStopSharing(folderModalDrive);
          return;
        }
        if (hasLocal && c.localPath) {
          void onOpenFile(c.localPath);
          return;
        }
        onPress();
      };
      // Row thumbnail: images render inline; videos generate a one-frame
      // preview via expo-video-thumbnails (cached). Missing/remote files
      // fall back to the type-icon tile.
      const childMode =
        hasLocal && c.localPath ? previewModeFor(c.name) : null;
      const childFileUri =
        hasLocal && c.localPath
          ? c.localPath.startsWith("file://")
            ? c.localPath
            : `file://${c.localPath}`
          : null;
      const childPreviewUri =
        childMode === "image" ? childFileUri : null;
      const childVideoUri = childMode === "video" ? childFileUri : null;
      return {
        id: `${c.parentId}:${c.indexInBundle}:${c.name}`,
        name: displayName,
        iconName: fileIconName(c.name),
        previewUri: childPreviewUri,
        videoUri: childVideoUri,
        statusLabel,
        statusTone,
        isActiveShare: statusTone === "warning",
        dim: isMissing || !hasLocal,
        blink,
        onPress,
        onRightControlPress,
      };
    });
  }, [
    folderModalDrive,
    folderModalTransfer,
    folderModalTransferring,
    folderModalIsActive,
    childBlinkTarget,
    buildFolderChildren,
    onOpenFile,
    onStopSharing,
    previewFile,
    setLinkDraft,
    setPendingPreselection,
    showToast,
  ]);
  const folderModalStatus = folderModalDrive
    ? folderModalTransferring
      ? {
          label: `Sharing (${Math.round(
            Math.max(0, Math.min(100, folderModalTransfer?.percent ?? 0)),
          )}%)`,
          tone: "warning" as const,
        }
      : folderModalIsActive
        ? { label: "Active", tone: "primary" as const }
        : { label: "Inactive", tone: "muted" as const }
    : null;
  // Received-share rows don't expose Share-it / Stop-sharing in
  // this sprint — the engine maps activate by driveId, not shareKey, so
  // there's no clean "this share" toggle yet. Out of scope to wire fully.
  const kebabIsReceivedShare = !!kebabDrive?.share;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 4 }]}>
      {/* Shell: Files/Favorites tabs + search/filter/sort toolbar. Send /
       *  Receive / Settings are surfaced via the floating BottomToolbar
       *  (mounted below the list). In selection mode the tabs + toolbar
       *  swap for a "N Selected · Cancel · Delete" header. */}
      {selectionMode ? (
        <View style={styles.selectionHeader}>
          <Pressable
            onPress={exitSelectionMode}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
            style={styles.selectionHeaderBtn}
          >
            <Text style={styles.selectionHeaderCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.selectionHeaderCount}>
            {selectedIds.size} Selected
          </Text>
          <Pressable
            onPress={() => setConfirmBatchDelete(true)}
            disabled={selectedIds.size === 0}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Delete selected"
            style={styles.selectionHeaderBtn}
          >
            <Text
              style={[
                styles.selectionHeaderDelete,
                selectedIds.size === 0 && styles.selectionHeaderDeleteDisabled,
              ]}
            >
              Delete
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          <TopTabs
            value={viewMode}
            onChange={setViewMode}
            tabs={[
              { value: "all", label: "Files", accessibilityLabel: "Show all shares" },
              { value: "favorites", label: "Favorites", accessibilityLabel: "Show favorited shares" },
            ]}
          />
          <ListToolbar
            search={search}
            onSearchChange={setSearch}
            filter={filter}
            onFilterChange={setFilter}
            sort={sort}
            onSortChange={setSort}
          />
        </>
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.listFlex}>
          <FlatList
            data={flattenedList}
            keyExtractor={(it) => it.drive.id}
            renderItem={renderRow}
            style={styles.list}
            contentContainerStyle={[
              styles.listContent,
              flattenedList.length === 0 && styles.listContentEmpty,
              // Leave clearance for the floating BottomToolbar (~80px + safe area).
              // Clearance for the floating BottomToolbar (panel ~84 + lift 20 + safe area).
              { paddingBottom: 132 + insets.bottom },
            ]}
            ListEmptyComponent={emptyState}
            showsVerticalScrollIndicator={false}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Floating bottom toolbar — Send / Receive / Settings. */}
      <BottomToolbar
        onSend={() => setPickerSheet("share-files")}
        onReceive={() => setReceiveSheetVisible(true)}
        onSettings={() => navigation.navigate("Settings")}
      />

      {/* Receive sheet — hosts the paste-link + QR entry points now that
       *  the top action row is gone. */}
      <ReceiveSheet
        visible={receiveSheetVisible}
        onClose={() => {
          setReceiveSheetVisible(false);
          setReceiveFocusPaste(false);
        }}
        linkDraft={linkDraft}
        onLinkDraftChange={setLinkDraft}
        resolving={resolving}
        onAbortResolving={() => {
          abortResolving();
          setPendingPreselection(null);
          setLinkDraft("");
        }}
        onScan={(data) => {
          setReceiveSheetVisible(false);
          setReceiveFocusPaste(false);
          void resolveFromScan(data);
        }}
        linkError={linkError}
        onRetry={() => void retryResolve()}
        focusPaste={receiveFocusPaste}
      />

      {/* Send — centered modal card with Files + Photos and Recent Shares.
          Folder handler stays wired but the entry point is hidden in the UI. */}
      <SendSheet
        visible={pickerSheet === "share-files"}
        onClose={() => setPickerSheet(null)}
        onPickFiles={() => {
          // "Files" opens PearDrop's own picker. The OS
          // document picker is still one tap away inside it.
          setPickerSheet(null);
          setInAppPickerOpen(true);
        }}
        onPickPhotos={() => void onPickPhotosAndShare()}
        onPickFolder={() => void onPickFolderAndShare()}
        recentShares={recentShares}
        onCopyRecentLink={(link) => void onCopyLink(link)}
      />

      {/* In-app file selection — recents + one level of a
          SAF-granted Downloads folder, with the OS picker as fallback.
          Cancel routes through the shared picker-exit path so backing
          out of this screen behaves exactly like backing out of the OS
          picker: Send sheet restored, silent, nothing half-built. */}
      <FilePickerSheet
        visible={inAppPickerOpen}
        history={sharedPaths}
        busy={inAppPickerBusy}
        onCancel={() => {
          setInAppPickerOpen(false);
          handlePickerExit({ kind: "cancelled" }, { empty: "Nothing picked." });
        }}
        onConfirm={(entries) => void onConfirmInAppSelection(entries)}
        onReshare={(entry) => void onReshareEntry(entry)}
        onBrowseOther={() => void onPickAndShare()}
        onPickPhotos={() => void onPickPhotosAndShare()}
      />

      {/* Multi-file share name prompt. Opens after the OS picker returns
         >1 asset; on Share we hand the confirmed name off to
         `shareFilesAndTrack` so it's persisted alongside the drive. */}
      <NameShareModal
        visible={!!pendingNameShare}
        defaultName={pendingNameShare?.defaultName ?? ""}
        fileCount={pendingNameShare?.files.length ?? 0}
        onCancel={() => {
          setPendingNameShare(null);
          setShareBusy(false);
        }}
        onConfirm={(name) => {
          const pending = pendingNameShare;
          setPendingNameShare(null);
          if (!pending) return;
          void (async () => {
            try {
              await shareFilesAndTrack(pending.files, {
                customName: name,
                errorLabel:
                  pending.kind === "photos"
                    ? "Couldn't create that share."
                    : "Couldn't create that share — give it another go?",
              });
            } catch (e: unknown) {
              showToast(
                `Couldn't share — ${String((e as Error)?.message || e)}`,
                "error",
              );
            } finally {
              setShareBusy(false);
            }
          })();
        }}
      />

      {/* Per-drive kebab menu */}
      <KebabActionSheet
        visible={!!kebabSheet}
        onClose={() => setKebabSheet(null)}
        header={kebabHeader}
        items={((): KebabActionItem[] => {
          if (!kebabDrive) return [];
          const list: KebabActionItem[] = [
            {
              key: "info",
              icon: "information-circle-outline",
              label: "More info",
              onPress: () => {
                setQrDriveId(kebabDrive.id);
                setKebabSheet(null);
              },
            },
          ];
          // Multi-select entry: opens selection mode with the current
          // drive already selected. Hidden inside the row's kebab so it's
          // discoverable but not on the surface.
          list.push({
            key: "select-multiple",
            icon: "checkbox-outline",
            label: "Select multiple",
            onPress: () => {
              setSelectionMode(true);
              setSelectedIds(new Set([kebabDrive.id]));
              setKebabSheet(null);
            },
          });
          // Do NOT change the Open affordance — it stays
          // exactly as-is on single-file rows in the kebab menu.
          if (kebabOpenable && kebabDrive.primaryFile) {
            const f = kebabDrive.primaryFile;
            list.push({
              key: "open",
              icon: "open-outline",
              label: "Open in another app",
              onPress: () => {
                setKebabSheet(null);
                void onOpenFile(f.path);
              },
            });
          }
          list.push({
            key: "favorite",
            icon: kebabDrive.isFavorite ? "star" : "star-outline",
            label: kebabDrive.isFavorite
              ? "Remove from favorites"
              : "Add to favorites",
            activeTint: kebabDrive.isFavorite,
            onPress: () => {
              toggleFavorite(kebabDrive);
              setKebabSheet(null);
            },
          });
          // Kebab: Copy link + Show QR only make sense while the drive
          // is actively seeding — a dormant drive has no live link/QR to
          // hand out. When inactive, the "Start sharing" action at the
          // bottom is the meaningful next step instead.
          const shareLink = kebabDrive.shareLink;
          if (kebabActive && shareLink) {
            list.push({
              key: "copy",
              icon: "link-outline",
              label: "Copy Link",
              onPress: () => {
                setKebabSheet(null);
                void onCopyLink(shareLink);
              },
            });
          }
          if (kebabActive) {
            list.push({
              key: "qr",
              icon: "qr-code-outline",
              label: "Show QR",
              onPress: () => {
                setQrDriveId(kebabDrive.id);
                setKebabSheet(null);
              },
            });
          }
          // Retry surfaces inside the kebab (not on the row) when the
          // drive failed to hydrate or a transfer failed. Hosted drives
          // re-activate; received shares re-populate the paste field so
          // the auto-resolve loop kicks in again.
          if (kebabDrive && failedHydrationIds.has(kebabDrive.id)) {
            list.push({
              key: "retry",
              icon: "refresh-outline",
              label: "Retry",
              onPress: () => {
                setKebabSheet(null);
                if (kebabIsReceivedShare && kebabDrive.shareLink) {
                  setLinkDraft(kebabDrive.shareLink);
                  setReceiveSheetVisible(true);
                } else if (!kebabIsReceivedShare) {
                  void onShareIt(kebabDrive);
                }
              },
            });
          }
          list.push({
            key: "pin",
            icon: kebabDrive.isPinned ? "pin" : "pin-outline",
            label: kebabDrive.isPinned ? "Unpin" : "Pin to top",
            activeTint: kebabDrive.isPinned,
            onPress: () => {
              togglePinned(kebabDrive);
              setKebabSheet(null);
            },
          });
          if (!kebabIsReceivedShare && kebabActive) {
            list.push({
              key: "stop",
              icon: "stop-circle",
              label: "Stop sharing",
              tone: "danger",
              onPress: () => void onStopSharing(kebabDrive),
            });
          } else if (!kebabActive) {
            // Start sharing is offered for any inactive row — hosted or
            // received. For received-share synth rows the activate call
            // still routes through onShareIt; if the engine can't resume
            // by driveId yet the toast surfaces the failure.
            list.push({
              key: "share",
              icon: "share-outline",
              label: "Start sharing",
              onPress: () => void onShareIt(kebabDrive),
            });
          }
          list.push({
            key: "delete",
            icon: "trash-outline",
            label: "Delete",
            tone: "danger",
            onPress: () => onDelete(kebabDrive),
          });
          return list;
        })()}
      />

      {/* Drive info / QR modal — handles both active and inactive states. */}
      {(() => {
        const drive = qrDrive;
        const isActive = drive ? activeDriveIds.has(drive.id) : false;
        const status: "live" | "dormant" | "failed" =
          drive && failedHydrationIds.has(drive.id)
            ? "failed"
            : isActive
              ? "live"
              : "dormant";
        // The share link is a persistent property of the drive (hosted
        // links stay valid across activate/deactivate; received links are
        // always the string that grabbed the share), so we render the QR
        // regardless of live state. A same-height placeholder tile fills
        // in when the string is genuinely absent — see ShareQrModal.
        const link = drive?.shareLink ?? "";
        const t = drive ? transferByDriveId.get(drive.id) : undefined;
        // Header block: mirrors the ShareRow tile. For single-file drives
        // we pass the primary file's URI so the header shows a real image
        // or generated video frame; for bundles we lean on the filled
        // folder tile.
        const driveIsBundle = !!drive?.isBundle;
        const primary = drive?.primaryFile;
        const primaryName = primary?.name ?? drive?.files?.[0]?.name ?? "";
        const primaryMode = primary ? previewModeFor(primaryName) : null;
        const primaryFileUri = primary
          ? primary.path.startsWith("file://")
            ? primary.path
            : `file://${primary.path}`
          : null;
        const headerPreviewUri =
          !driveIsBundle && primaryMode === "image" ? primaryFileUri : null;
        const headerVideoUri =
          !driveIsBundle && primaryMode === "video" ? primaryFileUri : null;
        const fileCount = (drive?.files ?? []).length;
        const headerSubline = drive
          ? driveIsBundle
            ? `${fileCount} ${fileCount === 1 ? "File" : "Files"}`
            : primaryName
              ? humanFileType(primaryName).split(" ").pop() ?? "File"
              : "File"
          : "";
        // Rich file entries: attach preview / video URIs so the inline
        // file list renders thumbnails for image + video children too.
        const localByName = new Map(
          (drive?.localFiles ?? []).map((f) => [baseName(f.name), f]),
        );
        const richFiles = (drive?.files ?? []).map((f) => {
          const bn = baseName(f.name);
          const local = localByName.get(bn);
          const localUri = local?.path
            ? local.path.startsWith("file://")
              ? local.path
              : `file://${local.path}`
            : null;
          const mode = previewModeFor(bn);
          return {
            name: f.name,
            size: f.size,
            previewUri: mode === "image" ? localUri : null,
            videoUri: mode === "video" ? localUri : null,
          };
        });
        const typeLabel =
          drive && !driveIsBundle && primaryName
            ? humanFileType(primaryName)
            : null;
        return (
          <ShareQrModal
            visible={!!drive}
            link={link}
            title={driveIsBundle ? "Folder info" : "File info"}
            header={
              drive
                ? {
                    iconName: driveIconName(drive),
                    previewUri: headerPreviewUri,
                    videoUri: headerVideoUri,
                    name: rowDisplayName(drive),
                    subline: headerSubline,
                    isBundle: driveIsBundle,
                  }
                : undefined
            }
            isActive={isActive}
            info={
              drive
                ? {
                    status,
                    createdAt: drive.createdAt,
                    files: richFiles,
                    totalBytes: totalBytesOf(drive),
                    peerCount: t?.peersConnected ?? 0,
                    origin: drive.origin,
                    typeLabel,
                    transferring:
                      (t?.percent ?? 0) > 0 && (t?.percent ?? 0) < 100,
                  }
                : undefined
            }
            onClose={() => setQrDriveId(null)}
            onCopy={
              isActive && link ? () => void onCopyLink(link) : undefined
            }
            onRemove={
              drive && !isActive
                ? () => {
                    const d = drive;
                    setQrDriveId(null);
                    // ShareQrModal has already confirmed via its own themed
                    // modal — go straight to the destructive call rather
                    // than triggering a second confirmation here.
                    performDelete(d);
                  }
                : undefined
            }
            onActivate={
              drive && !isActive
                ? () => {
                    const d = drive;
                    void onShareIt(d);
                  }
                : undefined
            }
          />
        );
      })()}

      {/* Fullscreen takeover preview. Pure black behind
       *  the media. Chrome floats over the video and auto-hides during
       *  playback; image/text/audio keep chrome visible. Dismiss is the
       *  back arrow (or Android back button) — no tap-outside, no swipe.
       *  Custom video controls (no `nativeControls`) — playback toggles
       *  on any tap of the video tap-surface, mirroring the OS player. */}
      <Modal
        visible={!!preview}
        transparent={false}
        animationType="fade"
        onRequestClose={closePreview}
      >
        {preview?.mode === "text" ? (
          <View style={styles.fsTextRoot}>
            <ScrollView style={styles.fsTextScroll}>
              <Text style={styles.fsTextBody}>
                {previewText || "(Empty file)"}
              </Text>
            </ScrollView>
            <View style={[styles.fsTopBar, { paddingTop: insets.top + 4 }]}>
              <Pressable
                style={styles.fsTopBtn}
                onPress={closePreview}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={16}
              >
                <Ionicons name="arrow-back" size={24} color={theme.text} />
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.fsRoot}>
            <View style={styles.fsMediaWrap}>
              {preview?.mode === "image" && preview?.file && (
                <Image
                  source={{ uri: previewUri ?? undefined }}
                  style={styles.fsImage}
                  resizeMode="contain"
                />
              )}
              {preview?.mode === "video" && preview?.file && (
                <VideoView
                  player={videoPlayer}
                  style={styles.fsVideo}
                  allowsFullscreen={false}
                  nativeControls={false}
                  contentFit="contain"
                />
              )}
              {preview?.mode === "audio" && preview?.file && (
                <View style={styles.fsAudioShell}>
                  <View style={styles.fsAudioCover}>
                    <Ionicons name="musical-notes-outline" size={72} color="rgba(255,255,255,0.55)" />
                  </View>
                  <Text style={styles.fsAudioMeta} numberOfLines={1}>
                    {baseName(preview.file.name)}
                  </Text>
                  <View style={styles.fsAudioControlsRow}>
                    <Pressable
                      style={styles.fsAudioCtrlBtn}
                      onPress={() => onAudioSkip(-15)}
                      accessibilityRole="button"
                      accessibilityLabel="Skip back 15 seconds"
                    >
                      <Ionicons name="play-back" size={22} color="#fff" />
                    </Pressable>
                    <Pressable
                      style={styles.fsAudioPlayBtn}
                      onPress={() => {
                        if (!audioPlayer) return;
                        if (audioPlayer.playing) audioPlayer.pause();
                        else {
                          if (
                            audioStatus.didJustFinish ||
                            audioPlayer.currentTime >= audioPlayer.duration
                          ) {
                            audioPlayer.seekTo(0);
                          }
                          audioPlayer.play();
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={audioPlayer?.playing ? "Pause" : "Play"}
                    >
                      <Ionicons
                        name={audioPlayer?.playing ? "pause" : "play"}
                        size={28}
                        color="#000"
                      />
                    </Pressable>
                    <Pressable
                      style={styles.fsAudioCtrlBtn}
                      onPress={() => onAudioSkip(15)}
                      accessibilityRole="button"
                      accessibilityLabel="Skip forward 15 seconds"
                    >
                      <Ionicons name="play-forward" size={22} color="#fff" />
                    </Pressable>
                  </View>
                  <View style={styles.fsAudioScrubberRow}>
                    <Pressable
                      style={styles.fsScrubber}
                      onLayout={(e) => setScrubWidth(e.nativeEvent.layout.width)}
                      onPress={(e) => {
                        if (scrubWidth <= 0) return;
                        const x = e.nativeEvent.locationX;
                        onAudioSeekToFraction(Math.max(0, Math.min(1, x / scrubWidth)));
                      }}
                      accessibilityRole="adjustable"
                      accessibilityLabel="Audio progress"
                    >
                      <View style={styles.fsScrubberTrack}>
                        <View
                          style={[
                            styles.fsScrubberFill,
                            {
                              width: `${
                                audioDuration > 0
                                  ? Math.max(0, Math.min(100, (audioPosition / audioDuration) * 100))
                                  : 0
                              }%`,
                            },
                          ]}
                        />
                      </View>
                    </Pressable>
                    <View style={styles.fsTimeRow}>
                      <Text style={styles.fsTimeText}>{formatClock(audioPosition)}</Text>
                      <Text style={styles.fsTimeText}>
                        {audioDuration > 0 ? formatClock(audioDuration) : "—:—"}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </View>

            {/* Video tap surface — toggles play/pause + reveals chrome.
              *  Below the chrome icons in z-order so the icons remain
              *  tappable when visible. */}
            {preview?.mode === "video" && (
              <Pressable
                style={styles.fsTapLayer}
                onPress={onVideoTap}
                accessibilityRole="button"
                accessibilityLabel={videoIsPlaying ? "Pause video" : "Play video"}
              />
            )}

            {/* Center play overlay — only while video is paused. */}
            {preview?.mode === "video" && !videoIsPlaying && (
              <View pointerEvents="box-none" style={styles.fsCenterPlay}>
                <Pressable
                  style={styles.fsCenterPlayBtn}
                  onPress={onVideoTap}
                  accessibilityRole="button"
                  accessibilityLabel="Play"
                  hitSlop={8}
                >
                  <Ionicons name="play" size={36} color="rgba(255,255,255,0.92)" />
                </Pressable>
              </View>
            )}

            {/* Top bar holds only the back arrow. Three-dots
              *  removed in favor of an inline share button below the video.
              *  Safe-area top inset clears the status bar so the icon is
              *  fully tappable. Bigger touch target + hitSlop. */}
            <Animated.View
              pointerEvents={chromeVisible ? "box-none" : "none"}
              style={[
                styles.fsTopBar,
                { opacity: chromeOpacity, paddingTop: insets.top + 4 },
              ]}
            >
              <Pressable
                style={styles.fsTopBtn}
                onPress={closePreview}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={16}
              >
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </Pressable>
            </Animated.View>

            {/* Bottom bar — scrubber + times. Video only (audio's are
              *  inline above). Auto-hides with the top bar. */}
            {preview?.mode === "video" && (
              <Animated.View
                pointerEvents={chromeVisible ? "box-none" : "none"}
                style={[
                  styles.fsBottomBar,
                  {
                    opacity: chromeOpacity,
                    // Clear the gesture bar so the share
                    // button isn't flush against the bottom edge.
                    paddingBottom: insets.bottom + 16,
                  },
                ]}
              >
                <Pressable
                  style={styles.fsScrubber}
                  onLayout={(e) => setVideoScrubWidth(e.nativeEvent.layout.width)}
                  onPress={(e) => {
                    if (videoScrubWidth <= 0) return;
                    const x = e.nativeEvent.locationX;
                    onVideoSeekToFraction(
                      Math.max(0, Math.min(1, x / videoScrubWidth)),
                    );
                  }}
                  accessibilityRole="adjustable"
                  accessibilityLabel="Video progress"
                >
                  <View style={styles.fsScrubberTrack}>
                    <View
                      style={[
                        styles.fsScrubberFill,
                        {
                          width: `${
                            videoDuration > 0
                              ? Math.max(
                                  0,
                                  Math.min(
                                    100,
                                    (videoPosition / videoDuration) * 100,
                                  ),
                                )
                              : 0
                          }%`,
                        },
                      ]}
                    />
                  </View>
                </Pressable>
                <View style={styles.fsTimeRow}>
                  <Text style={styles.fsTimeText}>{formatClock(videoPosition)}</Text>
                  <Text style={styles.fsTimeText}>
                    {videoDuration > 0 ? formatClock(videoDuration) : "—:—"}
                  </Text>
                </View>
                {/* Share/stop-sharing toggle below the scrubber.
                  *  Only renders for hosted drives (received synth rows
                  *  can't activate via this path in this sprint).
                  *  - Stop sharing: deactivates inline, preview stays open
                  *  - Share it: closes the preview and opens the main-page
                  *    QR modal so the user can hand off the link */}
                {previewParentDrive ? (
                  <View style={styles.fsShareBtnRow}>
                    <Pressable
                      style={styles.fsShareBtn}
                      onPress={() => {
                        const d = previewParentDrive;
                        if (!d) return;
                        if (previewParentIsActive) {
                          void (async () => {
                            const res = await deactivateDrive(d.id);
                            if (!res.ok) {
                              showToast(
                                errorMessage(res.error) || "Couldn't stop that one.",
                                "error",
                              );
                              return;
                            }
                            haptics.actionDone();
                            showToast("Stopped sharing.");
                            void refreshDrives();
                          })();
                        } else {
                          closePreview();
                          void onShareIt(d);
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={
                        previewParentIsActive ? "Stop sharing" : "Share it"
                      }
                    >
                      <Ionicons
                        name={
                          previewParentIsActive
                            ? "pause-circle-outline"
                            : "share-outline"
                        }
                        size={16}
                        color="#fff"
                      />
                      <Text style={styles.fsShareBtnText}>
                        {previewParentIsActive ? "Stop sharing" : "Share it"}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </Animated.View>
            )}
          </View>
        )}
      </Modal>

      {/* Folder-contents modal. */}
      <FolderContentsModal
        visible={!!folderModalDrive}
        onClose={() => setFolderModalId(null)}
        folderName={
          folderModalDrive ? rowDisplayName(folderModalDrive) : "Folder"
        }
        metaLine={
          folderModalDrive
            ? `${(folderModalDrive.files ?? []).length} ${
                (folderModalDrive.files ?? []).length === 1 ? "File" : "Files"
              } · ${formatBytes(totalBytesOf(folderModalDrive))}`
            : ""
        }
        status={folderModalStatus}
        files={folderModalFiles}
        shareLink={folderModalDrive?.shareLink ?? null}
        onCopyLink={() => {
          const link = folderModalDrive?.shareLink;
          if (link) void onCopyLink(link);
        }}
        onStartSharing={
          folderModalDrive && !folderModalIsActive
            ? () => {
                const d = folderModalDrive;
                setFolderModalId(null);
                void onShareIt(d);
              }
            : undefined
        }
        onOverflowPress={
          folderModalDrive
            ? () => {
                const d = folderModalDrive;
                setFolderModalId(null);
                setKebabSheet({ drive: d });
              }
            : undefined
        }
      />

      <ConfirmModal
        visible={!!pendingDelete}
        title="Delete this drive?"
        body="Removes the data from your device. Can't undo."
        confirmLabel="Delete"
        cancelLabel="Keep"
        tone="destructive"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const d = pendingDelete;
          setPendingDelete(null);
          if (d) performDelete(d);
        }}
      />

      {/* Multi-select: batch delete confirmation. */}
      <ConfirmModal
        visible={confirmBatchDelete}
        title={`Delete ${selectedIds.size} ${selectedIds.size === 1 ? "share" : "shares"}?`}
        body="Removes the data from your device. Can't undo."
        confirmLabel="Delete"
        cancelLabel="Keep"
        tone="destructive"
        onCancel={() => setConfirmBatchDelete(false)}
        onConfirm={() => {
          const ids = Array.from(selectedIds);
          setConfirmBatchDelete(false);
          for (const id of ids) {
            const d = sortedDrives.find((s) => s.id === id);
            if (d) performDelete(d);
          }
          exitSelectionMode();
        }}
      />
    </View>
  );
}

