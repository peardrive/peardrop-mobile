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
  leafName,
  pickFolder,
  type PickedDirectory,
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
  fileExt,
  type IconName,
  type PreviewMode,
} from "../lib/files";
import { describeOpenFailure } from "../lib/openFileResult";
import {
  canConfirmShareName,
  checkShareName,
  defaultBundleName,
  prefillForSingleFile,
  splitExtension,
} from "../lib/shareName";
// Read-only use of the predicate. Importing it is how the menu and the
// foreground service stay on one definition of "in flight".
import { classifyTransfer } from "../lib/transferActivity";
import { describeSaveResult } from "../lib/saveToDownloadsResult";
import {
  isSaveToDownloadsAvailable,
  saveToDownloads,
} from "../lib/saveToDownloads";
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
  markFileMissing,
  setShareFavorite,
  setSharePinned,
  subscribeShares,
  type ReceivedShare,
} from "../state/receivedSharesStorage";
import {
  clearHostedShareFlags,
  loadHostedFlags,
  setHostedShareFavorite,
  setHostedSharePinned,
  subscribeHostedFlags,
  type HostedShareFlags,
} from "../state/hostedShareFlagsStorage";
import { formatBytes, formatClock, formatRelativeOrDate } from "../lib/format";
import {
  describeHoldings,
  holdingsBytesLabel,
  holdingsCountLabel,
} from "../lib/receivedHoldings";
// Every outcome of a row tap is named and tested in this module. A new one
// belongs there, not as another ad-hoc branch in `onTapRow`.
import { rowTapRoute } from "../lib/receivedRowRoute";
// The re-share decision and its vocabulary. `active` is not `announcing`,
// and the decision lives where the suite can assert it.
import {
  receivedShareIsAnnouncing,
  reshareControl,
  reshareStartOutcome,
  reshareStopOutcome,
  type ReshareMode,
  type ReshareSignals,
} from "../lib/reshareControl";
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
// `userFacingError`, not `errorMessage`.
import { userFacingError } from "../lib/errorMessage";
import { shareListEmptyState } from "../lib/shareListEmptyState";
import { extractKey } from "../lib/links";
// the confirm wording lives in a pure module
// so the suite can assert it; this file is unreachable from jest.
import { describeDeleteConfirm } from "../lib/deleteReceivedPlan";
// the row control decision, kept pure so
// the "no control may stop a share" guarantee is assertable.
import { folderRowControl } from "../lib/folderRowControl";
import {
  buildShareKeyDriveIndex,
  grabCompletionMessage,
  receiveRowStatus,
  resolveReceivedTransfer,
} from "../lib/receiveProgress";
import { hostedRowStatus } from "../lib/hostedRowStatus";
import {
  canOfferStartSharing,
  isSyntheticShareRowId,
  SYNTHETIC_SHARE_ROW_PREFIX,
} from "../lib/shareActions";
import {
  selectRecentShareRows,
  recentShareAction,
  RECENT_SHARES_LIMIT,
} from "../lib/recentShareLink";
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

// One-shot init to enable LayoutAnimation on Android. Runs after the import
// block so `import/first` does not flag it.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * Whether to offer "Save to Downloads" at all. Module scope rather than a
 * hook, since the answer cannot change during a session. False when the
 * native module is missing, so the menu item is absent rather than broken.
 */
const canSaveToDownloads = isSaveToDownloadsAvailable();

type DriveRow = DriveRecord & {
  /** Computed: the file used when tapping a single-file row opens a preview.
   *  Undefined for multi-file bundles (which expand instead). */
  primaryFile?: DriveLocalFile;
  /** True when files.length > 1. Bundles expand on tap; single files preview. */
  isBundle?: boolean;
  /** Present for synthesized received-share rows. When set, child file
   *  states are read from here rather than from the engine's join. */
  share?: ReceivedShare;
  /** Organizational flags, sourced from the share's own record when
   *  received and from the hosted-flags store when hosted. */
  isPinned?: boolean;
  isFavorite?: boolean;
};

/** Flattened list item driving the FlatList. Bundles do not expand inline;
 *  folder contents open in a modal. The discriminated shape is kept so the
 *  renderer signature stays stable. */
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
  /** Parent drive id, so the preview's menu can route back to the right
   *  drive record. */
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

// Folder-share cache names keep the user's original filename, and the URI
// comes back URL-encoded where the filesystem layer needs the decoded form.
// Picker URIs avoid this because their cache names are generated.
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

// Match "uuid.ext" or "uuid", so a received share whose filenames the peer
// synthesized as UUIDs does not show raw hex to the user.
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
    // Falls through when the only filename is UUID-shaped: prefer the
    // drive's own name, else a friendly type label.
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
    // Multi-select header, replacing the tabs and toolbar while active.
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
    // Name and optional pin marker side by side: the text shrinks and the
    // pin icon stays anchored at the end.
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
    // Fullscreen takeover: black background, with chrome floating over the
    // media by absolute positioning.
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
      // Horizontal padding keeps the back arrow off the screen edge; the
      // top inset is applied at render time so it clears the status bar.
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
      // A generous touch target, with padding so the icon does not sit hard
      // against the edge.
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
      // A fixed width, so the button does not resize when its label
      // toggles. Sized for the longer of the two labels.
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
    cancelInFlight,
    activateDrive,
    deactivateDrive,
    refreshDrives,
    // The flat field is where RN reads this. Never re-derive it from
    // `hyperdriveStatus`.
    manifestUnavailable,
  } = useBackend();

  const {
    linkDraft,
    setLinkDraft,
    resolving,
    linkError,
    retryResolve,
    setPendingPreselection,
    // The offline re-grab picker, reached from `onTapRow`.
    openStoredSharePicker,
    abortResolving,
    lastCompletedDownload,
    consumeCompletedDownload,
    manualEntryTick,
    resolveFromScan,
    // The live resolve session is the only source that knows which engine
    // driveId a share key maps to while the grab is still running: the
    // receive path emits no drive event, so `drives` learns of it only
    // once the download has finished.
    sessionDriveId,
    lastResolvedLink,
  } = useShareLinkFlow();

  const { show: showToastRaw } = useToast();
  const showToast = useCallback(
    (msg: string, kind: "info" | "success" | "error" = "info") =>
      showToastRaw(msg, { kind }),
    [showToastRaw],
  );

  const [pickerSheet, setPickerSheet] = useState<PickerSheet>(null);

  // A one-time hint the first time a picker is dismissed empty. Some
  // Android pickers expose no obvious back button, and the app cannot add UI
  // to the OS picker, so the gesture is taught once on return. The flag is
  // persisted, so it never fires again.
  const maybeShowPickerBackHint = useCallback(() => {
    void getPickerBackHintSeen().then((seen) => {
      if (seen) return;
      void setPickerBackHintSeen(true);
      showToast("Tap back or swipe from the edge to return next time.", "info");
    });
  }, [showToast]);

  // The single exit path for every non-selected picker outcome: restores
  // the sheet the picker was launched from, emits at most one toast, and
  // never falls through into share creation. The decision lives in
  // `lib/pickerResult` so it is testable without the native picker.
  const handlePickerExit = useCallback(
    (outcome: PickerOutcome, labels: { empty: string }) => {
      // Every non-selected pick outcome funnels through here, so one line
      // covers cancel and empty across all four picker entry points.
      debugLog("info", "rn.pick", `picker exit: ${outcome.kind}`);
      const plan = pickerExitPlan(outcome, labels);
      if (plan.reopenSendSheet) setPickerSheet("share-files");
      if (plan.toast) showToast(plan.toast);
      if (plan.showBackHint) maybeShowPickerBackHint();
    },
    [showToast, maybeShowPickerBackHint],
  );

  // PearDrop's own file-selection screen is the primary path for Files; the
  // OS document picker is the escape hatch behind it.
  const [inAppPickerOpen, setInAppPickerOpen] = useState(false);
  const [inAppPickerBusy, setInAppPickerBusy] = useState(false);

  const [kebabSheet, setKebabSheet] = useState<KebabSheet>(null);
  /**
   * The parked selection awaiting a name, for every share path. `ext` is the
   * fixed suffix shown beside the field for a single file: the user edits
   * the base, never the extension, and it is empty for bundles and folders.
   * `folder` carries the picked directory, because that path prompts before
   * enumerating.
   */
  type PendingNameShare = {
    kind: "files" | "photos" | "folder";
    defaultName: string;
    ext: string;
    files: { uri: string; name: string; size?: number }[];
    folder?: PickedDirectory;
    fileCount: number;
  };
  const [pendingNameShare, setPendingNameShare] =
    useState<PendingNameShare | null>(null);
  const setShareBusy = (_v: boolean) => {};
  const [qrDriveId, setQrDriveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewText, setPreviewText] = useState("");
  // Themed delete confirmation, holding the drive pending deletion or null,
  // so the dialog matches the app rather than the OS alert.
  const [pendingDelete, setPendingDelete] = useState<DriveRow | null>(null);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [scrubWidth, setScrubWidth] = useState(0);
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [videoPosition, setVideoPosition] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoScrubWidth, setVideoScrubWidth] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const chromeHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drive ids hidden while an engine purge is in flight, removed from the
  // set once the engine's drives list no longer contains them.
  const [optimisticallyDeleted, setOptimisticallyDeleted] = useState<Set<string>>(
    () => new Set(),
  );
  // Bumps whenever a swipe-then-confirm flow opens, so the row snaps closed
  // whether the user confirms or cancels.
  const [swipeCloseTick, setSwipeCloseTick] = useState(0);
  // Tapping a bundle opens a modal showing the folder's contents. The
  // driveId here is whichever folder is open, or null when dismissed.
  const [folderModalId, setFolderModalId] = useState<string | null>(null);
  /**
   * The live swarm mode of a received share, keyed by lower-cased share key.
   * Written only from an `activate` reply's `mode`, the one field that states
   * what the engine set up: `activeDriveIds` says nothing about announcing,
   * and `engineListDrives` reports persisted intent. Session-scoped, so an
   * empty map after a restart honestly means this session has not asked.
   */
  const [observedReshareModes, setObservedReshareModes] = useState<
    Record<string, ReshareMode>
  >({});
  const [sharedPaths, setSharedPaths] = useState<SharedFilePathsEntry[]>([]);
  const [receivedShares, setReceivedShares] = useState<ReceivedShare[]>([]);
  const [hostedFlags, setHostedFlags] = useState<HostedShareFlags[]>([]);
  // The view-mode toggle resets to "all" on mount on purpose, with no
  // persistence. Favorites is a filterable subset.
  const [viewMode, setViewMode] = useState<"all" | "favorites">("all");
  // Shell state: search, filter and sort applied on top of the view mode.
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [sort, setSort] = useState<SortId>("recent");
  const [receiveSheetVisible, setReceiveSheetVisible] = useState(false);
  // Bumped when Receive should open with the paste input focused.
  const [receiveFocusPaste, setReceiveFocusPaste] = useState(false);
  // Multi-select mode swaps the kebab for checkboxes and gives the header a
  // count. Exited by the Cancel button or when a batch action completes.
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
  // Watch the scanner's manual-entry signal and open Receive with the paste
  // input focused. The `manualEntryTick > 0` guard skips the initial mount.
  useEffect(() => {
    if (manualEntryTick <= 0) return;
    setReceiveFocusPaste(true);
    setReceiveSheetVisible(true);
  }, [manualEntryTick]);
  // Target set for the post-grab child-row blink, populated by an effect
  // watching `lastCompletedDownload`. The effect opens the folder modal
  // first when needed, so the rows arrive and then blink in sequence.
  const [childBlinkTarget, setChildBlinkTarget] = useState<{
    shareKey: string;
    names: Set<string>;
  } | null>(null);

  // Subscribe to the RN-side cache-path store. Hosted drives carry no
  // localFiles in the engine manifest, and this fills that gap.
  useEffect(() => {
    void loadSharedFilePaths().then(setSharedPaths);
    return subscribeSharedFilePaths(setSharedPaths);
  }, []);

  // Subscribe to the per-share storage, so received bundles re-render in
  // place when a download completes and flips a file's downloaded flag.
  useEffect(() => {
    void loadShares().then(setReceivedShares);
    return subscribeShares(setReceivedShares);
  }, []);

  // Subscribe to hosted-share flags, so toggling pin or favorite re-renders
  // and re-sorts the list at once.
  useEffect(() => {
    void loadHostedFlags().then(setHostedFlags);
    return subscribeHostedFlags(setHostedFlags);
  }, []);

  const hostedFlagsByDriveId = useMemo(() => {
    const m = new Map<string, HostedShareFlags>();
    for (const f of hostedFlags) m.set(f.driveId, f);
    return m;
  }, [hostedFlags]);

  // When a grab completes, open the folder-contents modal if it is not
  // already showing that folder, then blink the completed rows. The timers
  // are refs so they survive the re-renders in between and are cancelled
  // only on an explicit re-trigger or unmount.
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
    // Say that the grab finished, and how much of it finished. A
    // notification cannot cover this: `notifyTransferComplete` returns early
    // while the app is foregrounded, so without this a truncated grab and a
    // whole one would look the same.
    const completion = grabCompletionMessage({
      saved: lastCompletedDownload.saved,
      failed: lastCompletedDownload.failed,
      // A cancelled grab gets stopped-and-saved wording, not the partial
      // wording, which would read as a transfer that broke.
      cancelled: lastCompletedDownload.cancelled,
    });
    showToast(completion.text, completion.kind);
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
  }, [lastCompletedDownload, folderModalId, consumeCompletedDownload, showToast]);

  const sharedPathsByDriveId = useMemo(() => {
    const m = new Map<string, SharedFilePath[]>();
    for (const e of sharedPaths) m.set(e.driveId, e.files);
    return m;
  }, [sharedPaths]);

  // Most recent activity first; active state does not affect ordering, so
  // items never jump as they transition. Two sources merge into one list:
  // hosted drives from the engine manifest, and one row per received share
  // key however many engine drives that key has produced. The engine's
  // received-side drives stay hidden, being a per-paste session detail.
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
        // A new share's name comes from the engine, since the naming step
        // passes it at creation and the receiver sees it. `customName` is a
        // later local rename and wins here: renaming a share you already
        // have is a local act, and should not be overridden by the name it
        // shipped with. `rowDisplayName` reads `name` and truncates.
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

    // Two-level sort: pinned shares first, then recency within each group.
    // Applies in both the All and Favorites views.
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

  /**
   * Maps a share key to a driveId, so a received row can find its own
   * transfer. Received rows are synthesized one per share key with an id
   * that is not a driveId, so the lookup hosted rows use could never hit
   * for them and download progress would render nowhere.
   */
  const shareKeyDriveIndex = useMemo(
    () =>
      buildShareKeyDriveIndex(drives, {
        shareKey: lastResolvedLink ? extractKey(lastResolvedLink) : null,
        driveId: sessionDriveId,
      }),
    [drives, lastResolvedLink, sessionDriveId],
  );

  /**
   * The transfer for a row, whichever origin it has. Hosted rows key off
   * the engine driveId directly; received rows go through the share-key
   * index above.
   */
  const transferForRow = useCallback(
    (row: DriveRow) =>
      row.origin === "received"
        ? resolveReceivedTransfer(row.key, shareKeyDriveIndex, transferByDriveId)
        : transferByDriveId.get(row.id),
    [shareKeyDriveIndex, transferByDriveId],
  );

  /**
   * Every input the re-share decision reads, gathered once per row. Built
   * here rather than at each of the three surfaces that need it, so the
   * condition cannot drift between them; the decision itself lives in
   * `reshareControl`. `driveId` prefers the value persisted on the record
   * and falls back to the derived index, the only source that knows the
   * mapping for a grab that finished this session.
   */
  const reshareSignalsFor = useCallback(
    (row: DriveRow): ReshareSignals => {
      const shareKey = (row.share?.shareKey ?? "").toLowerCase();
      const holdings = row.share ? describeHoldings(row.share.files) : null;
      const engine = shareKey
        ? (drives ?? []).find(
            (d) =>
              d.origin === "received" &&
              String(d.key ?? "").toLowerCase() === shareKey,
          )
        : undefined;
      return {
        origin: row.origin,
        complete: !!holdings?.allHeld,
        driveId:
          row.share?.driveId ?? shareKeyDriveIndex.get(shareKey) ?? null,
        reshared: engine?.reshared === true,
        sessionUp: !!engine && !failedHydrationIds.has(engine.id),
        observedMode: observedReshareModes[shareKey] ?? null,
      };
    },
    [drives, failedHydrationIds, observedReshareModes, shareKeyDriveIndex],
  );

  // Recent hosted shares for the Send sheet; `shareLink` alone does not say whether
  // a share announces, so both drive sets feed `recentShareAction` and the deps below.
  const recentShares = useMemo<RecentShareItem[]>(() => {
    return selectRecentShareRows(sortedDrives, RECENT_SHARES_LIMIT)
      .map((d) => ({
        id: d.id,
        name: rowDisplayName(d),
        meta: `${formatBytes(totalBytesOf(d))} · ${
          formatRelativeOrDate(d.lastActivityAt ?? d.createdAt) ?? "—"
        }`,
        icon: driveIconName(d),
        shareLink: d.shareLink,
        action: recentShareAction(d, activeDriveIds, failedHydrationIds),
      }));
  }, [sortedDrives, activeDriveIds, failedHydrationIds]);

  // The view-mode filter applies after the primary recency sort, then
  // search, filter and the user-selected sort layer on top. Pinned rows
  // always float to the top within the active view.
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

  // Reconcile the optimistic-delete set, dropping any id the engine has
  // already pruned. Without this the set grows forever in a long session.
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

  // The list emits only drive rows; bundle contents live in the folder
  // modal. Memoized so downstream identity is stable across re-renders that
  // do not change the visible slice.
  const flattenedList = useMemo<ListItem[]>(
    () => visibleDrives.map((d) => ({ kind: "drive", drive: d })),
    [visibleDrives],
  );

  // Build the file list for a bundle drive. A received bundle reads its
  // files directly; a hosted one joins the manifest to the local files.
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
  // Resolve the preview's parent drive, so the bottom share button knows
  // what to toggle. Null for a synthesized received row, which exposes no
  // activate path, so the button is omitted there.
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

  // Poll the audio position while the preview is open: the player exposes
  // `playing` reactively but not the current time, so the scrubber needs a
  // steady read.
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

  // Poll the video position while the takeover is open, mirroring the audio
  // pattern, since there is no reactive playing flag to subscribe to.
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

  // Chrome auto-hide for the video takeover: visible while paused, fading
  // out after a pause in taps while playing, and any tap brings it back and
  // resets the timer. `scheduleChromeHide` is a no-op outside video, so
  // every other media type keeps its chrome.
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

  // Tapping the video toggles playback and keeps the chrome visible: it is
  // the primary pause gesture once a video is running. The center button
  // still covers the just-opened-and-paused case.
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
          // The resolved result is read, not discarded: a launch whose
          // activity refuses and finishes at once still resolves
          // successfully, and that silent path looks like nothing happened.
          const startedAt = Date.now();
          const result = await IntentLauncher.startActivityAsync(
            "android.intent.action.VIEW",
            {
              data: contentUri,
              flags: 1,
              type: mimeFromName(baseName(path)),
            },
          );
          const failure = describeOpenFailure({
            resultCode: Number(result?.resultCode),
            elapsedMs: Date.now() - startedAt,
            ext: fileExt(baseName(path)),
          });
          if (failure) showToast(failure, "error");
          return;
        }
        await Linking.openURL(fileUri);
      } catch (e: unknown) {
        // The raw native message goes to the log, where a diagnosis belongs;
        // the user gets a line that is true.
        logStructuredError("rn.open", "openURL failed", e);
        showToast("Can't open that one. Try another app?", "error");
      }
    },
    [showToast],
  );

  /**
   * The export route for a received file. Received files land in app-private
   * storage that no other app can reach, so this is the only way out, and it
   * is a native module: the JS path materialises the whole file as a base64
   * string and runs out of memory. The wording lives in
   * `describeSaveResult`, which is pure and tested. Opening in another app
   * is a different feature and stays: it hands a file to a viewer rather
   * than putting a copy anywhere.
   */
  const onSaveToDownloads = useCallback(
    async (path: string, displayName?: string) => {
      const name = displayName ?? baseName(path);
      const result = await saveToDownloads(path, name, mimeFromName(name));
      const message = describeSaveResult(result);
      if (!result.ok) {
        // The toast says one honest line; the code and message go to the log
        // so a field report can be diagnosed without another device session.
        logStructuredError(
          "rn.save",
          `save to downloads failed name=${name} code=${result.code}`,
          result.message,
        );
      } else {
        haptics.actionDone();
      }
      showToast(message.text, message.kind);
    },
    [showToast],
  );

  // A bundle tap opens the folder-contents modal rather than expanding.
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
        // Write the finding down rather than discarding it: the check has
        // proved the file is gone, and leaving the record claiming otherwise
        // makes the next render withhold the re-grab affordance, which is
        // gated on `isMissing`. Only a received row has a share record to
        // repair, and the prefix is taken from where it is minted so the two
        // cannot drift.
        if (parentDriveId && isSyntheticShareRowId(parentDriveId)) {
          void markFileMissing(
            parentDriveId.slice(SYNTHETIC_SHARE_ROW_PREFIX.length),
            file.path,
          );
        }
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
          // The same rule as the toast sites, rendered into the preview pane.
          logStructuredError("rn.preview", "text preview read failed", e);
          setPreviewText("Can't preview this one.");
        }
      }
    },
    [audioPlayer, videoPlayer, onOpenFile, showToast],
  );

  /**
   * Where a tap on a row goes. The decision is not made here: a decision
   * made inline is one no test can observe, so every outcome is ordered and
   * tested in `src/lib/receivedRowRoute.ts` and this only dispatches.
   * `describeHoldings` is passed in rather than recomputed, so the routing
   * and the row's own labels cannot disagree.
   */
  const onTapRow = useCallback(
    async (drive: DriveRow) => {
      const share = drive.share;
      const route = rowTapRoute({
        origin: drive.origin,
        isBundle: drive.isBundle,
        hasPrimaryFile: !!drive.primaryFile,
        hasStoredShare: !!share,
        holdings: share ? describeHoldings(share.files) : null,
      });
      if (route === "regrab-picker" && share) {
        // Opens from disk; the resolve the grab needs runs in parallel.
        openStoredSharePicker(share);
        return;
      }
      if (route === "folder-modal") {
        // Bundles open the folder-contents modal: there is no single content
        // to preview. The kebab still covers the whole folder.
        openFolderModal(drive.id);
        return;
      }
      if (route === "file-preview" && drive.primaryFile) {
        await previewFile(drive.primaryFile, drive.id);
        return;
      }
      // Nothing to preview and nothing to re-grab, so open the info panel.
      // A received row opens in the received presentation, which drops Start
      // sharing and the seeding fields: its id is one the engine cannot
      // resolve, so offering to start sharing would be a lie.
      setQrDriveId(drive.id);
    },
    [previewFile, openFolderModal, openStoredSharePicker],
  );

  // Shared share-then-persist path used by the file-picker, photo-picker,
  // and folder-picker flows. `customName`, when non-empty, is stored on
  // the hosted-share flags so downstream reads (list card, File info
  // modal) show the user-supplied title.
  async function shareFilesAndTrack(
    files: { uri: string; name: string; size?: number }[],
    opts: {
      relPaths?: string[];
      /**
       * The name the user chose, passed to the engine at creation so it
       * reaches the wire and the receiver. The engine is the one source of
       * truth for a new share's name; `customName` is a separate feature, a
       * later local rename that never leaves this device.
       */
      shareName?: string | null;
      errorLabel: string;
    },
  ) {
    if (!files.length) {
      debugLog("warn", "rn.share", "shareFilesAndTrack called with zero files");
      showToast("Nothing picked.");
      return;
    }
    // The single funnel for share creation: every picker path lands here.
    debugLog(
      "info",
      "rn.share",
      `share create: files=${files.length} folderShare=${!!opts.relPaths} ` +
        `shareName=${opts.shareName ? JSON.stringify(opts.shareName) : "-"} ` +
        `bytes=${files.reduce((a, f) => a + (f.size ?? 0), 0)}`,
    );
    const out = await sharePaths(
      files.map((f) => f.uri),
      opts.relPaths,
      opts.shareName ?? undefined,
    );
    if (!out.ok || !out.shareLink) {
      logStructuredError("rn.share", "share create failed", out.error);
      // Discarding `out.error` would make a manifest-unavailable rejection
      // invite a retry the engine is guaranteed to refuse. `userFacingError`
      // keeps the caller's fallback for every other cause and substitutes
      // only where there is something true to say.
      showToast(userFacingError(out.error, opts.errorLabel), "error");
      return;
    }
    debugLog("info", "rn.share", `share created drive=${out.driveId ?? "?"}`);
    // Ask for notification permission at the first moment there is
    // something worth being notified about. The lazy request inside
    // `notifyTransferComplete` stays as a backstop, but alone it would
    // prompt at a backgrounded completion, the likeliest denial. Fire and
    // forget: nothing below waits on an OS dialog, and a denial is silent.
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
   * Build the naming-step state for a picked selection, in one place because all
   * three picker paths reach it. A single file prefills from its base name, or from
   * the human type label when the name is UUID-shaped, keeping the real extension;
   * a bundle prefills a common base, else "Photos"/"Files".
   */
  function pendingShareFor(
    kind: "files" | "photos",
    files: { uri: string; name: string; size?: number }[],
  ): PendingNameShare {
    if (files.length === 1) {
      const only = files[0]!;
      // The BASE comes from the picker's reported name, which is the
      // human-facing one (and the one that may be UUID-shaped).
      const { base } = prefillForSingleFile(
        only.name,
        typeLabelForFile(only.name).replace(/^Shared /, "") || defaultShareName(kind, 1),
        isUuidLikeName,
      );
      // The extension comes from the URI, not from `name`: the picker's
      // reported extension can differ from the cache file's, and the engine
      // derives its own from the cache path. Reading the suffix from the
      // same place the engine will read it keeps them from doubling up.
      const { ext } = splitExtension(baseName(normalizeLocalPath(only.uri)));
      return { kind, defaultName: base, ext, files, fileCount: 1 };
    }
    return {
      kind,
      defaultName: defaultBundleName(
        files.map((f) => f.name),
        defaultShareName(kind, files.length),
      ),
      ext: "",
      files,
      fileCount: files.length,
    };
  }

  /**
   * selection confirmed in the in-app picker.
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
      // Every share is named, a single file included: a filename does not
      // always read as a name, least of all a UUID-shaped cache name.
      setPendingNameShare(pendingShareFor("files", files));
      return;
    } catch (e: unknown) {
      logStructuredError("rn.share", "in-app picker share failed", e);
      showToast("Couldn't share those — give it another go?", "error");
    } finally {
      setInAppPickerBusy(false);
    }
  }

  /**
   * one-tap re-share from the "Recent shares" section.
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
    // These double as the in-app picker's escape hatches, so dismiss it
    // before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: true,
      });
      // Cancel and empty both exit through `handlePickerExit`: a clean
      // return to the Send sheet, with no half-started share.
      const outcome = classifyPickerResult(res.canceled, selectFiles(res));
      if (outcome.kind !== "selected") {
        handlePickerExit(outcome, { empty: "Nothing picked." });
        return;
      }
      const files = outcome.files;
      setPendingNameShare(pendingShareFor("files", files));
      return;
    } catch (e: unknown) {
      if (isPickerCancellation(e)) {
        handlePickerExit({ kind: "cancelled" }, { empty: "Nothing picked." });
        return;
      }
      logStructuredError("rn.share", "file share failed", e);
      showToast("Couldn't share those — give it another go?", "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickFolderAndShare() {
    setPickerSheet(null);
    // These double as the in-app picker's escape hatches, so dismiss it
    // before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      const dir = await pickFolder();
      // `pickFolder` returns null on a back-out. Route it through the shared
      // exit so the folder picker behaves like the other two.
      if (!dir) {
        handlePickerExit(
          { kind: "cancelled" },
          { empty: "That folder had nothing to share." },
        );
        return;
      }
      // prompt for the name HERE, before `enumerateFolder`.
      //
      // Enumeration copies every file in the folder into the app cache
      // (`materializeToCache`), so a naming step placed after it would leave
      // N cache copies behind on cancel. Prompting first makes the guarantee
      // structural rather than something to clean up: cancel returns before
      // any file is touched, and `sharePaths` is never called, so there is no
      // drive, no corestore and no manifest entry either.
      //
      // The folder's own name is the prefill and is available from the
      // directory URI at this point — which is also the better default.
      setPendingNameShare({
        kind: "folder",
        defaultName: leafName(dir.uri) || "Folder",
        ext: "",
        files: [],
        folder: dir,
        // Unknown until enumeration. The subtitle reads "This folder will
        // share under this name." rather than claiming a count we have not
        // counted.
        fileCount: 0,
      });
      return;
    } catch (e: unknown) {
      logStructuredError("rn.share", "folder share failed", e);
      showToast("Couldn't share that folder — give it another go?", "error");
    } finally {
      setShareBusy(false);
    }
  }

  /** the folder path's real work, run only after the name is confirmed. */
  async function enumerateAndShareFolder(dir: PickedDirectory, shareName: string) {
    setShareBusy(true);
    try {
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
      // the confirmed name becomes the share title, which the
      // receiver uses as the folder name for the wrapped download.
      const out = await sharePaths(paths, relPaths, shareName);
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
      // "Folder error:" prefixing an errno
      // string told the user nothing they could act on.
      logStructuredError("rn.share", "folder pick failed", e);
      showToast("Couldn't read that folder — give it another go?", "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickPhotosAndShare() {
    setPickerSheet(null);
    // These double as the in-app picker's escape hatches, so dismiss it
    // before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      // `launchImageLibraryAsync` can throw outright on some ROMs. A throw that
      // reads as a back-out is a cancel; anything else falls back to the SAF picker.
      let outcome: PickerOutcome;
      try {
        const res = await ImagePicker.launchImageLibraryAsync({
          // images AND videos. The photos entry point used to
          // pass MediaTypeOptions.Images, so a video was unreachable from
          // it at any tap count and had to be hunted down through Files.
          //
          // This needs NO manifest change and NO media permission: on
          // Android the picker resolves to androidx PickVisualMedia (the
          // system photo picker), which hands back a transient read grant
          // per item. The READ_MEDIA_* strip stays exactly as it is.
          //
          // Array form rather than the MediaTypeOptions enum — the enum is
          // deprecated in expo-image-picker 17.
          mediaTypes: ["images", "videos"],
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
            // widened alongside the primary picker. This is the
            // OEM-throw escape hatch, so leaving it at "image/*" would
            // have meant videos were reachable on most devices and
            // silently absent on exactly the ROMs that already misbehave.
            type: ["image/*", "video/*"],
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
      setPendingNameShare(pendingShareFor("photos", files));
      return;
    } catch (e: unknown) {
      if (isPickerCancellation(e)) {
        handlePickerExit({ kind: "cancelled" }, { empty: "No photos picked." });
        return;
      }
      logStructuredError("rn.share", "photo share failed", e);
      showToast("Couldn't share those photos — give it another go?", "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onShareIt(drive: DriveRow) {
    setKebabSheet(null);
    const res = await activateDrive(drive.id);
    if (!res.ok) {
      // `errorMessage(...) || fallback` LOOKED
      // like it had a safety net and did not — a structured engine error always
      // carries a message, so the fallback could never fire and "Engine not
      // initialized." rendered instead. `userFacingError` makes the fallback the
      // thing that actually shows.
      logStructuredError("rn.share", "activate failed", res.error);
      showToast(userFacingError(res.error, "Couldn't activate that one."), "error");
      return;
    }
    haptics.success();
    setQrDriveId(drive.id);
    void refreshDrives();
  }

  /**
   * "Share again" on a Recent Shares row. Starts sharing first and then offers the
   * link, through the one hosted activation path in this screen; the Send sheet is
   * dismissed first so two RN modals do not stack. Received rows are refused twice:
   * their id is `share:<shareKey>`, which `engineActivateDrive` cannot find.
   */
  function onShareAgainFromRecents(id: string) {
    const drive = sortedDrives.find((d) => d.id === id);
    if (!drive) return;
    if (drive.origin === "received") return;
    setPickerSheet(null);
    if (
      canOfferStartSharing({
        id: drive.id,
        origin: drive.origin,
        isActive: activeDriveIds.has(drive.id),
      })
    ) {
      void onShareIt(drive);
      return;
    }
    // Hydration failed, so the drive is still in `activeDriveIds` and re-activating
    // early-returns without re-attaching a swarm. Open the modal, which says "failed".
    setQrDriveId(drive.id);
  }

  // useCallback so the identity is stable across renders and the row
  // memo below doesn't invalidate every tick.
  const onStopSharing = useCallback(
    async (drive: DriveRow) => {
      setKebabSheet(null);
      const res = await deactivateDrive(drive.id);
      if (!res.ok) {
        // see the activate site above.
        logStructuredError("rn.share", "stop failed", res.error);
        showToast(userFacingError(res.error, "Couldn't stop that one."), "error");
        return;
      }
      haptics.actionDone();
      showToast("Stopped sharing.");
      void refreshDrives();
    },
    [deactivateDrive, refreshDrives, showToast],
  );

  /**
   * One handler for both directions of re-sharing a received copy. `onShareIt`
   * passes no `opts` at all — the third state — which keeps a hosted drive
   * announcing and a received one client-only; do not route it through here. Stop is
   * `serve: false`: deactivating leaves the persisted `reshared` intent set, so the
   * engine's boot rule would re-announce the copy on the next launch.
   */
  const onReshare = useCallback(
    async (drive: DriveRow, serve: boolean) => {
      setKebabSheet(null);
      const shareKey = (drive.share?.shareKey ?? "").toLowerCase();
      const signals = reshareSignalsFor(drive);
      const driveId = signals.driveId;
      if (!driveId || !shareKey) return;
      const res = await activateDrive(driveId, { serve });
      const out = serve ? reshareStartOutcome(res) : reshareStopOutcome(res);
      // Record the mode the engine REPORTED, whatever it was. This is the
      // value every Copy Link / QR gate reads, so writing an optimistic one
      // here would hand out a link for a swarm that does not exist.
      setObservedReshareModes((prev) =>
        prev[shareKey] === out.mode ? prev : { ...prev, [shareKey]: out.mode },
      );
      if (out.kind === "failed") {
        logStructuredError(
          "rn.share",
          serve ? "re-share failed" : "re-share stop failed",
          res.error,
        );
        showToast(userFacingError(res.error, out.text), "error");
        return;
      }
      if (out.tone === "success") haptics.actionDone();
      showToast(out.text, out.tone);
      void refreshDrives();
    },
    [activateDrive, refreshDrives, reshareSignalsFor, showToast],
  );

  // Sprint 3M: unified pin / favorite toggles. Route to the right storage
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
      if (drive.share) {
        // received share. Drop the per-share record, then purge
        // every engine drive whose key matches — the share may have produced
        // several short-lived engine drive entries across re-pastes.
        const shareKey = drive.share.shareKey;
        // `deleteShare` now removes the app's
        // own copies under `downloads/` as well as the record — see its header
        // for why the removal lives in the store and not here.
        //
        // The toast used to fire above this block, before any delete had been
        // attempted, in both branches. It now waits for the part of the work
        // this realm can actually observe, and says something different when a
        // file would not go. The engine's corestore purge below stays
        // fire-and-forget; the row has already left the list either way.
        void (async () => {
          const { failed } = await deleteShare(shareKey);
          showToast(
            failed.length === 0
              ? "Deleted."
              : failed.length === 1
                ? "Deleted. One file couldn't be removed."
                : `Deleted. ${failed.length} files couldn't be removed.`,
          );
        })();
        const matchingEngineIds = (drives ?? [])
          .filter((d) => d.origin === "received" && d.key === shareKey)
          .map((d) => d.id);
        for (const eid of matchingEngineIds) {
          void cancelTransfer(eid, { purge: true });
        }
        void refreshDrives();
      } else {
        showToast("Deleted.");
        // Hosted drive — the existing fire-and-forget engine purge.
        void cancelTransfer(id, { purge: true }).then(() => {
          void refreshDrives();
        });
        void removeSharedFilePaths(id);
        // drop the organizational flags too — a future fresh
        // share that happens to reuse the driveId shouldn't inherit them.
        void clearHostedShareFlags(id);
      }
    },
    [cancelTransfer, drives, refreshDrives, showToast],
  );

  /**
   * Cancel an in-flight download from the row menu, through the single
   * `cancelInFlight` implementation rather than a copy. No confirmation, unlike
   * `onDelete`: cancelling keeps every byte already written, and a confirm on a
   * reversible action trains people to dismiss the irreversible one next to it.
   * The engine settles the row; nothing optimistic is written here.
   */
  const onCancelDownload = useCallback(
    async (drive: DriveRow) => {
      setKebabSheet(null);
      // Same id set as `performDelete` and `kebabDownloadInFlight`: a received
      // synth row may be backed by several engine drive entries.
      const ids = new Set<string>([drive.id]);
      const shareKey = drive.share?.shareKey;
      if (shareKey) {
        for (const d of drives ?? []) {
          if (d.origin === "received" && d.key === shareKey) ids.add(d.id);
        }
      }
      for (const id of ids) void cancelInFlight(id);
      haptics.actionDone();
    },
    [cancelInFlight, drives],
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
      // drive row (v5 ShareRow) — v5 folder modal removed the child branch.
      const drive = item.drive;
      const isActive = activeDriveIds.has(drive.id);
      const isFailed = failedHydrationIds.has(drive.id);
      const name = rowDisplayName(drive);
      const bytes = totalBytesOf(drive);
      const ts = drive.lastActivityAt ?? drive.createdAt;
      /**
       * A received row must report what this device has, not what was sent:
       * without an `isDownloaded` filter a share where 3 of 12 files landed
       * reads exactly like one where all 12 did. Hosted rows keep the manifest
       * total, which is what you have when you are serving the share.
       */
      const holdings = drive.share ? describeHoldings(drive.share.files) : null;
      const meta = `${
        holdings ? holdingsBytesLabel(holdings) : formatBytes(bytes)
      } · ${formatRelativeOrDate(ts) ?? "—"}`;
      const t = transferForRow(drive);
      const isReceived = drive.origin === "received";
      // the `transferring` local that used to live here moved
      // into `hostedRowStatus` with the rest of the hosted chain. It had one
      // reader, and leaving it behind would have left two definitions of
      // "is this share in flight" to drift apart.
      const iconName = driveIconName(drive);
      const isBundle = !!drive.isBundle;
      const peers = t?.peersConnected ?? 0;
      const indicatorState: ActiveIndicatorState = isActive
        ? peers > 0
          ? "active-broadcasting"
          : "active-idle"
        : "inactive";

      // v5 status sub-line: `<Type> · <StateLabel>` pattern matching the
      // design deck. Type prefix comes from the primary file's mode for
      // single-file rows, or a "N files" summary for bundles.
      const typePrefix = ((): string => {
        const files = drive.files ?? [];
        // A received bundle states how many of its files are actually here; a
        // hosted bundle keeps the plain count, true of a share you are serving.
        if (isBundle && holdings) return holdingsCountLabel(holdings, "Files");
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
      } else if (isReceived) {
        // received rows get their own state machine. The hosted
        // branch below says "Sharing", which is wrong wording for a grab,
        // and — more importantly — its in-flight guard excludes
        // percent >= 100, so a download sitting at 100 while the engine
        // still pipes files to disk fell through to "Active" or to nothing
        // at all. That made a finished download and a stalled one look
        // identical, which was the actual complaint. `receiveRowStatus`
        // separates "Finishing…" from the terminal "Saved".
        const receive = receiveRowStatus(t);
        status =
          receive.state === "idle"
            ? isActive
              ? { label: `${typePrefix} · Active`, tone: "primary" }
              : null
            : { label: `${typePrefix} · ${receive.label}`, tone: receive.tone };
      } else {
        // the hosted chain that used to be inline here —
        // Sharing / Completed / Active — moved to `hostedRowStatus`, with a
        // `cancelled` branch AHEAD of it. `markCancelled` sets
        // `completed: true` on both origins, so a hosted share the user
        // stopped fell to the `completed` arm and read "Completed". Fixing
        // it in place would have been a change no test could reach: this
        // file is `.tsx`, and the suite collects only `*.test.ts`.
        const hosted = hostedRowStatus(t, { isActive });
        status =
          hosted.state === "idle"
            ? null
            : { label: `${typePrefix} · ${hosted.label}`, tone: hosted.tone };
      }

      // v5 thumbnail: show the primary file's image directly for single-file
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
      transferForRow,
    ],
  );

  /**
   * An empty list that is actually a failure must not render as an absence, so
   * this cannot branch on `viewMode` alone. The decision itself is in
   * `src/lib/shareListEmptyState.ts` so it can be tested: `jest.config.js` cannot
   * import a `.tsx`. Key any new error state off `state.isError`, not `state.kind`.
   */
  const emptyState = useMemo(() => {
    const state = shareListEmptyState({ manifestUnavailable, viewMode });
    return (
      <EmptyState
        icon={state.icon as React.ComponentProps<typeof EmptyState>["icon"]}
        title={state.title}
        subtitle={state.subtitle}
        isError={state.isError}
      />
    );
  }, [manifestUnavailable, viewMode]);

  const kebabDrive = kebabSheet?.drive;
  const kebabActive = kebabDrive ? activeDriveIds.has(kebabDrive.id) : false;
  const kebabOpenable = kebabDrive ? isOpenableInOtherApp(kebabDrive) : false;

  // v5: identity header for the per-drive kebab sheet. Mirrors the
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

  // v5 folder-contents modal: derive the drive + prepared file list from
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
  // same share-key indirection as the list rows. This modal is
  // where a grab actually lands (the completion effect below opens it), so
  // a received bundle that showed no progress in the list showed none here
  // either — for the same reason.
  const folderModalTransfer = folderModalDrive
    ? transferForRow(folderModalDrive)
    : undefined;
  const folderModalIsReceived = folderModalDrive?.origin === "received";
  const folderModalIsActive =
    !!folderModalDrive && activeDriveIds.has(folderModalDrive.id);
  /**
   * May this modal's Copy Link CTA be offered at all? `FolderContentsModal` gates
   * that button on `shareLink` existing and nothing else, and the post-grab effect
   * opens this modal after every multi-file grab — so a received folder would offer
   * a link for a drive this phone announces nothing about. Hosted rows pass `true`.
   */
  const folderModalCanOfferLink = folderModalDrive
    ? folderModalIsReceived
      ? receivedShareIsAnnouncing(reshareSignalsFor(folderModalDrive))
      : true
    : false;
  const folderModalTransferring =
    !!folderModalTransfer &&
    !folderModalTransfer.completed &&
    (folderModalTransfer.percent ?? 0) > 0 &&
    (folderModalTransfer.percent ?? 0) < 100;
  const folderModalReceiveStatus = useMemo(
    () => receiveRowStatus(folderModalIsReceived ? folderModalTransfer : null),
    [folderModalIsReceived, folderModalTransfer],
  );
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
      } else if (folderModalIsReceived && folderModalReceiveStatus.state !== "idle") {
        statusLabel = folderModalReceiveStatus.label;
        statusTone = folderModalReceiveStatus.tone;
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
      /**
       * The handler is severed from the status tone. Both of the modal's control
       * branches call this one handler, so keying it off `statusTone` would leave
       * whole-share deactivation live behind an "Open in another app" label. A
       * per-file control may open that one file and nothing else.
       */
      const control = folderRowControl({ fileName: displayName, hasLocalCopy: hasLocal });
      const onRightControlPress =
        control.kind === "open" && c.localPath
          ? () => {
              void onOpenFile(c.localPath as string);
            }
          : undefined;
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
        // STEP 2: the per-row stop control
        // is gone. `isActiveShare` was `statusTone === "warning"`, and
        // W0-UI-5's proposed `!isReceived && transferring` replacement is
        // INSUFFICIENT: it is uniformly true across every child of a hosted
        // folder that is transferring, so it would have kept the whole-share
        // stop on all of them. The prop no longer exists.
        rightControl: control,
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
    folderModalIsReceived,
    folderModalReceiveStatus,
    childBlinkTarget,
    buildFolderChildren,
    onOpenFile,
    // `onStopSharing` was removed from this
    // memo's body along with the deactivate branch — the folder modal no longer
    // offers "Stop sharing" for a file. The dependency is gone with it; it now
    // survives only in the comment above that records what used to be here.
    previewFile,
    setLinkDraft,
    setPendingPreselection,
    showToast,
  ]);
  const folderModalStatus = folderModalDrive
    ? folderModalIsReceived && folderModalReceiveStatus.state !== "idle"
      ? {
          label: folderModalReceiveStatus.label,
          tone: folderModalReceiveStatus.tone,
        }
      : folderModalTransferring
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
  // received-share rows don't expose Share-it / Stop-sharing in
  // this sprint — the engine maps activate by driveId, not shareKey, so
  // there's no clean "this share" toggle yet.
  //
  // (phase 2i): they do now, via `kebabReshare` below.
  // `onShareIt` / `onStopSharing` still refuse them — those route by row id —
  // and the re-share pair routes by the engine driveId instead.
  const kebabIsReceivedShare = !!kebabDrive?.share;
  /**
   * (phase 2i) — the received row's Share / Stop control,
   * and the announcing flag the link surfaces are gated on.
   *
   * `kebabActive` is NOT the gate. Boot hydration puts every received drive in
   * `activeDriveIds` with no swarm, so `kebabActive` is true for a copy that is
   * announcing nothing — which is how Copy Link and Show QR came to be offered
   * for a link no peer can resolve.
   */
  const kebabReshare = kebabDrive
    ? reshareControl(reshareSignalsFor(kebabDrive))
    : null;
  const kebabAnnouncing =
    !!kebabDrive && receivedShareIsAnnouncing(reshareSignalsFor(kebabDrive));
  /** Hosted rows keep `active`; received rows must actually be announcing. */
  const kebabCanOfferLink = kebabIsReceivedShare
    ? kebabAnnouncing
    : kebabActive;

  /**
   * Is this row a download happening right now? Derived from `classifyTransfer`,
   * the single answer to "is a transfer in flight"; a second definition here would
   * drift from the one the foreground service uses. `=== "download"` rather than
   * `!== null`, so a hosted share keeps Delete while a peer is connected. The id
   * set mirrors `performDelete`'s: a synth row may span several drive entries.
   */
  const kebabDownloadInFlight = useMemo(() => {
    if (!kebabDrive) return false;
    const ids = new Set<string>([kebabDrive.id]);
    const shareKey = kebabDrive.share?.shareKey;
    if (shareKey) {
      for (const d of drives ?? []) {
        if (d.origin === "received" && d.key === shareKey) ids.add(d.id);
      }
    }
    const now = Date.now();
    return transfers.some(
      (t) => ids.has(t.driveId) && classifyTransfer(t, now) === "download",
    );
  }, [kebabDrive, drives, transfers]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 4 }]}>
      {/* v5 shell: Files/Favorites tabs + search/filter/sort toolbar. Send /
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

      {/* v5 Send — centered modal card with Files + Photos and Recent Shares.
          Folder handler stays wired but the entry point is hidden in the UI. */}
      <SendSheet
        visible={pickerSheet === "share-files"}
        onClose={() => setPickerSheet(null)}
        onPickFiles={() => {
          // "Files" now opens PearDrop's own picker. The OS
          // document picker is still one tap away inside it.
          setPickerSheet(null);
          setInAppPickerOpen(true);
        }}
        onPickPhotos={() => void onPickPhotosAndShare()}
        onPickFolder={() => void onPickFolderAndShare()}
        recentShares={recentShares}
        onCopyRecentLink={(link) => void onCopyLink(link)}
        onShareAgain={(id) => onShareAgainFromRecents(id)}
      />

      {/* In-app file selection — recents plus one level of a SAF-granted
          Downloads folder, with the OS picker as fallback. Cancel routes
          through the shared picker-exit path so backing out behaves like
          backing out of the OS picker: Send sheet restored, nothing half-built. */}
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

      {/* The naming step for every share — single file, bundle and folder.
         Cancel here means no share was ever created: `sharePaths` is not called,
         and on the folder path nothing has been copied to cache yet. */}
      <NameShareModal
        visible={!!pendingNameShare}
        defaultName={pendingNameShare?.defaultName ?? ""}
        fileCount={pendingNameShare?.fileCount ?? 0}
        subtitle={
          pendingNameShare?.kind === "folder"
            ? "This folder will share under this name."
            : undefined
        }
        // Fixed, non-editable extension for a single file; empty otherwise.
        fixedSuffix={pendingNameShare?.ext ?? ""}
        // Empty shows nothing and just disables Share; any other refusal
        // shows its reason inline.
        validate={(raw) => checkShareName(raw).message ?? null}
        onCancel={() => {
          setPendingNameShare(null);
          setShareBusy(false);
        }}
        onConfirm={(name) => {
          const pending = pendingNameShare;
          setPendingNameShare(null);
          if (!pending) return;
          if (!canConfirmShareName(name)) return;
          // Send the base, never a recombined filename: the engine treats
          // `shareName` as a base and appends the real extension itself.
          const finalName = checkShareName(name).value ?? name;
          void (async () => {
            try {
              if (pending.kind === "folder") {
                if (pending.folder) {
                  await enumerateAndShareFolder(pending.folder, finalName);
                }
                return;
              }
              await shareFilesAndTrack(pending.files, {
                shareName: finalName,
                errorLabel:
                  pending.kind === "photos"
                    ? "Couldn't create that share."
                    : "Couldn't create that share — give it another go?",
              });
            } catch (e: unknown) {
              logStructuredError("rn.share", "re-share failed", e);
              showToast("Couldn't share those — give it another go?", "error");
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
          // v5 multi-select entry: opens selection mode with the current
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
          // Do NOT change the Open affordance — per v5 guardrails it stays
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
            // ONE save destination.
            //
            // 9G briefly shipped two — "Save to Downloads" beside a renamed
            // share sheet ("Send to another app…") — on the reasoning that
            // they answered different questions. In use they read as two
            // spellings of the same thing, and the share sheet was removed.
            //
            // This is the export route for a received file now. `Open in
            // another app` above is a different feature and stays: it hands
            // the file to a viewer rather than putting a copy anywhere.
            if (canSaveToDownloads) {
              list.push({
                key: "save-downloads",
                icon: "download-outline",
                label: "Save to Downloads",
                onPress: () => {
                  setKebabSheet(null);
                  void onSaveToDownloads(f.path, f.name);
                },
              });
            }
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
          // Copy link and Show QR only make sense while a drive is seeding, and
          // `kebabActive` is true for hydrated received copies that announce nothing.
          const shareLink = kebabDrive.shareLink;
          if (kebabCanOfferLink && shareLink) {
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
          if (kebabCanOfferLink) {
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
          // v5: Retry surfaces inside the kebab (not on the row) when the
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
          // (phase 2i) — the received row's re-share pair.
          //
          // Ahead of the hosted branches and mutually exclusive with them:
          // `reshareControl` returns `none` for anything that is not a
          // received row, and `canOfferStartSharing` refuses every received
          // row, so exactly one of the three blocks can fire.
          //
          // The disabled arm is VISIBLE, not omitted. An incomplete copy is
          // the case the user most needs told, and `disabledReason` is the one
          // sentence that tells them.
          if (kebabReshare && kebabReshare.kind !== "none") {
            const control = kebabReshare;
            const d = kebabDrive;
            list.push({
              key: "reshare",
              icon: control.kind === "stop" ? "stop-circle" : "share-outline",
              label: control.label,
              tone: control.kind === "stop" ? "danger" : "default",
              disabled: !control.enabled,
              sublabel: control.disabledReason,
              onPress: () => void onReshare(d, control.kind === "share"),
            });
          } else if (!kebabIsReceivedShare && kebabActive) {
            list.push({
              key: "stop",
              icon: "stop-circle",
              label: "Stop sharing",
              tone: "danger",
              onPress: () => void onStopSharing(kebabDrive),
            });
          } else if (
            canOfferStartSharing({
              id: kebabDrive.id,
              origin: kebabDrive.origin,
              isActive: kebabActive,
            })
          ) {
            // (A2): hosted-only.
            //
            // This used to read "offered for any inactive row — hosted or
            // received… if the engine can't resume by driveId yet the toast
            // surfaces the failure." It could not resume by driveId, it still
            // cannot, and the toast that surfaced was "Drive not found" — the
            // engine's `drive-not-found` message rendered verbatim. Shipping an
            // action whose documented fallback is an error toast is the thing
            // not to repeat.
            list.push({
              key: "share",
              icon: "share-outline",
              label: "Start sharing",
              onPress: () => void onShareIt(kebabDrive),
            });
          }
          // ONE row, two states — not two rows with one hidden.
          //
          // While a download is in flight the destructive row reads Cancel and
          // calls the single cancel path 9G shipped. Once it finishes, the same
          // row reverts to Delete. Before this, Delete was the only option on a
          // live download, and it reached `engineStopDrive({purge:true})` —
          // which purged the corestore out from under the running loop and
          // then reported "Download complete". The engine-side guard added
          // this sprint means Delete is no longer dangerous either way; this
          // makes it say the right word as well.
          list.push({
            key: "delete",
            icon: kebabDownloadInFlight ? "close-circle-outline" : "trash-outline",
            label: kebabDownloadInFlight ? "Cancel" : "Delete",
            tone: "danger",
            onPress: () =>
              kebabDownloadInFlight
                ? onCancelDownload(kebabDrive)
                : onDelete(kebabDrive),
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
        /**
         * (phase 2i), owner ruling — the QR and Copy Link
         * are gated on ANNOUNCING for a received row, on `isActive` (unchanged)
         * for a hosted one.
         *
         * The comment above is still true of a hosted share and was never true
         * of a received one: a received link is "the string that grabbed the
         * share", and handing it on only works while THIS phone announces the
         * drive. `isActive` cannot see that — every hydrated received copy is
         * active with no swarm.
         */
        const qrIsReceived = !!drive?.share;
        const qrCanOfferLink = drive
          ? qrIsReceived
            ? receivedShareIsAnnouncing(reshareSignalsFor(drive))
            : isActive
          : false;
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
            canOfferLink={qrCanOfferLink}
            // (A2): `drive.share` is set only on a received synth
            // row (built at ~line 1037) and is the idiom this file already
            // uses for the test — see `kebabIsReceivedShare` and
            // `previewParentDrive`.
            presentation={drive?.share ? "received" : "hosted"}
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
              qrCanOfferLink && link ? () => void onCopyLink(link) : undefined
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
            // Never offered on a received row: its id is `share:<shareKey>`, which
            // `engineActivateDrive` cannot find. Every site uses `canOfferStartSharing`.
            onActivate={
              drive &&
              canOfferStartSharing({
                id: drive.id,
                origin: drive.origin,
                isActive,
              })
                ? () => {
                    const d = drive;
                    void onShareIt(d);
                  }
                : undefined
            }
          />
        );
      })()}

      {/* Fullscreen takeover preview. Pure black behind the media. Chrome
       *  floats over the video and auto-hides during playback; image/text/audio
       *  keep chrome visible. Dismiss is the back arrow — no tap-outside, no
       *  swipe. Playback toggles on any tap of the video tap-surface. */}
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

            {/* Top bar holds only the back arrow — the share button is inline
              *  below the video. Safe-area top inset clears the status bar so
              *  the icon is fully tappable. Bigger touch target + hitSlop. */}
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
                    // fix: clear the gesture bar so the share
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
                {/* Share/stop-sharing toggle below the scrubber. Hosted drives
                  *  only; received synth rows cannot activate via this path.
                  *  - Stop sharing: deactivates inline, preview stays open
                  *  - Share it: closes the preview and opens the QR modal */}
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
                                userFacingError(res.error, "Couldn't stop that one."),
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

      {/* v5 folder-contents modal — replaces the prior inline expand. */}
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
        shareLink={
          folderModalCanOfferLink ? folderModalDrive?.shareLink ?? null : null
        }
        onCopyLink={() => {
          const link = folderModalDrive?.shareLink;
          if (folderModalCanOfferLink && link) void onCopyLink(link);
        }}
        // (A2): the third reachable "Start sharing" → "Drive not
        // found" path, and the one on the busiest route — the post-grab
        // completion effect (~line 937) opens THIS modal on `share:<shareKey>`
        // after every multi-file grab, so a received folder showed the button
        // immediately after a successful download. Same id mismatch, same
        // engine error, same removal as the other two.
        onStartSharing={
          folderModalDrive &&
          canOfferStartSharing({
            id: folderModalDrive.id,
            origin: folderModalDrive.origin,
            isActive: folderModalIsActive,
          })
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

      {/* The confirm says what actually happens, differently for a received
          share: the text names both what goes (PearDrop's own copy) and what
          stays (anything saved to Downloads). The wording lives in
          `src/lib/deleteReceivedPlan.ts` so it is reachable from the suite. */}
      <ConfirmModal
        visible={!!pendingDelete}
        title={describeDeleteConfirm(pendingDelete?.share ? "received" : "hosted").title}
        body={describeDeleteConfirm(pendingDelete?.share ? "received" : "hosted").body}
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

      {/* v5 multi-select: batch delete confirmation. */}
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

