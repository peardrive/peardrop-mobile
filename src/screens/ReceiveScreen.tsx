import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  ListRenderItem,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as FileSystemLegacy from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import RNFS from "react-native-fs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "../ui/themes";
import { useBackend } from "../state/backend";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import {
  deleteDownloaded,
  loadDownloaded,
  subscribeDownloaded,
  type DownloadedItem,
  fileType,
} from "../state/receivedFilesStorage";
import { formatBytes, formatClock } from "../lib/format";
import {
  baseName,
  fileIcon,
  mimeFromName,
  previewModeFor,
  type PreviewMode,
} from "../lib/files";
import { TransferCard } from "../ui/TransferCard";
import SwipeableRow from "../ui/SwipeableRow";
import ReceivedFileInfoModal from "../ui/ReceivedFileInfoModal";
import * as Clipboard from "expo-clipboard";
import {
  getSwipeHintSeen,
  setSwipeHintSeen,
} from "../state/swipeHintStorage";
import { useToast } from "../ui/Toast";
import { haptics } from "../lib/haptics";

type PreviewState = {
  item: DownloadedItem;
  mode: PreviewMode;
};

function createReceiveStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    mainShell: {
      flex: 1,
      marginHorizontal: theme.pad,
      marginTop: 4,
      marginBottom: 4,
    },
    headerBlock: {
      paddingHorizontal: theme.pad,
      paddingTop: theme.pad,
      paddingBottom: 12,
    },
    title: { fontSize: 24, fontWeight: "700", color: theme.text },
    titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
    sub: { fontSize: 14, color: theme.muted, marginBottom: 14 },
    receiveInputShell: {
      paddingHorizontal: theme.pad,
      paddingTop: 6,
      paddingBottom: theme.pad,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    receiveInputRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      paddingLeft: 14,
      paddingRight: 6,
      minHeight: 42,
    },
    receiveInput: { flex: 1, color: theme.text, fontSize: 14, paddingVertical: 10 },
    qrBtn: {
      width: 38,
      height: 38,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.cardStrong,
    },
    error: { marginTop: 6, fontSize: 12, color: theme.danger },
    cancelRow: { marginTop: 6, alignItems: "flex-end" },
    cancelText: { fontSize: 12, color: theme.muted, fontWeight: "600" },
    stillTrying: { marginTop: 6, fontSize: 12, color: theme.muted, fontStyle: "italic" },
    retryBtn: {
      marginTop: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.primaryMuted,
      backgroundColor: theme.surfaceSubtle,
    },
    retryText: { color: theme.primary, fontSize: 13, fontWeight: "600" },
    listFlex: {
      flex: 1,
      minHeight: 0,
      marginHorizontal: theme.pad,
      marginTop: 0,
      marginBottom: 8,
    },
    listShell: {
      flex: 1,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: "hidden",
    },
    list: { flex: 1 },
    listContent: {
      paddingHorizontal: 0,
    },
    listContentEmpty: {
      flexGrow: 1,
      justifyContent: "center",
    },
    // Minimal icon + message centered in the list area; without it the page
    // reads as broken rather than empty. No instructional prose — the link
    // input at the bottom already says what to do.
    emptyWrap: {
      flex: 1,
      paddingHorizontal: 24,
      paddingVertical: 32,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
    },
    emptyIconWrap: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
      marginBottom: 4,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: "600",
      color: theme.text,
      textAlign: "center",
    },
    emptySub: {
      fontSize: 13,
      color: theme.muted,
      textAlign: "center",
      lineHeight: 20,
      maxWidth: 280,
    },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 14,
      paddingHorizontal: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      position: "relative",
    },
    highlightOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.primaryMuted,
    },
    fileRowFirst: {
      borderTopWidth: 0,
    },
    icon: { width: 26, textAlign: "center", fontSize: 18 },
    fileMain: { flex: 1, minWidth: 0 },
    fileName: { color: theme.text, fontSize: 14, fontWeight: "500" },
    fileMeta: { color: theme.muted, fontSize: 12, marginTop: 3 },
    actionBtn: {
      minWidth: 88,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.primary,
    },
    actionBtnText: { color: theme.onPrimary, fontWeight: "700", fontSize: 12 },
    openBtn: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: theme.openAccent,
    },
    openBtnText: { color: theme.openAccent, fontWeight: "700", fontSize: 12 },
    kebabBtn: {
      paddingHorizontal: 6,
      paddingVertical: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    menuBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "flex-end",
    },
    menuSheet: {
      backgroundColor: theme.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingTop: 8,
    },
    menuRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 20,
      paddingVertical: 16,
      minHeight: 56,
    },
    menuRowText: {
      fontSize: 15,
      fontWeight: "500",
      color: theme.text,
    },
    menuRowDestructive: {
      color: theme.danger,
    },
    menuDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginHorizontal: 20,
    },
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
    transferCardWrap: { marginTop: 10 },
    previewBackdrop: {
      flex: 1,
      // Matches SharePreviewModal's scrim.
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      padding: 12,
    },
    previewCard: {
      maxHeight: "92%",
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
      // theme.bg is opaque; theme.card is a low-alpha tint that would let
      // file content behind the modal bleed through.
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
    previewClose: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
    },
    previewImage: {
      width: "100%",
      height: 360,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
    },
    previewVideo: {
      width: "100%",
      height: 360,
      borderRadius: 12,
      backgroundColor: "#000",
    },
    previewLoaderOverlay: {
      alignItems: "center",
      justifyContent: "center",
    },
    audioShell: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 10,
      padding: 12,
      backgroundColor: theme.cardStrong,
      gap: 12,
    },
    audioMeta: { color: theme.muted, fontSize: 12 },
    // Skip buttons flank play/pause; all three are circular tap targets sized
    // for a typical thumb.
    audioControlsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 24,
      marginTop: 4,
    },
    audioCtrlBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    audioPlayBtn: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.primary,
    },
    // Tap-to-seek scrubber. The fill is positioned absolutely inside
    // the track so the thumb appears as a small dot at the leading edge
    // of the filled portion.
    audioScrubber: {
      height: 28, // taller than visible track so tap target is generous
      justifyContent: "center",
    },
    audioScrubberTrack: {
      height: 6,
      borderRadius: 999,
      backgroundColor: theme.surfaceSubtle,
      overflow: "hidden",
    },
    audioScrubberFill: {
      height: "100%",
      backgroundColor: theme.primary,
    },
    audioTimeRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    audioTimeText: { color: theme.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
    previewText: { color: theme.text, fontSize: 13, lineHeight: 20 },
    previewHint: { color: theme.muted, fontSize: 12 },
    previewFooter: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  });
}

export default function ReceiveScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const styles = useMemo(() => createReceiveStyles(theme), [theme]);
  const { transfers, cancelTransfer, clearTransfer } = useBackend();
  const {
    sessionDriveId,
    linkDraft,
    setLinkDraft,
    resolving,
    linkError,
    setQrVisible,
    abortResolving,
    retryResolve,
    highlightedDownloadedIds,
    clearHighlights,
  } = useShareLinkFlow();
  const { show: showToastRaw } = useToast();
  const showToast = useCallback(
    (msg: string, kind: "info" | "error" = "info") => showToastRaw(msg, { kind }),
    [showToastRaw]
  );
  const [downloaded, setDownloaded] = useState<DownloadedItem[]>([]);
  const [expandedTransfer, setExpandedTransfer] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [stillTrying, setStillTrying] = useState(false);
  const [peekTopmost, setPeekTopmost] = useState(false);
  const [infoFileId, setInfoFileId] = useState<string | null>(null);
  const [menuItem, setMenuItem] = useState<DownloadedItem | null>(null);
  // IDs that just arrived from a download. Same flash animation as the dedup
  // highlight, but driven by storage subscribe rather than paste-time
  // classification.
  const [newHighlightIds, setNewHighlightIds] = useState<string[]>([]);
  // Set of all IDs we've seen in any prior subscribe emit. Initialized
  // empty so the FIRST emit (cold start with already-present files) does
  // NOT highlight — only emits AFTER mount count as "new arrivals".
  const prevDownloadedIdsRef = useRef<Set<string>>(new Set());
  const haveSeenInitialEmitRef = useRef(false);
  const flatListRef = useRef<FlatList<DownloadedItem>>(null);
  // 1 = full accent overlay, 0 = transparent. One shared animation for dedup
  // hits and new arrivals: merging both sources into a single render set
  // keeps the effect from double-firing when both happen in one tick.
  const highlightAnim = useRef(new Animated.Value(0)).current;
  const highlightSet = useMemo(
    () => new Set([...highlightedDownloadedIds, ...newHighlightIds]),
    [highlightedDownloadedIds, newHighlightIds],
  );

  // Derive media sources from the current preview so the expo-audio /
  // expo-video hooks can manage player lifetime for us. Hooks must run on
  // every render, so null-source is a first-class state rather than a
  // conditional call.
  const audioUri = useMemo(() => {
    if (!(preview?.mode === "audio" && preview.item)) return null;
    return preview.item.path.startsWith("file://")
      ? preview.item.path
      : `file://${preview.item.path}`;
  }, [preview]);
  const videoUri = useMemo(() => {
    if (!(preview?.mode === "video" && preview.item)) return null;
    return preview.item.path.startsWith("file://")
      ? preview.item.path
      : `file://${preview.item.path}`;
  }, [preview]);

  const audioPlayer = useAudioPlayer(audioUri);
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const audioPlaying = audioStatus.playing;
  const videoPlayer = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  // expo-audio's `useAudioPlayerStatus` exposes `playing` / `didJustFinish`
  // reactively but not currentTime, so it's polled directly from the player to
  // drive the scrubber. Stops when the modal closes or the preview switches
  // away from audio.
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [scrubWidth, setScrubWidth] = useState(0);
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
        // expo-audio occasionally throws if the player is mid-disposal;
        // safe to ignore — next tick will succeed or we'll unmount.
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [preview?.mode, audioPlayer]);

  // After 5 s of resolving the user wonders if anything's happening. Surface
  // a gentle hint above the Cancel row. Reset the instant resolving flips
  // off so the hint never shows for a fast resolve.
  useEffect(() => {
    if (!resolving) {
      setStillTrying(false);
      return;
    }
    const timer = setTimeout(() => setStillTrying(true), 5000);
    return () => clearTimeout(timer);
  }, [resolving]);

  const refreshList = useCallback(() => {
    loadDownloaded().then(setDownloaded).catch(() => {});
  }, []);

  // Live-subscribe to the downloads index so the list updates as soon as
  // appendDownloadResults / deleteDownloaded run, with no tab switch. Matters
  // most on the demo path, where no backend events fire. Each emit diffs IDs
  // against the previous one and flashes the new ones; the first emit only
  // seeds the ref, since those files predate mount.
  useEffect(() => {
    return subscribeDownloaded((items) => {
      setDownloaded(items);
      const currentIds = new Set(items.map((i) => i.id));
      const prev = prevDownloadedIdsRef.current;
      if (!haveSeenInitialEmitRef.current) {
        haveSeenInitialEmitRef.current = true;
        prevDownloadedIdsRef.current = currentIds;
        return;
      }
      const newIds: string[] = [];
      for (const id of currentIds) if (!prev.has(id)) newIds.push(id);
      prevDownloadedIdsRef.current = currentIds;
      if (newIds.length > 0) {
        setNewHighlightIds((cur) =>
          Array.from(new Set([...cur, ...newIds])),
        );
      }
    });
  }, []);

  // Keep useFocusEffect as a safety net: if files were deleted via the OS
  // file manager (or some other path that doesn't go through saveDownloaded),
  // returning to the tab still re-filters the on-disk list.
  useFocusEffect(
    useCallback(() => {
      refreshList();
    }, [refreshList])
  );

  const sortedDownloaded = useMemo(
    () => [...downloaded].sort((a, b) => b.downloadedAt - a.downloadedAt),
    [downloaded]
  );

  // One-shot swipe-hint peek on the topmost row the first time the list has
  // items. The flag is marked seen immediately, before the delay, so a sibling
  // list doesn't also fire — the cue is shared.
  useEffect(() => {
    if (peekTopmost) return;
    if (sortedDownloaded.length === 0) return;
    let cancelled = false;
    void getSwipeHintSeen().then((seen) => {
      if (cancelled || seen) return;
      void setSwipeHintSeen(true);
      const timer = setTimeout(() => {
        if (!cancelled) setPeekTopmost(true);
      }, 500);
      return () => clearTimeout(timer);
    });
    return () => {
      cancelled = true;
    };
  }, [sortedDownloaded.length, peekTopmost]);

  const onPeekDone = useCallback(() => setPeekTopmost(false), []);

  const activeDownloadTransfer = useMemo(() => {
    if (sessionDriveId) {
      const exact = transfers.find((t) => t.driveId === sessionDriveId);
      if (exact && exact.origin === "received") return exact;
    }
    return transfers
      .filter((t) => t.origin === "received")
      .sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
  }, [transfers, sessionDriveId]);

  // When the active download completes, celebrate briefly (haptic + toast),
  // refresh the downloaded list so the new files show up immediately, and
  // auto-dismiss the transfer strip after 4 s. The × dismiss button is
  // still there as a manual override for in-flight transfers.
  const completedDriveIdRef = useRef<string | null>(null);
  useEffect(() => {
    const t = activeDownloadTransfer;
    if (!t || !t.completed) return;
    if (completedDriveIdRef.current === t.driveId) return;
    completedDriveIdRef.current = t.driveId;
    haptics.success();
    showToast("Got it — files saved", "info");
    refreshList();
    const driveId = t.driveId;
    const timer = setTimeout(() => clearTransfer(driveId), 4000);
    return () => clearTimeout(timer);
  }, [activeDownloadTransfer, clearTransfer, refreshList, showToast]);

  // Surfaces a friendly error when the stall detector flips `stalled: true` on
  // a received transfer. The card deliberately stays visible so the user can
  // see what happened and dismiss it themselves. Tracked separately from
  // completedDriveIdRef so a stall followed by a clean retry doesn't suppress
  // the later success toast.
  const stalledDriveIdRef = useRef<string | null>(null);
  useEffect(() => {
    const t = activeDownloadTransfer;
    if (!t || !t.stalled) return;
    if (stalledDriveIdRef.current === t.driveId) return;
    stalledDriveIdRef.current = t.driveId;
    haptics.warning();
    showToast(
      "Couldn't finish the download — the other side may have disconnected.",
      "error",
    );
  }, [activeDownloadTransfer, showToast]);

  // Highlight pulse for both already-added detection and new arrivals. Bursts
  // to 1, fades to 0, then drops the IDs from both sources so the overlay
  // clears. Scrolls the first match into view so the flash is visible on a long
  // list. Native driver is off because opacity is animated through a
  // state-driven render gate.
  useEffect(() => {
    const allIds = [...highlightedDownloadedIds, ...newHighlightIds];
    if (allIds.length === 0) return;
    const idSet = new Set(allIds);
    const firstIdx = sortedDownloaded.findIndex((it) => idSet.has(it.id));
    if (firstIdx >= 0) {
      try {
        flatListRef.current?.scrollToIndex({
          index: firstIdx,
          animated: true,
          viewPosition: 0.3,
        });
      } catch {
        // scrollToIndex throws if the list hasn't laid out yet — harmless.
      }
    }
    highlightAnim.setValue(1);
    const anim = Animated.timing(highlightAnim, {
      toValue: 0,
      duration: 1500,
      useNativeDriver: false,
    });
    anim.start(({ finished }) => {
      if (finished) {
        clearHighlights();
        setNewHighlightIds([]);
      }
    });
    return () => anim.stop();
  }, [
    highlightedDownloadedIds,
    newHighlightIds,
    sortedDownloaded,
    highlightAnim,
    clearHighlights,
  ]);

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
    [showToast]
  );

  const closePreview = useCallback(() => {
    // Pause any playing media; the hooks will auto-release the players when
    // the source becomes null on the next render. We explicitly pause here
    // so audio doesn't continue for the ~1 frame before the source clears.
    if (audioPlayer?.playing) audioPlayer.pause();
    if (videoPlayer?.playing) videoPlayer.pause();
    setPreview(null);
    setPreviewText("");
    setPreviewLoading(false);
  }, [audioPlayer, videoPlayer]);

  const onPreviewFile = useCallback(
    async (item: DownloadedItem) => {
      const mode = previewModeFor(item.name);
      if (mode === "unsupported") {
        showToast("Can't preview this one — try Open instead.");
        return;
      }
      // Pause anything already playing before we swap the source. The hooks
      // replace their underlying player when `audioUri` / `videoUri` change,
      // so we don't need to manually dispose the old one.
      if (audioPlayer?.playing) audioPlayer.pause();
      if (videoPlayer?.playing) videoPlayer.pause();
      setPreview({ item, mode });
      if (mode === "text") {
        setPreviewLoading(true);
        try {
          const txt = await RNFS.readFile(item.path, "utf8");
          setPreviewText(txt.slice(0, 4000));
        } catch (e: unknown) {
          setPreviewText(`Can't preview this one — ${String((e as Error)?.message || e)}`);
        } finally {
          setPreviewLoading(false);
        }
      } else {
        setPreviewText("");
        setPreviewLoading(false);
      }
    },
    [audioPlayer, videoPlayer, showToast]
  );

  const onToggleAudioPreview = useCallback(() => {
    if (!preview?.item || preview.mode !== "audio" || !audioPlayer) return;
    try {
      if (audioPlayer.playing) {
        audioPlayer.pause();
      } else {
        // If playback has already finished, seek back to the start so the
        // user doesn't tap Play to silence. expo-audio exposes currentTime
        // directly on the player instance.
        if (audioStatus.didJustFinish || audioPlayer.currentTime >= audioPlayer.duration) {
          audioPlayer.seekTo(0);
        }
        audioPlayer.play();
      }
    } catch (e: unknown) {
      showToast(`Couldn't play that — ${String((e as Error)?.message || e)}`, "error");
    }
  }, [preview, audioPlayer, audioStatus, showToast]);

  // Skip handlers and tap-to-seek, clamped to [0, duration] so a seek can't
  // overshoot the end of the file.
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

  const onDeleteDownloaded = useCallback(
    async (item: DownloadedItem) => {
      try {
        const next = await deleteDownloaded(item.id);
        setDownloaded(next);
        haptics.actionDone();
        showToast("Deleted.");
      } catch (e: unknown) {
        showToast(`Couldn't delete — ${String((e as Error)?.message || e)}`, "error");
      }
    },
    [showToast]
  );

  const renderDownloadedItem: ListRenderItem<DownloadedItem> = useCallback(
    ({ item, index }) => {
      const highlighted = highlightSet.has(item.id);
      return (
        <SwipeableRow
          onDelete={() => void onDeleteDownloaded(item)}
          deleteLabel="Delete"
          accessibilityLabel={`${baseName(item.name)}, ${formatBytes(item.size)}`}
          peek={index === 0 && peekTopmost}
          onPeekDone={onPeekDone}
        >
          <Pressable
            style={[styles.fileRow, index === 0 && styles.fileRowFirst]}
            onPress={() => void onPreviewFile(item)}
            accessibilityRole="button"
            accessibilityLabel={`Preview ${baseName(item.name)}`}
          >
            {highlighted ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.highlightOverlay,
                  { opacity: highlightAnim },
                ]}
              />
            ) : null}
            <Text style={styles.icon}>{fileIcon(item.name)}</Text>
            <View style={styles.fileMain}>
              <Text style={styles.fileName} numberOfLines={2}>
                {baseName(item.name)}
              </Text>
              <Text style={styles.fileMeta}>
                {formatBytes(item.size)} · {fileType(item.name)}
              </Text>
            </View>
            <Pressable
              style={styles.kebabBtn}
              onPress={() => setMenuItem(item)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`More options for ${baseName(item.name)}`}
            >
              <Ionicons name="ellipsis-vertical" size={20} color={theme.muted} />
            </Pressable>
          </Pressable>
        </SwipeableRow>
      );
    },
    [highlightSet, highlightAnim, onDeleteDownloaded, onPreviewFile, onPeekDone, peekTopmost, styles, theme.muted]
  );

  // Reinstated 2026-05-14: rendering nothing read as "broken-empty" on
  // device. Minimal warm empty state — icon + a short title + a one-line
  // hint. The link input below remains the call-to-action.
  const downloadedEmpty = useMemo(
    () => (
      <View style={styles.emptyWrap} accessibilityRole="summary">
        <View style={styles.emptyIconWrap}>
          <Ionicons name="download-outline" size={36} color={theme.muted} />
        </View>
        <Text style={styles.emptyTitle}>Nothing here yet</Text>
        <Text style={styles.emptySub}>
          Drop a peardrop:// link below and grabbed files will show up here.
        </Text>
      </View>
    ),
    [styles, theme.muted],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + theme.pad }]}>
      {/*
       * KeyboardAvoidingView wraps mainShell so the link input + retry
       * button + QR button stay visible above the on-screen keyboard.
       * iOS uses "padding" because adjustResize isn't a thing there;
       * Android uses "height" — even though `windowSoftInputMode` defaults
       * to adjustResize, GrapheneOS's keyboard sometimes overlays the
       * input on certain ROMs without this. flex:1 is needed so the
       * wrapper takes the available space inside root.
       */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.mainShell}>
          <View style={styles.headerBlock}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>Receive</Text>
          </View>
          <Text style={styles.sub}>Things other people send you land here.</Text>

          {activeDownloadTransfer && (
            <View style={styles.transferCardWrap}>
              <TransferCard
                transfer={activeDownloadTransfer}
                expanded={expandedTransfer}
                onToggleExpanded={() => setExpandedTransfer((p) => !p)}
                onCancel={() => void cancelTransfer(activeDownloadTransfer.driveId)}
                onClear={() => clearTransfer(activeDownloadTransfer.driveId)}
                showDismiss
              />
            </View>
          )}
        </View>

        <View style={styles.listFlex}>
          <View style={styles.listShell}>
            <FlatList
              ref={flatListRef}
              data={sortedDownloaded}
              keyExtractor={(d) => d.id}
              renderItem={renderDownloadedItem}
              ListEmptyComponent={downloadedEmpty}
              contentContainerStyle={[
                styles.listContent,
                sortedDownloaded.length === 0 && styles.listContentEmpty,
                { paddingBottom: 8 },
              ]}
              style={styles.list}
              showsVerticalScrollIndicator={false}
              onScrollToIndexFailed={() => {
                /* Layout race when the list hasn't measured yet — the
                 * highlight is still visible thanks to the overlay; users
                 * scrolling on their own will see it. */
              }}
            />
          </View>
        </View>
        <View style={styles.receiveInputShell}>
          <View style={styles.receiveInputRow}>
            <TextInput
              style={styles.receiveInput}
              placeholder="Drop a peardrop:// link here"
              placeholderTextColor={theme.muted}
              value={linkDraft}
              onChangeText={setLinkDraft}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!resolving}
              accessibilityLabel="Share link input"
            />
            {resolving ? <ActivityIndicator color={theme.primary} style={{ marginRight: 4 }} /> : null}
            {linkDraft.length > 0 && !resolving ? (
              <Pressable
                onPress={() => setLinkDraft("")}
                style={styles.qrBtn}
                accessibilityRole="button"
                accessibilityLabel="Clear link"
                hitSlop={8}
              >
                <Ionicons name="close-circle" size={22} color={theme.muted} />
              </Pressable>
            ) : null}
            <Pressable
              style={styles.qrBtn}
              onPress={() => setQrVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="Scan QR code"
            >
              <Ionicons name="qr-code-outline" size={22} color={theme.text} />
            </Pressable>
          </View>
          {!!linkError && <Text style={styles.error}>{linkError}</Text>}
          {!!linkError && !resolving && linkDraft.trim().length > 0 && (
            <Pressable
              style={styles.retryBtn}
              onPress={() => void retryResolve()}
              accessibilityRole="button"
              accessibilityLabel="Try again"
              accessibilityHint="Re-runs the connection with the same link"
            >
              <Ionicons name="refresh" size={14} color={theme.primary} />
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          )}
          {resolving && stillTrying && (
            <Text style={styles.stillTrying} accessibilityLiveRegion="polite">
              Still looking… the other pear might be offline or on a slow network.
            </Text>
          )}
          {resolving && (
            <Pressable
              style={styles.cancelRow}
              onPress={() => abortResolving()}
              accessibilityRole="button"
              accessibilityLabel="Cancel link resolution"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          )}
          </View>
        </View>
      </KeyboardAvoidingView>
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={closePreview}>
        <Pressable
          style={styles.previewBackdrop}
          onPress={closePreview}
          accessibilityLabel="Close preview"
        >
          <Pressable
            style={styles.previewCard}
            onPress={() => {
              // Absorb inner taps so they don't propagate to the backdrop
              // and accidentally close the modal while the user is reading.
            }}
          >
            <View style={styles.previewTitleRow}>
              <Text style={styles.previewTitle} numberOfLines={1}>
                {preview?.item ? baseName(preview.item.name) : "Preview"}
              </Text>
              <Pressable
                onPress={closePreview}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close preview"
                style={styles.previewClose}
              >
                <Ionicons name="close" size={20} color={theme.muted} />
              </Pressable>
            </View>
            {preview?.mode === "image" && preview?.item && (
              <View>
                {previewLoading ? (
                  <View style={styles.previewLoaderOverlay}>
                    <ActivityIndicator color={theme.primary} />
                  </View>
                ) : null}
                <Image
                  source={{
                    uri: preview.item.path.startsWith("file://")
                      ? preview.item.path
                      : `file://${preview.item.path}`,
                  }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </View>
            )}
            {preview?.mode === "video" && preview?.item && (
              <VideoView
                player={videoPlayer}
                style={styles.previewVideo}
                allowsFullscreen
                nativeControls
                contentFit="contain"
              />
            )}
            {preview?.mode === "audio" && preview?.item && (
              <View style={styles.audioShell}>
                <Text style={styles.audioMeta}>♫ {baseName(preview.item.name)}</Text>
                <View style={styles.audioControlsRow}>
                  <Pressable
                    style={styles.audioCtrlBtn}
                    onPress={() => onAudioSkip(-15)}
                    accessibilityRole="button"
                    accessibilityLabel="Skip back 15 seconds"
                  >
                    <Ionicons name="play-back" size={20} color={theme.text} />
                  </Pressable>
                  <Pressable
                    style={styles.audioPlayBtn}
                    onPress={onToggleAudioPreview}
                    accessibilityRole="button"
                    accessibilityLabel={audioPlaying ? "Pause" : "Play"}
                  >
                    <Ionicons
                      name={audioPlaying ? "pause" : "play"}
                      size={26}
                      color={theme.onPrimary}
                    />
                  </Pressable>
                  <Pressable
                    style={styles.audioCtrlBtn}
                    onPress={() => onAudioSkip(15)}
                    accessibilityRole="button"
                    accessibilityLabel="Skip forward 15 seconds"
                  >
                    <Ionicons name="play-forward" size={20} color={theme.text} />
                  </Pressable>
                </View>
                <Pressable
                  style={styles.audioScrubber}
                  onLayout={(e) => setScrubWidth(e.nativeEvent.layout.width)}
                  onPress={(e) => {
                    if (scrubWidth <= 0) return;
                    const x = e.nativeEvent.locationX;
                    const fraction = Math.max(0, Math.min(1, x / scrubWidth));
                    onAudioSeekToFraction(fraction);
                  }}
                  accessibilityRole="adjustable"
                  accessibilityLabel="Audio progress"
                  accessibilityValue={{
                    now: Math.round(audioPosition),
                    min: 0,
                    max: Math.max(1, Math.round(audioDuration)),
                  }}
                  accessibilityActions={[
                    { name: "increment", label: "Forward 10 seconds" },
                    { name: "decrement", label: "Back 10 seconds" },
                  ]}
                  onAccessibilityAction={(ev) => {
                    if (ev.nativeEvent.actionName === "increment") onAudioSkip(10);
                    else if (ev.nativeEvent.actionName === "decrement") onAudioSkip(-10);
                  }}
                >
                  <View style={styles.audioScrubberTrack}>
                    <View
                      style={[
                        styles.audioScrubberFill,
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
                <View style={styles.audioTimeRow}>
                  <Text style={styles.audioTimeText}>{formatClock(audioPosition)}</Text>
                  <Text style={styles.audioTimeText}>
                    {audioDuration > 0 ? formatClock(audioDuration) : "—:—"}
                  </Text>
                </View>
              </View>
            )}
            {preview?.mode === "text" && (
              <ScrollView style={{ maxHeight: 320 }}>
                {previewLoading ? (
                  <ActivityIndicator color={theme.primary} />
                ) : (
                  <Text style={styles.previewText}>{previewText || "(Empty file)"}</Text>
                )}
              </ScrollView>
            )}
            <Text style={styles.previewHint}>
              Playback acting up? Try Open in another app.
            </Text>
            <View style={styles.previewFooter}>
              {preview?.item && (
                <Pressable
                  style={styles.previewBtn}
                  onPress={() => onOpenFile(preview.item.path)}
                  accessibilityRole="button"
                  accessibilityLabel="Open in another app"
                >
                  <Text style={styles.previewBtnText}>Open in another app</Text>
                </Pressable>
              )}
              <Pressable
                style={[styles.actionBtn, styles.openBtn]}
                onPress={closePreview}
                accessibilityRole="button"
                accessibilityLabel="Close preview"
              >
                <Text style={styles.openBtnText}>Close</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      <ReceivedFileInfoModal
        visible={!!infoFileId}
        file={
          infoFileId
            ? downloaded.find((d) => d.id === infoFileId) ?? undefined
            : undefined
        }
        onClose={() => setInfoFileId(null)}
        onCopyLink={async (link) => {
          await Clipboard.setStringAsync(link);
          showToast("Link copied.");
        }}
        onShareLink={async (link) => {
          try {
            await Share.share({ message: link });
          } catch {
            // User dismissed the share sheet or the platform refused —
            // either way nothing to recover from.
          }
        }}
      />
      <Modal
        visible={!!menuItem}
        transparent
        animationType="slide"
        onRequestClose={() => setMenuItem(null)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setMenuItem(null)}
          accessibilityLabel="Close menu"
        >
          <View
            style={[styles.menuSheet, { paddingBottom: insets.bottom + 8 }]}
            onStartShouldSetResponder={() => true}
          >
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                const item = menuItem;
                setMenuItem(null);
                if (item) setInfoFileId(item.id);
              }}
              accessibilityRole="button"
              accessibilityLabel="More info"
            >
              <Ionicons name="information-circle-outline" size={22} color={theme.text} />
              <Text style={styles.menuRowText}>More info</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                const item = menuItem;
                setMenuItem(null);
                if (item) void onOpenFile(item.path);
              }}
              accessibilityRole="button"
              accessibilityLabel="Open in other app"
            >
              <Ionicons name="open-outline" size={22} color={theme.text} />
              <Text style={styles.menuRowText}>Open in other app</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                const item = menuItem;
                setMenuItem(null);
                if (!item) return;
                Alert.alert(
                  "Delete file?",
                  "This removes the file from your device.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => void onDeleteDownloaded(item),
                    },
                  ]
                );
              }}
              accessibilityRole="button"
              accessibilityLabel="Delete"
            >
              <Ionicons name="trash-outline" size={22} color={theme.danger} />
              <Text style={[styles.menuRowText, styles.menuRowDestructive]}>Delete</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
