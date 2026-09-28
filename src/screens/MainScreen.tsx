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
// read-only use of the protected predicate. transferActivity.ts is
// unit-tested and must not be edited; importing from it is how the menu and
// the foreground service stay on one definition of "in flight".
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
// `onTapRow`'s row-tap outcomes are named and tested in this
// module, kept out of ad-hoc branches in the component itself.
import { rowTapRoute } from "../lib/receivedRowRoute";
// the re-share decision and its whole
// vocabulary live here. `active` is not `announcing`, and this file is unreachable from
// jest, so the decision lives where the suite can assert it.
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
// use `userFacingError`, not `errorMessage`.
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
// sheet-close + resolve-abort pairing, extracted so the
// suite can assert the abort happens.
import { closeReceiveSheet } from "../lib/receiveSheetClose";
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

// enable LayoutAnimation on Android. Standard one-shot init; the
// flag is no-op on iOS where LayoutAnimation works out of the box. Must
// run after the import block so `import/first` doesn't flag it.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * whether to offer "Save to Downloads" at all.
 *
 * Module scope rather than a hook: `NativeModules` is populated before any
 * component renders and the answer cannot change during a session, so
 * re-evaluating it per render would be pure cost. Android-only, and false if
 * the native module somehow failed to register — in which case the menu item
 * is absent rather than present and broken.
 */
const canSaveToDownloads = isSaveToDownloadsAvailable();

type DriveRow = DriveRecord & {
  /** Computed: the file used when tapping a single-file row opens a preview.
   *  Undefined for multi-file bundles (which expand instead). */
  primaryFile?: DriveLocalFile;
  /** True when files.length > 1. Bundles expand on tap; single files preview. */
  isBundle?: boolean;
  /** present for synthesized received-share rows. When set, the
   *  list-flattening logic reads child file states from here (with isDownloaded
   *  flags) instead of from the engine's `files` + `localFiles` join. */
  share?: ReceivedShare;
  /** organizational flags. Sourced from the share's own record
   *  (received) or from hostedShareFlagsStorage (hosted). */
  isPinned?: boolean;
  isFavorite?: boolean;
};

/** Flattened list item — drives the FlatList. v5: bundles no longer expand
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
  /** parent drive id (or share synth id) so the preview's
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

// Match "uuid.ext" or "uuid" — v5 fix so received shares whose filenames are
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
    // v5 multi-select header: replaces TopTabs + ListToolbar while active.
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
    // name + optional pin marker side-by-side. Text shrinks
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
    // ZZZZZZ: fullscreen takeover styles. Pure black background,
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
      // extra horizontal padding so the back arrow sits inboard,
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
      // bigger touch target — was 44; bumped to 48 with extra
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
      // fix: fixed width so "Share it" and "Stop sharing" don't
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
    cancelInFlight,
    activateDrive,
    deactivateDrive,
    refreshDrives,
    // the flat field is where RN reads this.
    // Do NOT re-derive it from `hyperdriveStatus` — see backend.ts's comment.
    manifestUnavailable,
  } = useBackend();

  const {
    linkDraft,
    setLinkDraft,
    resolving,
    linkError,
    retryResolve,
    setPendingPreselection,
    // the offline re-grab picker, reached from `onTapRow`.
    openStoredSharePicker,
    abortResolving,
    lastCompletedDownload,
    consumeCompletedDownload,
    manualEntryTick,
    // fires when the 30 s resolve guard gives up — close
    // the Receive sheet and let the context's info toast do the talking.
    resolveTimeoutTick,
    resolveFromScan,
    // the live resolve session is the ONLY source that knows
    // which engine driveId a share key maps to while the grab is still
    // running — the engine emits no drive-created/-hydrated on the receive
    // path, so `drives` does not learn about it until the download has
    // already finished. See lib/receiveProgress.ts.
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

  // First time the user opens a
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

  // the single exit path for every non-selected picker outcome.
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
  /**
   * now covers every share path, not just multi-file.
   *
   * `ext` is the fixed suffix shown beside the field for a SINGLE file — the
   * user edits the base, never the extension. Empty for bundles and folders.
   *
   * `folder` carries the picked directory for the folder path, because that
   * path prompts BEFORE enumerating. See `onPickFolder` for why.
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
  // v5: shareBusy state removed with the top action row; the pickers can't
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
  // v5 folder modal: tapping a bundle (or its chevron) opens a modal
  // showing the folder's contents. Replaced the earlier inline dropdown
  // expansion — the driveId here is whichever folder is currently open,
  // or null when the modal is dismissed.
  const [folderModalId, setFolderModalId] = useState<string | null>(null);
  /**
   * The LIVE swarm mode of a
   * received share, keyed by lower-cased shareKey.
   *
   * Written only from an `activate` reply's `mode`, which is the one field that
   * states what the engine actually set up. Nothing else in RN can observe the
   * swarm: `activeDriveIds` holds every hydrated received drive and says
   * nothing about announcing, and `engineListDrives` reports the persisted
   * `reshared` intent rather than a live mode.
   *
   * Session-scoped by design. An empty map after a restart is the honest state
   * "this session has not asked", and `receivedShareIsAnnouncing` falls back to
   * `reshared` + completeness for exactly that window.
   */
  const [observedReshareModes, setObservedReshareModes] = useState<
    Record<string, ReshareMode>
  >({});
  const [sharedPaths, setSharedPaths] = useState<SharedFilePathsEntry[]>([]);
  const [receivedShares, setReceivedShares] = useState<ReceivedShare[]>([]);
  const [hostedFlags, setHostedFlags] = useState<HostedShareFlags[]>([]);
  // view-mode toggle. Always resets to "all" on mount — intentional;
  // no persistence to AsyncStorage. Favorites is a filterable subset.
  const [viewMode, setViewMode] = useState<"all" | "favorites">("all");
  // v5 shell state: search + filter + sort applied on top of viewMode.
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [sort, setSort] = useState<SortId>("recent");
  const [receiveSheetVisible, setReceiveSheetVisible] = useState(false);
  // v5 polish: bumped when Receive should open with the paste input focused.
  const [receiveFocusPaste, setReceiveFocusPaste] = useState(false);
  // v5 multi-select mode: swaps kebab for checkboxes; header shows count +
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
  // after the 30 s resolve timeout the app returns to the
  // list — the Receive sheet closes and the muted wait message arrives as a
  // top-level info toast (raised by ShareLinkFlowContext). Same one-shot
  // tick pattern as manualEntryTick above.
  useEffect(() => {
    if (resolveTimeoutTick <= 0) return;
    setReceiveSheetVisible(false);
    setReceiveFocusPaste(false);
  }, [resolveTimeoutTick]);
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

  // subscribe to the per-share storage so received bundles re-
  // render in place when downloads complete and flip files' isDownloaded.
  useEffect(() => {
    void loadShares().then(setReceivedShares);
    return subscribeShares(setReceivedShares);
  }, []);

  // subscribe to hosted-share organizational flags so toggling
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

  // when a grab completes (newly-fetched or all already-on-disk),
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
    // say out loud that the grab finished, and say how much of
    // it finished.
    //
    // Until now a completed download produced a haptic pulse and a 900 ms
    // row blink and nothing else. `notifyTransferComplete` cannot cover
    // this — notifications.ts:129 returns early while the app is
    // foregrounded, by design — so the foreground case had no readable
    // completion signal at all. That is why a truncated grab and a whole
    // one were indistinguishable.
    const completion = grabCompletionMessage({
      saved: lastCompletedDownload.saved,
      failed: lastCompletedDownload.failed,
      // "Stopped — 3 files saved." rather than the partial-grab
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

  // Sort: most recent activity first. Active state does not affect ordering
  // — items don't jump as they transition.
  //
  // two sources merged into one list.
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
        // precedence, stated explicitly because it changed.
        //
        // A NEW share's name now comes from the engine — the naming step
        // passes it to `sharePaths` at creation, so it is on the wire and the
        // receiver sees it. `customName` is no longer written at creation.
        //
        // `customName` survives as a POST-HOC local rename of an existing
        // share, and it still WINS here: renaming a share you already have is
        // a local act and should not be overridden by the name you shipped
        // with it. That also keeps every share created before this build
        // rendering its stored name rather than reverting to the engine's.
        //
        // `rowDisplayName` reads `name` and handles truncation.
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

    // two-level sort — pinned shares first, then recency within
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

  /**
   * shareKey → driveId, so a received row can find its own
   * transfer.
   *
   * Received rows are synthesized one per share key with the id
   * `share:<shareKey>`, which is not a driveId — so the plain
   * `transferByDriveId.get(drive.id)` the hosted rows use could never hit
   * for them. That mismatch is why download progress rendered nowhere
   * while upload progress rendered fine.
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
   * Every input the re-share decision reads,
   * gathered once per row.
   *
   * Built here rather than at each of the three surfaces because there are
   * three of them (kebab, info modal, folder modal) and "Start sharing on a
   * received row" has already shipped three times as three separate inline
   * conditions — `src/lib/shareActions.ts:4-26` is the record of that. The
   * decision itself is in `reshareControl`; this only feeds it.
   *
   * `driveId` prefers the value persisted on the record and
   * falls back to the derived share-key index, which is the only source that
   * knows the mapping for a grab that finished this session.
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

  // v5 Send sheet: recent hosted shares, most recent first, capped at
  // RECENT_SHARES_LIMIT. Only hosted drives — received shares aren't "yours to
  // re-share" from this surface (`shareActions.ts:88-92`).
  //
  // the pill used to key off `!!d.shareLink`, which is not
  // the same question as "is this share announcing". `engineListDrives` reports
  // an INACTIVE drive WITH its link, so a share the user stopped kept its
  // "Link" pill and handed out a link no peer can resolve.
  //
  // the row is NOT dropped for being stopped: dropping stopped rows would
  // empty the whole Recent Shares section whenever every share was stopped. Every hosted
  // row with a link stays, and `recentShareAction` picks the pill: "Link" while
  // announcing, "Share again" when not. "Share again" activates first and then
  // opens the QR/link modal, via `onShareAgainFromRecents` → `onShareIt`.
  //
  // Round 2 / F2 (preserved): `activeDriveIds` alone is not enough. A drive
  // whose hydration FAILED stays in that set with no swarm attached —
  // `backend.ts:1661-1675` adds it to `failedHydrationIds` and never removes it
  // from `activeDriveIds` — so it would still be offered a Link pill. `failed`
  // overrides `active` inside `recentShareAction`, for the same reason it does
  // in the QR modal's status ladder at `:3062-3067` below.
  //
  // BOTH sets MUST stay in the dependency array below. Without them the memo
  // never re-tags rows when a share is started, stopped, or fails to hydrate —
  // which is this very defect, reintroduced silently.
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

  // v5: viewMode filter applied AFTER the primary "recent" sort.
  // v5 also layers on search (name substring), filter (type/status), and a
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

  // v5: the list emits only drive rows now — bundle contents live in the
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
  // resolve the preview's parent drive so the bottom share/
  // stop-sharing button knows the active state + identity to toggle.
  // Returns null if the parent was a received-share synth row — those
  // don't expose a clean activate path yet, so we omit the
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

  // poll video currentTime / duration / playing at 4 Hz while
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

  // chrome auto-hide for the video takeover. Chrome stays
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
          // the resolved result is READ, not discarded. A launch
          // that starts an activity which refuses and finishes immediately
          // resolves successfully — that silent path is what made a received
          // APK look like nothing happened at all.
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
        // The raw native message is not pasted
        // into the toast. It goes to the log, where a diagnosis
        // belongs, and the user gets a line that is true.
        logStructuredError("rn.open", "openURL failed", e);
        showToast("Can't open that one. Try another app?", "error");
      }
    },
    [showToast],
  );

  /**
   * "Save to Downloads" — THE export route for a received file.
   *
   * Received files land in `<DocumentDirectory>/peardrop/downloads/`, which
   * is app-private: no other app can reach them through the filesystem, and
   * for a long time nothing in the app offered a way out.
   *
   * The native MediaStore module handles this directly: no chooser, no
   * second app, the file lands on the phone in `Download/PearDrop`. A
   * share-sheet path would duplicate this almost exactly, so it doesn't
   * exist — one export route, not two spellings of the same one.
   *
   * The evidence for why this had to be native — expo's only SAF write
   * materialises the whole file as a base64 JS string, the OOM class this
   * removes from the engine — lives in `SaveToDownloadsModule.kt`'s
   * header, along with why `react-native-fs` and `expo-media-library` cannot
   * do it either. The wording lives in `describeSaveResult`, which is pure
   * and tested.
   *
   * `Open in another app` (ACTION_VIEW) is a different feature and stays: it
   * hands a file to a viewer rather than putting a copy anywhere.
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

  // v5: bundle tap opens the folder-contents modal. Prior inline dropdown
  // (with a LayoutAnimation) was removed in favor of a modal per design.
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
        // Write the finding down instead of
        // throwing it away. This check already proved the file is gone, but
        // the record went on saying `isDownloaded: true`, so the next render
        // still claimed the file was on the device and the row still withheld
        // the re-grab affordance (gated on `isMissing`) — free knowledge that
        // would otherwise go straight back to being discarded.
        // Received rows are synthesized as `share:<shareKey>`; a hosted row's
        // id is an engine driveId and has no share record to repair. Using the
        // exported prefix rather than a literal so this cannot drift from the
        // place that mints it.
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
          // The same defect as the toast sites, rendered into the preview
          // pane instead of a toast.
          logStructuredError("rn.preview", "text preview read failed", e);
          setPreviewText("Can't preview this one.");
        }
      }
    },
    [audioPlayer, videoPlayer, onOpenFile, showToast],
  );

  /**
   * Where a tap on a row goes.
   *
   * The decision is NOT made here. `MainScreen.tsx` is `.tsx` and unreachable
   * from the jest suite, so a decision made inline is a decision no test can
   * observe. All four outcomes live in
   * `src/lib/receivedRowRoute.ts`, ordered and tested there; this reads the
   * answer and dispatches. `describeHoldings` is passed in rather than
   * recomputed so the routing and the row's own labels cannot disagree.
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
        // Bundles open the folder-contents modal — there's no single content
        // to preview. The kebab continues to surface More info / Share it /
        // Delete for the whole folder.
        openFolderModal(drive.id);
        return;
      }
      if (route === "file-preview" && drive.primaryFile) {
        await previewFile(drive.primaryFile, drive.id);
        return;
      }
      // Nothing to preview and nothing to re-grab: the info panel, so the user
      // can still see status / activate / delete. Received rows open it in the
      // received presentation, which drops Start sharing and the seeding
      // fields (a `share:<shareKey>` id the engine cannot
      // resolve was being offered Start sharing).
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
       * the name the user chose, passed to the ENGINE at creation
       * so it reaches the wire and the receiver.
       *
       * This is the single source of truth for a new share's name: the
       * engine. `hostedShareFlagsStorage`'s copy is written after creation
       * and never reaches the wire, so it cannot be what the recipient sees.
       *
       * `hostedShareFlagsStorage.customName` still exists and still wins at
       * render: it is now purely a POST-HOC local rename of an existing
       * share, which is a different feature. Shares created before this build
       * carry one and keep rendering it.
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
    // The single funnel for share creation from the UI —
    // every picker path lands here.
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
      // `userFacingError` keeps the caller's fallback for every cause but
      // substitutes real detail where there is something true to say — a
      // manifest-unavailable rejection must not read as "give it another
      // go?", a retry the engine is guaranteed to refuse.
      showToast(userFacingError(out.error, opts.errorLabel), "error");
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
   * build the naming-step state for a picked selection.
   *
   * One place, because all three picker paths reach it and the prefill rules
   * are not obvious:
   *
   * - **Single file** → the file's base name, with its extension carried as
   *   fixed text. If the filename is UUID-shaped — which the photo picker
   *   routinely produces, and which is the whole reason "Shared photo"
   *   existed — the prefill becomes the human type label instead, keeping the
   *   real extension. That fallback becomes the
   *   prefill that fixes it.
   * - **Bundle** → a common base when the files share one that breaks on a
   *   separator and is long enough to mean something, else "Photos"/"Files".
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
      // The EXTENSION comes from the URI, not from `name`.
      //
      // 9I bug, found on device: a photo reported as `…​.jpg` by the picker was
      // materialised to cache as `….jpeg`, and the engine derives its
      // extension from `path.basename()` of that cache path. Showing the
      // picker's `.jpg` while the engine appended `.jpeg` is half of how
      // "Hello" became "Hello.jpg.jpeg".
      //
      // So the suffix rendered here is read from the same place the engine
      // will read it: the file's own URI.
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
      // EVERY share is named now, single file included. The old
      // `length > 1` gate is gone — a single file skipped the step on the
      // reasoning that "their filename already reads as the name", which is
      // false for the photo-picker's UUID cache names and is the reason
      // "Shared photo" existed at all.
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
    // these double as the in-app picker's escape hatches, so
    // dismiss it before launching the OS picker behind it.
    setInAppPickerOpen(false);
    setShareBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: true,
      });
      // cancel and empty both exit through `handlePickerExit` —
      // clean return to the Send sheet, no half-started share, no fallthrough.
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
    // these double as the in-app picker's escape hatches, so
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
      // A raw errno string prefixed with "Folder error:" tells the user
      // nothing they can act on.
      logStructuredError("rn.share", "folder pick failed", e);
      showToast("Couldn't read that folder — give it another go?", "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function onPickPhotosAndShare() {
    setPickerSheet(null);
    // these double as the in-app picker's escape hatches, so
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
      // `errorMessage(...) || fallback` cannot serve as a safety net: a
      // structured engine error always carries a message, so the fallback
      // branch never fires and "Engine not initialized." would render
      // instead. `userFacingError` makes the fallback the thing that
      // actually shows.
      logStructuredError("rn.share", "activate failed", res.error);
      showToast(userFacingError(res.error, "Couldn't activate that one."), "error");
      return;
    }
    haptics.success();
    setQrDriveId(drive.id);
    void refreshDrives();
  }

  /**
   * "Share again" on a Recent Shares row.
   *
   * Starts sharing FIRST and then offers the link, which is what `onShareIt`
   * already does: `activateDrive` and then `setQrDriveId`. That is the one
   * hosted activation path in this screen — the kebab's "Start sharing" at
   * `:2984` and the row actions at `:3158` / `:3503` all route through it — and
   * this deliberately adds no second route.
   *
   * The Send sheet is dismissed first: `onShareIt` opens the QR/link modal, and
   * leaving the Send `Modal` mounted underneath would stack two RN modals.
   *
   * Received rows are refused twice, independently, for the reason
   * `shareActions.ts:73-79` gives: `recentShares` can only contain hosted rows
   * (`selectRecentShareRows` drops received ones), AND the resolved drive is
   * re-checked here. A received row's id is `share:<shareKey>`, which
   * `engineActivateDrive` cannot find in `manifest.drives`, so this must fail
   * closed rather than fire a button that can only answer `drive-not-found`.
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
    // F2, and the only way to reach here: hydration FAILED, so the share is not
    // announcing and the pill said "Share again" — yet the drive is still in
    // `activeDriveIds`, so `canOfferStartSharing` refuses exactly as it does
    // for the kebab (`kebabActive` at `:2354` does not subtract failures
    // either). Re-activating would not help regardless: `engineActivateDrive`
    // early-returns `already: true` without re-attaching a swarm, and this
    // path does not attempt that either. So open the QR/link modal, whose status ladder
    // at `:3062-3067` renders "failed" explicitly. Telling the user the truth beats
    // a button that does nothing.
    setQrDriveId(drive.id);
  }

  // useCallback so the identity is stable across renders and the row
  // memo below doesn't invalidate every tick.
  const onStopSharing = useCallback(
    async (drive: DriveRow) => {
      setKebabSheet(null);
      const res = await deactivateDrive(drive.id);
      if (!res.ok) {
        // Same reasoning as the activate handling above.
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
   * Re-share a received copy, and stop.
   *
   * ONE handler for both directions, because they are one call with one
   * argument flipped. `activate(driveId, { serve })` is a tri-state and the two
   * booleans here are the only explicit ones in the app; `onShareIt` above
   * passes **no `opts` at all**, which is the third state — "no opinion" — and
   * is what keeps a hosted drive announcing and a received one client-only by
   * default. Do not route `onShareIt` through here.
   *
   * **Stop is `serve: false`, not `deactivateDrive`.** Deactivating tears the
   * session down and leaves the persisted `reshared` intent set, so the
   * engine's boot rule would re-announce the copy on the next launch — the
   * user's "stop" would expire when they closed the app. `serve: false` demotes
   * the swarm to client-only and clears the intent.
   *
   * The engine `driveId` comes off the signals, never off `drive.id`: a
   * received row's id is `share:<shareKey>` and `engineActivateDrive` answers
   * `drive-not-found` for it — a string `scripts/check-copy.mjs` now bans from
   * reaching a user at all.
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
      if (drive.share) {
        // received share. Drop the per-share record, then purge
        // every engine drive whose key matches — the share may have produced
        // several short-lived engine drive entries across re-pastes.
        const shareKey = drive.share.shareKey;
        // `deleteShare` removes the app's own copies under `downloads/` as
        // well as the record — see its header for why the removal lives in
        // the store and not here.
        //
        // The toast fires only for the part of the work this realm can
        // actually observe, and says something different when a file would
        // not go. The engine's corestore purge below stays fire-and-forget;
        // the row has already left the list either way.
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
   * cancel an in-flight download from the row menu.
   *
   * Calls `cancelInFlight` — the path 9G shipped
   * (`src/state/backend.ts` → opcode 35 → `engineCancelTransfer`) — and NOT a
   * copy of it. There is exactly one cancel implementation in the tree and
   * this is a second surface onto it.
   *
   * No confirmation modal, deliberately, unlike `onDelete`. Cancelling keeps
   * the share and every byte already written; the only thing lost is the rest
   * of a transfer the user can restart. A confirm on a reversible action
   * trains people to dismiss confirms on the irreversible one next to it.
   *
   * The engine settles the row: `transfer-cancelled` arrives and marks it
   * cancelled. Nothing optimistic is written here, because the engine is the
   * only thing that knows whether the cancel caught anything.
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
       * A received row must state what this device HAS, not what was SENT.
       *
       * Summing every manifest file with no `isDownloaded` filter would make
       * a share where 3 of 12 files landed read identically to one where all
       * 12 did — and since the total is recomputed from the stored manifest
       * on every launch, that would be the steady state of every received
       * share after a restart, not an edge case. `describeHoldings` avoids
       * that by filtering on `isDownloaded`.
       *
       * Hosted rows are unchanged: for a share you are serving, the manifest
       * total IS what you have, so the plain byte sum is the right answer
       * there.
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
        // A received bundle states how many of its files are actually here
        // — "3 of 12 Files". A hosted bundle keeps the plain count, which is
        // true of a share you are serving.
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
        // The hosted chain — Sharing / Completed / Active — lives in
        // `hostedRowStatus`, with its `cancelled` branch AHEAD of `completed`.
        // `markCancelled` sets `completed: true` on both origins, so a
        // cancelled hosted share must be caught before the `completed` arm or
        // it reads "Completed". That logic belongs in `hostedRowStatus` and
        // not inline here: this file is `.tsx`, and the suite collects only
        // `*.test.ts`.
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
   * An empty list that is actually a failure must not render as an
   * absence. Branching on `viewMode` alone would render "Nothing here yet ·
   * Pick files above or paste a link." for a manifest the engine cannot
   * read — the same screen a brand-new install shows — while every share
   * the user owns is still sitting on disk.
   *
   * The decision itself is in `src/lib/shareListEmptyState.ts` so it can be
   * tested: this file is a `.tsx` and `jest.config.js` cannot import one.
   * `manifestUnavailable` is the flat `BackendAPI` field — read here, not
   * re-derived from `hyperdriveStatus`.
   *
   * `state.isError` is forwarded here so `shareListEmptyState.ts`'s own
   * comment holds — "the screen keys its styling off this rather than off
   * `kind`, so a future error kind cannot be added and silently render in
   * the calm palette." Key any new error state off `isError`; do **not**
   * branch on `state.kind` here.
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
   * May this modal's Copy Link
   * CTA be offered at all?
   *
   * `FolderContentsModal` gates that button on `shareLink` **existing**, and on
   * nothing else — its own comment at `src/ui/FolderContentsModal.tsx:242-248`
   * records that an inactive folder still carries a link from a prior session.
   * It is the one genuinely ungated site of the three, and it sits on the
   * busiest route in the app: the post-grab completion effect opens THIS modal
   * after every multi-file grab, so a freshly-received folder would show Copy
   * Link immediately, for a drive this phone announces nothing about.
   *
   * Received rows require real announcing. **Hosted rows are untouched** —
   * `true` reproduces existing behaviour, and the hosted inactive-folder case
   * the comment describes is out of scope here.
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
       * This handler is not conditioned on `statusTone`. Both of the modal's
       * control branches call this same handler, so branching on tone here
       * would let a destructive action (whole-share deactivation) hide behind
       * a non-destructive label like "Open in another app".
       *
       * What a per-file control may do is open that one file. Nothing else.
       * It never stops a share, and it never offers to re-share a received
       * file. `statusTone` is not read anywhere in this row's construction,
       * so an edit to the ladder cannot decide which rows carry a
       * destructive action.
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
        // There is no per-row stop control here. A predicate like
        // `!isReceived && transferring` is uniformly true across every child
        // of a hosted folder that is transferring, so it would keep the
        // whole-share stop available on every row. The `isActiveShare` prop
        // does not exist.
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
    // `onStopSharing` is not part of this memo's body: the folder modal does
    // not offer "Stop sharing" for a file, so the dependency isn't needed.
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
  // received-share rows expose Share / Stop only through `kebabReshare`
  // below — the engine maps activate by driveId, not shareKey, so there is
  // no clean "this share" toggle otherwise. `onShareIt` / `onStopSharing`
  // still refuse them — those route by row id — and the re-share pair
  // routes by the engine driveId instead.
  const kebabIsReceivedShare = !!kebabDrive?.share;
  /**
   * The received row's Share / Stop control,
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
   * is this row a DOWNLOAD that is happening right now?
   *
   * Derived from `classifyTransfer` — the predicate in `transferActivity.ts`,
   * imported read-only and not modified — rather than a local `isDownloading`
   * flag. That module is the single answer to "is a transfer in flight", and
   * a second definition here would drift from the one the foreground service
   * uses, which is the exact failure its header warns about.
   *
   * `=== "download"` rather than `!== null`, and that restriction is the
   * answer to item 2.5 (uploads). A hosted share serving a peer classifies as
   * `"upload"`, and swapping ITS Delete to Cancel would be wrong twice over:
   *
   *  - The kebab already carries **Stop sharing** for an active hosted drive,
   *    which calls `deactivateDrive` — and 9G made `cancelInFlight` on a
   *    hosted drive call `engineDeactivateDrive` too. They are the same
   *    action, so the swap would put two identical items in one menu.
   *  - It would REMOVE Delete from a hosted share for as long as a peer
   *    happens to be connected. Deleting a share you are serving is a
   *    legitimate thing to want, and a transient peer should not hide it.
   *
   * So downloads get the swap and uploads keep Delete alongside the Stop
   * sharing they already had. Symmetry would have been the wrong instinct.
   *
   * The id set mirrors `performDelete`'s: a received row is a synth row keyed
   * by shareKey, and the engine may have produced several short-lived drive
   * entries for it across re-pastes, so the row's own id is not always the
   * one the transfer is filed under.
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
        onClose={() =>
          // closing the sheet also aborts any in-flight
          // resolve (and its 30 s timer). The pairing lives in
          // src/lib/receiveSheetClose.ts so the suite can assert it.
          closeReceiveSheet({
            hide: () => {
              setReceiveSheetVisible(false);
              setReceiveFocusPaste(false);
            },
            abortResolving,
          })
        }
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

      {/* The naming step for EVERY share — single file, bundle
         and folder. Cancel here means no share was ever created: `sharePaths`
         is simply not called, and on the folder path nothing has even been
         copied to cache yet (see `onPickFolder`). */}
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
          // bug fix: send the BASE, never a recombined filename.
          //
          // This used to call `joinNameAndExt(base, pending.ext)` and send the
          // complete name. The engine ALSO appends the file's real extension,
          // because it treats `shareName` as a base — so the extension was
          // applied twice, by two components each reasonably believing it
          // owned the job. On device that produced "Hello.jpg.jpeg".
          //
          // One applier now: the engine, because it is the only side holding
          // the authoritative on-disk filename. The suffix shown in the field
          // is read from the same URI the engine will read, so what the user
          // sees is what they get. `joinNameAndExt` remains the tested
          // statement of the rule the engine implements.
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
          // v5 kebab: Copy link + Show QR only make sense while the drive
          // is actively seeding — a dormant drive has no live link/QR to
          // hand out. When inactive, the "Start sharing" action at the
          // bottom is the meaningful next step instead.
          //
          // `kebabActive` is the wrong predicate for HALF the rows: it is
          // true for every hydrated received copy, all of which announce
          // nothing, so using it here would hand out a link this phone is
          // not advertising. `kebabCanOfferLink` keeps `active` for hosted
          // rows and requires real announcing for received ones.
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
          // The received row's re-share pair.
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
          // this change means Delete is no longer dangerous either way; this
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
         * The QR and Copy Link are gated on ANNOUNCING for a received row,
         * on `isActive` for a hosted one.
         *
         * The comment above holds for a hosted share but not for a received
         * one: a received link is "the string that grabbed the share", and
         * handing it on only works while THIS phone announces the drive.
         * `isActive` cannot see that — every hydrated received copy is
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
            // (A2): never offered on a received row. `onShareIt`
            // calls `activateDrive(drive.id)`, and a received row's id is
            // `share:<shareKey>` — `engineActivateDrive` keys `manifest.drives`
            // by driveId, so the lookup cannot hit and the engine answers
            // `drive-not-found`, which surfaced verbatim as the "Drive not
            // found" toast.
            //
            // Removed rather than gated on `localFiles.length > 0`: the id is
            // wrong for every received row regardless of what has been
            // downloaded, so a gate would move the failure to a different row
            // instead of removing it. Re-seeding a received copy is a real
            // feature and comes back when the engine can resume by share key
            // (tasks/9J-receive-state-followups.json).
            //
            // All three activation sites in this file route through
            // `canOfferStartSharing` — one definition, one test. Three separate
            // inline conditions is how this shipped three times.
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

            {/* Top bar holds only the back arrow; sharing lives in the
              *  inline share button below the video.
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
                {/* Share/stop-sharing toggle below the scrubber.
                  *  Only renders for hosted drives (received synth rows
                  *  can't activate via this path).
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

      {/* The confirm says what actually happens, and says it differently for
          a received share: the text names both what goes (PearDrop's own
          copy) and what stays (anything the user saved to Downloads). The
          wording lives in `src/lib/deleteReceivedPlan.ts` so it is reachable
          from the suite; this file is not. The batch-delete confirm below is
          deliberately untouched. */}
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

