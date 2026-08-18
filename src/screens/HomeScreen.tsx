import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Modal,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { pickFolder, enumerateFolder, FolderTooLargeError } from "../lib/folderShare";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "../ui/themes";
import { useBackend } from "../state/backend";
import { useDevMode } from "../state/devModeStorage";
import type { TransferSummary } from "../state/types";
import { useMainDockBottomInset } from "../navigation/dockLayout";
import { formatBytes } from "../lib/format";
import { truncateMiddle } from "../lib/files";
import { errorMessage } from "../lib/errorMessage";
import { useToast } from "../ui/Toast";
import { TransferCard } from "../ui/TransferCard";
import ShareQrModal from "../ui/ShareQrModal";
import { haptics } from "../lib/haptics";
import SwipeableRow from "../ui/SwipeableRow";
import {
  addBundle as persistBundle,
  loadBundles as loadPersistedBundles,
  removeBundle as persistRemoveBundle,
  type PersistedBundle,
} from "../state/bundlesStorage";
import {
  getSwipeHintSeen,
  setSwipeHintSeen,
} from "../state/swipeHintStorage";
import {
  getPickerBackHintSeen,
  setPickerBackHintSeen,
} from "../state/pickerHintStorage";

type SelectedFile = {
  name: string;
  size?: number;
  /** Source URI on disk. Empty when the bundle was hydrated from persistence
   * (the original picker URI is gone after an app restart). */
  uri: string;
};

type ShareBundle = {
  id: string;
  files: SelectedFile[];
  shareLink: string;
  driveId?: string;
  /** True for bundles loaded from persistence after an app restart. The
   * engine no longer announces these on the swarm — they're history records.
   * Live bundles created in this session have `dormant: false`. */
  dormant?: boolean;
  createdAt?: number;
};

function legacyUriPick(res: object): SelectedFile[] | null {
  if (!("uri" in res)) return null;
  const uri = (res as { uri: unknown }).uri;
  if (typeof uri !== "string" || !uri) return null;
  const name = (res as { name?: unknown }).name;
  const size = (res as { size?: unknown }).size;
  return [
    {
      name: typeof name === "string" ? name : "file",
      size: typeof size === "number" ? size : undefined,
      uri,
    },
  ];
}

function pickFiles(res: DocumentPicker.DocumentPickerResult): SelectedFile[] {
  if (res.canceled) return [];
  const assets = "assets" in res ? res.assets : undefined;
  if (assets?.length) {
    return assets
      .filter((a) => !!a.uri)
      .map((a) => ({
        name: a.name || a.uri.split("/").pop() || "file",
        size: a.size ?? undefined,
        uri: a.uri,
      }));
  }
  return legacyUriPick(res) ?? [];
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    mainShell: {
      flex: 1,
      marginHorizontal: theme.pad,
      marginTop: 4,
      marginBottom: 4,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.card,
      overflow: "hidden",
    },
    scrollInner: { padding: theme.pad, paddingBottom: 24 },
    titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
    title: { fontSize: 24, fontWeight: "700", color: theme.text },
    sub: { fontSize: 14, color: theme.muted, marginBottom: 14 },
    topSection: { marginBottom: 14 },
    topActions: { marginBottom: 6 },
    topActionsContent: { gap: 12, paddingVertical: 4 },
    actionCard: {
      width: 168,
      minHeight: 112,
      borderRadius: 18,
      padding: 16,
      backgroundColor: theme.cardStrong,
      borderWidth: 1,
      borderColor: theme.border,
      justifyContent: "space-between",
    },
    actionCardPressed: { opacity: 0.92 },
    actionIconWrap: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: theme.tabActiveOverlay,
      alignItems: "center",
      justifyContent: "center",
    },
    actionTitle: { color: theme.text, fontWeight: "700", fontSize: 16, marginTop: 10 },
    actionHint: { color: theme.muted, fontSize: 12, marginTop: 4, lineHeight: 16 },
    statusLine: { color: theme.muted, marginBottom: 10, fontSize: 12 },
    middleSection: { marginTop: 2, minHeight: 120 },
    sectionLabel: { color: theme.muted, fontSize: 12, fontWeight: "600", marginBottom: 8, letterSpacing: 0.4 },
    // Full rounded corners so the swipe-reveal backing matches a standalone
    // bundle card's rounding.
    bundleSwipeWrap: {
      borderRadius: 16,
    },
    // Paired with a transfer card below: round only the top corners, matching
    // the bundle card's flattened bottom edge.
    bundleSwipeWrapPaired: {
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
    },
    // Minimal launcher card. Tap opens the QR/action modal; swipe-to-delete
    // handles stop/remove. Dormant and failed states are signalled through
    // opacity plus a small icon rather than prose.
    bundleCard: {
      backgroundColor: theme.cardStrong,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 16,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    bundleCardPressed: { opacity: 0.88 },
    bundleCardDormant: { opacity: 0.55 },
    bundleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    bundleIdentity: { flex: 1, minWidth: 0 },
    bundleTitle: { color: theme.text, fontWeight: "700", fontSize: 15 },
    bundleTitleMuted: { color: theme.muted, fontWeight: "500" },
    bundleSubRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 4,
    },
    bundleStateIcon: { marginRight: 2 },
    // Filename summary: muted and small, but no tabular-nums — filenames
    // aren't digit grids.
    bundleVerify: {
      color: theme.muted,
      fontSize: 12,
      flexShrink: 1,
    },
    // Peer-connected indicator. Pulses while at least one peer is connected,
    // vanishes when none. theme.primary reads as "active" without alarming.
    peerDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.primary,
    },
    peerDotText: {
      color: theme.primary,
      fontSize: 12,
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
    },
    qrBtn: {
      width: 40,
      height: 40,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    // A hosted bundle with an active transfer renders the transfer directly
    // beneath it with flattened touching edges, so the two read as one unit.
    // SwipeableRow still wraps the bundle card alone — swipe gestures don't
    // extend over the transfer card.
    bundlePairWrap: {
      marginBottom: 14,
    },
    bundleCardPaired: {
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      borderBottomWidth: 0,
    },
    pairedTransferWrap: {
      // The transfer card itself owns borderRadius via TransferCard; we
      // need to flatten only the top corners so the join with the bundle
      // card above is seamless. Easiest path: clip via a wrapper that
      // overrides border-radius on its single child.
      marginHorizontal: 0,
      borderBottomLeftRadius: 16,
      borderBottomRightRadius: 16,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      overflow: "hidden",
    },
    transferCardWrap: { marginTop: 10 },
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
    menuRowText: { fontSize: 15, fontWeight: "500", color: theme.text },
    menuRowHint: { fontSize: 12, color: theme.muted, marginTop: 2 },
    menuRowBody: { flex: 1 },
    menuDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginHorizontal: 20,
    },
  });
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const dockBottom = useMainDockBottomInset();
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const {
    ready,
    status,
    sharePaths,
    transfers,
    cancelTransfer,
    clearTransfer,
    activeDriveIds,
    failedHydrationIds,
  } = useBackend();
  const { enabled: devMode } = useDevMode();
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [pickerSheetOpen, setPickerSheetOpen] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [bundles, setBundles] = useState<ShareBundle[]>([]);
  const [expandedDriveIds, setExpandedDriveIds] = useState<Record<string, boolean>>({});
  // The QR modal is the action hub. Opened by id so it can also drive
  // Stop-sharing without a separate path.
  const [qrBundleId, setQrBundleId] = useState<string | null>(null);
  const [peekTopmost, setPeekTopmost] = useState(false);
  const { show: showToastRaw } = useToast();
  const showToast = useCallback(
    (message: string, kind: "info" | "success" | "error" = "info") =>
      showToastRaw(message, { kind }),
    [showToastRaw]
  );

  const visibleTransfers = useMemo(() => {
    // Show only transfers originating from drives we host. Anything that
    // came in via a share link belongs on the Receive tab.
    const hosted = transfers.filter((t) => t.origin === "hosted");
    // In user mode, hide hosted transfers still in their seeded state: the
    // bundle card already says "share is live, waiting for someone to grab
    // it", so a separate waiting strip is just chatter. Dev mode keeps full
    // visibility.
    const filtered = devMode
      ? hosted
      : hosted.filter((t) => t.completed || t.peersConnected > 0);
    return filtered.slice(0, 8);
  }, [transfers, devMode]);

  // One-shot swipe-hint peek on the topmost bundle card the first time the
  // list has items. The flag is marked seen immediately, before the delay, so
  // the Receive list checking in the same window doesn't also fire — the cue
  // is shared across both.
  useEffect(() => {
    if (peekTopmost) return;
    if (bundles.length === 0) return;
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
  }, [bundles.length, peekTopmost]);

  const onPeekDone = useCallback(() => setPeekTopmost(false), []);

  // One shared Animated.Value drives every visible peer-connected dot, so the
  // pulse stays in sync across cards. The loop runs only while at least one
  // bundle has connected peers — lighter on the JS thread, and no dot pulsing
  // invisibly in the background.
  const peerPulse = useRef(new Animated.Value(1)).current;
  const anyPeerConnected = useMemo(
    () =>
      bundles.some((b) =>
        b.driveId
          ? (transfers.find((t) => t.driveId === b.driveId)?.peersConnected ??
              0) > 0
          : false,
      ),
    [bundles, transfers],
  );
  useEffect(() => {
    if (!anyPeerConnected) {
      peerPulse.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(peerPulse, {
          toValue: 0.35,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(peerPulse, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [anyPeerConnected, peerPulse]);

  // Per-bundle transfer lookup so the render path doesn't .find() N times
  // per render across N bundles.
  const transferByDriveId = useMemo(() => {
    const m = new Map<string, TransferSummary>();
    for (const t of transfers) m.set(t.driveId, t);
    return m;
  }, [transfers]);

  // One-time educational toast on the first picker back-out. Some Android
  // pickers, Google Drive especially, expose no obvious back button; the OS
  // picker can't be modified, but the gesture can be taught once on return.
  // The flag is persisted so it never fires again.
  const maybeShowPickerBackHint = useCallback(() => {
    void getPickerBackHintSeen().then((seen) => {
      if (seen) return;
      void setPickerBackHintSeen(true);
      showToast("Tap back or swipe from the edge to return next time.", "info");
    });
  }, [showToast]);

  // Hydrate persisted bundles on mount. Anything loaded here was created in a
  // previous session and is dormant — the engine isn't announcing it. Bundles
  // created this session are appended above with `dormant: false`.
  useEffect(() => {
    let mounted = true;
    void loadPersistedBundles().then((persisted: PersistedBundle[]) => {
      if (!mounted || persisted.length === 0) return;
      const hydrated: ShareBundle[] = persisted.map((b) => ({
        id: b.driveId,
        files: b.files.map((f) => ({ name: f.name, size: f.size, uri: "" })),
        shareLink: b.shareLink,
        driveId: b.driveId,
        dormant: true,
        createdAt: b.createdAt,
      }));
      // Merge with whatever's already in state (live bundles created this
      // session). De-dup on driveId so a re-share of the same drive within
      // a session doesn't double up.
      setBundles((prev) => {
        const liveIds = new Set(prev.map((b) => b.driveId).filter(Boolean));
        const dormantOnly = hydrated.filter((h) => !liveIds.has(h.driveId));
        return [...prev, ...dormantOnly];
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Auto-clear the sender's progress card 12 s after a hosted transfer
  // completes AND the last peer disconnects (peersConnected === 0). The
  // bundle card itself (with the share link) stays — we're only removing
  // the transfer-progress strip. If a new peer connects before the timer
  // fires we leave the card alone; the next completion cycle schedules
  // its own clear.
  //
  // Long enough to perceive: real transfers complete in well under a second,
  // so a shorter window flashes "Sending" → "Sent" faster than the user can
  // read it. Bundle persistence keeps the share visible regardless.
  const TRANSFER_AUTO_CLEAR_MS = 12000;
  const scheduledClearRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const scheduled = scheduledClearRef.current;
    for (const t of visibleTransfers) {
      const eligible = t.completed && t.peersConnected === 0;
      if (!eligible) continue;
      if (scheduled.has(t.driveId)) continue;
      const driveId = t.driveId;
      const timer = setTimeout(() => {
        clearTransfer(driveId);
        scheduled.delete(driveId);
      }, TRANSFER_AUTO_CLEAR_MS);
      scheduled.set(driveId, timer);
    }
    // Drop timers for drives that are no longer visible (manually cleared,
    // new session) or that have new peers connecting again.
    const liveCompletedIds = new Set(
      visibleTransfers.filter((t) => t.completed && t.peersConnected === 0).map((t) => t.driveId)
    );
    for (const [id, timer] of scheduled) {
      if (!liveCompletedIds.has(id)) {
        clearTimeout(timer);
        scheduled.delete(id);
      }
    }
  }, [visibleTransfers, clearTransfer]);
  useEffect(() => {
    // Flush pending timers on unmount.
    const scheduled = scheduledClearRef.current;
    return () => {
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    };
  }, []);

  async function onPickAndShare() {
    setBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: true,
      });
      const files = pickFiles(res);
      const paths = files.map((f) => f.uri);
      if (!paths.length && !res.canceled) {
        showToast("Nothing picked.");
        return;
      }
      if (res.canceled) {
        // Silent on cancel, apart from the one-time hint about returning
        // from pickers.
        maybeShowPickerBackHint();
        return;
      }

      const out = await sharePaths(paths);
      if (!out.ok || !out.shareLink) {
        // out.error is a structured {category, cause, message, detail?}
        // object; errorMessage extracts the display string. Dev mode shows the
        // raw engine message, production the friendly fallback.
        const rawMessage = errorMessage(out.error);
        showToast(
          devMode && rawMessage
            ? rawMessage
            : "Couldn't create that share — give it another go?",
          "error"
        );
        return;
      }

      const now = Date.now();
      const bundle: ShareBundle = {
        id: out.driveId || `bundle_${now}_${Math.random().toString(36).slice(2, 8)}`,
        files,
        shareLink: out.shareLink,
        driveId: out.driveId,
        dormant: false,
        createdAt: now,
      };
      setBundles((prev) => [bundle, ...prev.filter((b) => b.driveId !== out.driveId)]);
      // Best-effort persistence so the bundle survives restarts; failure here
      // doesn't block the share flow.
      if (out.driveId) {
        void persistBundle({
          driveId: out.driveId,
          shareLink: out.shareLink,
          files: files.map((f) => ({ name: f.name, size: f.size ?? 0 })),
          createdAt: now,
          lastActivityAt: now,
        });
      }
      haptics.success();
      showToast("Share ready — send the link.", "success");
    } catch (e: unknown) {
      haptics.error();
      const raw = String((e as Error)?.message || e);
      // Raw exception text reads developer-y; only surface it when dev mode
      // is on. Normal users get a friendly fallback that suggests recovery.
      showToast(
        devMode ? raw : "Something went sideways — give it another go?",
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  async function onPickFolder() {
    setFolderBusy(true);
    try {
      let dir;
      try {
        dir = await pickFolder();
      } catch (err) {
        throw new Error(`pick: ${String((err as Error)?.message || err)}`);
      }
      if (!dir) {
        maybeShowPickerBackHint();
        return;
      }

      let enumerated;
      try {
        enumerated = await enumerateFolder(dir, { maxFiles: 1000 });
      } catch (err) {
        if (err instanceof FolderTooLargeError) {
          showToast(`This folder has too many files to share (limit: ${err.limit}).`, "error");
          return;
        }
        throw new Error(`enumerate: ${String((err as Error)?.message || err)}`);
      }

      if (!enumerated.length) {
        showToast("That folder had nothing to share.");
        return;
      }

      const files: SelectedFile[] = enumerated.map((f) => ({
        name: f.name,
        size: f.size,
        uri: f.uri,
      }));
      const paths = enumerated.map((f) => f.uri);
      const relPaths = enumerated.map((f) => f.relPath);

      const out = await sharePaths(paths, relPaths);
      if (!out.ok || !out.shareLink) {
        const rawMessage = errorMessage(out.error);
        showToast(
          devMode && rawMessage
            ? rawMessage
            : "Couldn't share that folder — give it another go?",
          "error"
        );
        return;
      }

      const now = Date.now();
      const bundle: ShareBundle = {
        id: out.driveId || `bundle_${now}_${Math.random().toString(36).slice(2, 8)}`,
        files,
        shareLink: out.shareLink,
        driveId: out.driveId,
        dormant: false,
        createdAt: now,
      };
      setBundles((prev) => [bundle, ...prev.filter((b) => b.driveId !== out.driveId)]);
      if (out.driveId) {
        void persistBundle({
          driveId: out.driveId,
          shareLink: out.shareLink,
          files: files.map((f) => ({ name: f.name, size: f.size ?? 0 })),
          createdAt: now,
          lastActivityAt: now,
        });
      }
      haptics.success();
      showToast("Folder ready — send the link.", "success");
    } catch (e: unknown) {
      haptics.error();
      const raw = String((e as Error)?.message || e);
      // Surface raw folder errors while the feature is stabilizing — the
      // stage prefix (pick:/enumerate:) identifies where it failed.
      showToast(`Folder error: ${raw}`, "error");
    } finally {
      setFolderBusy(false);
    }
  }

  async function onPickPhotos() {
    setPhotoBusy(true);
    try {
      // expo-image-picker, not DocumentPicker: SAF treats most single-tap
      // photo selections as "pick and exit", which isn't what users expect
      // from multi-select. On Android 13+ this launches the permissionless
      // system PhotoPicker; older versions fall back to MediaStore, which
      // needs READ_EXTERNAL_STORAGE (capped to API 32 in AndroidManifest).
      //
      // launchImageLibraryAsync can throw outright on older Android (permission
      // denied, vendor-customized gallery missing, OEM ROM quirk), so the
      // try/catch falls back to DocumentPicker rather than dead-ending the
      // user.
      let files: SelectedFile[] = [];
      let userCanceled = false;
      try {
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsMultipleSelection: true,
          // Don't reformat / strip EXIF — we're sharing the file as-is.
          quality: 1,
          // Don't allow the in-picker cropping/editing UI; we share originals.
          allowsEditing: false,
          // Cap at the platform max; user can always invoke again.
          selectionLimit: 0,
          exif: false,
          base64: false,
        });
        if (res.canceled) {
          userCanceled = true;
        } else {
          const assets = res.assets ?? [];
          files = assets
            .filter((a) => !!a.uri)
            .map((a) => ({
              name:
                a.fileName ||
                (a.uri ? a.uri.split("/").pop() : null) ||
                `photo_${Date.now()}.jpg`,
              size: typeof a.fileSize === "number" ? a.fileSize : undefined,
              uri: a.uri,
            }));
        }
      } catch {
        // PhotoPicker / MediaStore path failed entirely. Fall through to
        // DocumentPicker as a robust fallback. The user gets the SAF picker
        // (worse multi-select UX) instead of an error dead-end.
        const fallback = await DocumentPicker.getDocumentAsync({
          type: "image/*",
          copyToCacheDirectory: true,
          multiple: true,
        });
        if (fallback.canceled) {
          userCanceled = true;
        } else {
          files = pickFiles(fallback);
        }
      }

      if (userCanceled) {
        // Silent on cancel, apart from the one-time picker-return hint.
        maybeShowPickerBackHint();
        return;
      }
      const paths = files.map((f) => f.uri);
      if (!paths.length) {
        showToast("No photos picked.");
        return;
      }
      const out = await sharePaths(paths);
      if (!out.ok || !out.shareLink) {
        const rawMessage = errorMessage(out.error);
        showToast(
          devMode && rawMessage
            ? rawMessage
            : "Couldn't create that share — give it another go?",
          "error"
        );
        return;
      }
      const now = Date.now();
      const bundle: ShareBundle = {
        id: out.driveId || `bundle_${now}_${Math.random().toString(36).slice(2, 8)}`,
        files,
        shareLink: out.shareLink,
        driveId: out.driveId,
        dormant: false,
        createdAt: now,
      };
      setBundles((prev) => [bundle, ...prev.filter((b) => b.driveId !== out.driveId)]);
      if (out.driveId) {
        void persistBundle({
          driveId: out.driveId,
          shareLink: out.shareLink,
          files: files.map((f) => ({ name: f.name, size: f.size ?? 0 })),
          createdAt: now,
          lastActivityAt: now,
        });
      }
      haptics.success();
      showToast("Photos ready — send the link.", "success");
    } catch (e: unknown) {
      haptics.error();
      const raw = String((e as Error)?.message || e);
      // Raw exception text reads developer-y; only surface it when dev mode
      // is on. Normal users get a friendly fallback that suggests recovery.
      showToast(
        devMode ? raw : "Something went sideways — give it another go?",
        "error"
      );
    } finally {
      setPhotoBusy(false);
    }
  }

  async function onCopyLink(link: string) {
    await Clipboard.setStringAsync(link);
    haptics.actionDone();
    showToast("Link copied.", "success");
  }

  function onClearBundle(id: string) {
    // Find the bundle so we can stop and purge the corresponding drive
    // AND remove from persistence. Without the cancelTransfer the drive
    // keeps running and announcing in the swarm even after the card
    // disappears. Used by both the "Stop sharing" / "Clear" header button
    // and the swipe-delete affordance.
    //
    // "live" derives from activeDriveIds, not the load-time `dormant` flag —
    // the engine may have rehydrated the bundle since. cancelTransfer(purge)
    // is called whenever there's a driveId: engineStopDrive no-ops on unknown
    // ids, so it's safe for never-hydrated drives, and it doubles as the
    // manifest cleanup that stops the entry rehydrating on the next boot.
    const bundle = bundles.find((b) => b.id === id);
    const driveId = bundle?.driveId;
    const wasLive = !!driveId && activeDriveIds.has(driveId);
    setBundles((prev) => prev.filter((b) => b.id !== id));
    if (driveId) {
      void cancelTransfer(driveId, { purge: true });
      clearTransfer(driveId);
      void persistRemoveBundle(driveId);
    }
    haptics.actionDone();
    showToast(wasLive ? "Stopped sharing." : "Removed.");
  }

  function toggleExpand(driveId: string) {
    setExpandedDriveIds((prev) => ({ ...prev, [driveId]: !prev[driveId] }));
  }

  function renderTransferCard(
    t: TransferSummary,
    options?: { paired?: boolean },
  ) {
    const expanded = !!expandedDriveIds[t.driveId];
    const paired = !!options?.paired;
    return (
      <View
        key={t.driveId}
        style={paired ? styles.pairedTransferWrap : styles.transferCardWrap}
      >
        <TransferCard
          transfer={t}
          expanded={expanded}
          onToggleExpanded={() => toggleExpand(t.driveId)}
          onCancel={() => void cancelTransfer(t.driveId)}
          onClear={() => clearTransfer(t.driveId)}
        />
      </View>
    );
  }

  // Split visibleTransfers into those pairing with a known bundle and orphans
  // (a transfer that landed before its bundle hydrated, or one whose bundle
  // the user cleared). Paired ones render inline beneath each bundle; orphans
  // get a small footer so they aren't invisible.
  const bundleDriveIds = useMemo(
    () => new Set(bundles.map((b) => b.driveId).filter(Boolean)),
    [bundles],
  );
  const orphanTransfers = useMemo(
    () => visibleTransfers.filter((t) => !bundleDriveIds.has(t.driveId)),
    [visibleTransfers, bundleDriveIds],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + theme.pad }]}>
      <View style={styles.mainShell}>
        <ScrollView
          contentContainerStyle={[styles.scrollInner, { paddingBottom: dockBottom + theme.pad }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>Shares</Text>
          </View>
          <Text style={styles.sub}>Send, track, receive — one home for it all.</Text>

          {/*
           * Backend lifecycle status is engineering vocabulary, so it's gated
           * behind dev mode. The `ready` boolean still drives the SEND buttons'
           * disabled state, so boot state is respected without leaking the
           * strings.
           */}
          {devMode && (
            <Text style={styles.statusLine}>
              {ready ? "●" : "○"} {status}
            </Text>
          )}

          <View style={styles.topSection}>
            <Text style={styles.sectionLabel}>SEND</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.topActionsContent}
            >
              <Pressable
                style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
                onPress={() => setPickerSheetOpen(true)}
                disabled={!ready || busy || folderBusy}
                accessibilityRole="button"
                accessibilityLabel="Pick files or a folder to share"
                accessibilityHint="Opens a chooser for picking files or an entire folder"
                accessibilityState={{ disabled: !ready || busy || folderBusy, busy: busy || folderBusy }}
              >
                <View style={styles.actionIconWrap}>
                  {busy || folderBusy ? (
                    <ActivityIndicator color={theme.primary} />
                  ) : (
                    <Ionicons name="document-attach-outline" size={26} color={theme.primary} />
                  )}
                </View>
                <Text style={styles.actionTitle}>Pick files</Text>
                <Text style={styles.actionHint}>Files or a whole folder</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
                onPress={onPickPhotos}
                disabled={!ready || photoBusy}
                accessibilityRole="button"
                accessibilityLabel="Pick photos to share"
                accessibilityHint="Opens the photo picker so you can choose what to send"
                accessibilityState={{ disabled: !ready || photoBusy, busy: photoBusy }}
              >
                <View style={styles.actionIconWrap}>
                  {photoBusy ? (
                    <ActivityIndicator color={theme.primary} />
                  ) : (
                    <Ionicons name="images-outline" size={26} color={theme.primary} />
                  )}
                </View>
                <Text style={styles.actionTitle}>Pick photos</Text>
                <Text style={styles.actionHint}>Straight from your gallery</Text>
              </Pressable>
            </ScrollView>
          </View>

          <View style={styles.middleSection}>
            {bundles.length > 0 && (
              <Text style={styles.sectionLabel}>YOUR SHARES</Text>
            )}

            {bundles.map((bundle, bundleIdx) => {
              const totalBytes = bundle.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
              // Live = engine has this drive in activeDrives (fresh share OR
              // rehydrated). Failed = engine tried + couldn't rebuild it.
              // Dormant = persisted but not yet (re)live this session.
              const isLive =
                !!bundle.driveId && activeDriveIds.has(bundle.driveId);
              const isFailed =
                !!bundle.driveId && failedHydrationIds.has(bundle.driveId);
              const isDormant = !!bundle.driveId && !isLive && !isFailed;
              // Single file → name, truncated in the middle. Multiple → first
              // name plus "+ N more". Falls back to "shared files" for legacy
              // bundles carrying no file metadata.
              const FILENAME_BUDGET = 28;
              const firstFileName = bundle.files[0]?.name?.trim() || "";
              const filenameSummary =
                bundle.files.length === 0 || !firstFileName
                  ? "shared files"
                  : bundle.files.length === 1
                    ? truncateMiddle(firstFileName, FILENAME_BUDGET)
                    : `${truncateMiddle(firstFileName, FILENAME_BUDGET - 8)} + ${
                        bundle.files.length - 1
                      } more`;
              const filesLabel =
                bundle.files.length === 1
                  ? "1 file"
                  : `${bundle.files.length} files`;
              // Peer-connected indicator state for this bundle.
              const bundleTransfer = bundle.driveId
                ? transferByDriveId.get(bundle.driveId)
                : undefined;
              const peerCount = bundleTransfer?.peersConnected ?? 0;
              const peerHasConnection = peerCount > 0;
              const peerIds = bundleTransfer?.peerIds ?? [];
              const a11yLabel = `${filesLabel}, ${formatBytes(totalBytes)}${
                isFailed
                  ? ", couldn't restore"
                  : isDormant
                    ? ", inactive"
                    : ""
              }${
                peerHasConnection
                  ? `, ${peerCount === 1 ? "one pear connected" : `${peerCount} pears connected`}`
                  : ""
              }`;
              // If this bundle has an active transfer, its card flattens the
              // bottom edge and the transfer renders flush beneath it.
              const pairedTransfer = bundleTransfer && visibleTransfers.includes(bundleTransfer)
                ? bundleTransfer
                : undefined;
              return (
                <View key={bundle.id} style={styles.bundlePairWrap}>
                <SwipeableRow
                  onDelete={() => onClearBundle(bundle.id)}
                  deleteLabel={isLive ? "Stop" : "Delete"}
                  accessibilityLabel={a11yLabel}
                  frontBackground={theme.bg}
                  // The outer bundlePairWrap owns the inter-pair spacing
                  // now; the SwipeableRow no longer needs its own
                  // bottom margin. Border-radius depends on whether a
                  // transfer card is paired below — flatten bottom
                  // corners in the paired case.
                  containerStyle={
                    pairedTransfer ? styles.bundleSwipeWrapPaired : styles.bundleSwipeWrap
                  }
                  peek={bundleIdx === 0 && peekTopmost}
                  onPeekDone={onPeekDone}
                >
                  <Pressable
                    onPress={() => setQrBundleId(bundle.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open share options for ${a11yLabel}`}
                    accessibilityHint="Opens the QR code and share actions"
                    style={({ pressed }) => [
                      styles.bundleCard,
                      (isDormant || isFailed) && styles.bundleCardDormant,
                      pressed && styles.bundleCardPressed,
                      pairedTransfer && styles.bundleCardPaired,
                    ]}
                  >
                    <View style={styles.bundleRow}>
                      <View style={styles.bundleIdentity}>
                        <Text style={styles.bundleTitle}>
                          {filesLabel}
                          <Text style={styles.bundleTitleMuted}>
                            {`  ·  ${formatBytes(totalBytes)}`}
                          </Text>
                        </Text>
                        <View style={styles.bundleSubRow}>
                          {isFailed ? (
                            <Ionicons
                              name="alert-circle-outline"
                              size={13}
                              color={theme.danger}
                              style={styles.bundleStateIcon}
                            />
                          ) : null}
                          {peerHasConnection ? (
                            <>
                              <Animated.View
                                style={[styles.peerDot, { opacity: peerPulse }]}
                                accessibilityElementsHidden
                                importantForAccessibility="no"
                              />
                              {devMode ? (
                                <Text
                                  style={styles.peerDotText}
                                  numberOfLines={1}
                                >
                                  {peerCount === 1
                                    ? peerIds[0]
                                      ? `peer …${peerIds[0].slice(-5)}`
                                      : "1 peer"
                                    : `${peerCount} peers`}
                                </Text>
                              ) : null}
                            </>
                          ) : null}
                          <Text
                            style={styles.bundleVerify}
                            numberOfLines={1}
                            ellipsizeMode="tail"
                          >
                            {filenameSummary}
                          </Text>
                        </View>
                      </View>
                      <View
                        style={styles.qrBtn}
                        accessibilityElementsHidden
                        importantForAccessibility="no"
                      >
                        <Ionicons
                          name="qr-code-outline"
                          size={24}
                          color={theme.text}
                        />
                      </View>
                    </View>
                  </Pressable>
                </SwipeableRow>
                {pairedTransfer
                  ? renderTransferCard(pairedTransfer, { paired: true })
                  : null}
                </View>
              );
            })}

            {/* Transfers with no matching bundle on screen — a transient
             * hydration race, or a bundle cleared mid-flight. Rendered
             * separately so they aren't invisible. */}
            {orphanTransfers.length > 0 && (
              <View style={{ marginTop: bundles.length ? 6 : 0 }}>
                <Text style={[styles.sectionLabel, { marginTop: 8 }]}>SENDING NOW</Text>
                {orphanTransfers.map((t) => renderTransferCard(t))}
              </View>
            )}

            {/* No empty state: the picker buttons at the top already say where
             * shares come from. The page is intentionally sparse. */}

          </View>
        </ScrollView>
      </View>
      {(() => {
        const qrBundle = qrBundleId
          ? bundles.find((b) => b.id === qrBundleId)
          : null;
        const link = qrBundle?.shareLink ?? "";
        const driveId = qrBundle?.driveId;
        const isLive = !!driveId && activeDriveIds.has(driveId);
        const isFailed = !!driveId && failedHydrationIds.has(driveId);
        const qrStatus: "live" | "dormant" | "failed" = isFailed
          ? "failed"
          : isLive
            ? "live"
            : "dormant";
        const qrTransfer = driveId ? transferByDriveId.get(driveId) : undefined;
        const qrPeerCount = qrTransfer?.peersConnected ?? 0;
        const qrTotalBytes = qrBundle
          ? qrBundle.files.reduce((sum, f) => sum + (f.size ?? 0), 0)
          : 0;
        return (
          <ShareQrModal
            visible={!!qrBundle}
            link={link}
            isActive={isLive}
            info={
              qrBundle
                ? {
                    status: qrStatus,
                    createdAt: qrBundle.createdAt,
                    files: qrBundle.files.map((f) => ({
                      name: f.name,
                      size: f.size,
                    })),
                    totalBytes: qrTotalBytes,
                    peerCount: qrPeerCount,
                  }
                : undefined
            }
            onClose={() => setQrBundleId(null)}
            onCopy={
              isLive && link ? () => { void onCopyLink(link); } : undefined
            }
            onRemove={
              qrBundle && !isLive
                ? () => {
                    const id = qrBundle.id;
                    setQrBundleId(null);
                    onClearBundle(id);
                  }
                : undefined
            }
          />
        );
      })()}
      <Modal
        visible={pickerSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerSheetOpen(false)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setPickerSheetOpen(false)}
          accessibilityLabel="Close picker chooser"
        >
          <View
            style={[styles.menuSheet, { paddingBottom: insets.bottom + 8 }]}
            onStartShouldSetResponder={() => true}
          >
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setPickerSheetOpen(false);
                void onPickAndShare();
              }}
              accessibilityRole="button"
              accessibilityLabel="Pick individual files"
            >
              <Ionicons name="document-attach-outline" size={22} color={theme.text} />
              <View style={styles.menuRowBody}>
                <Text style={styles.menuRowText}>Files</Text>
                <Text style={styles.menuRowHint}>One or more files from your device</Text>
              </View>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setPickerSheetOpen(false);
                void onPickFolder();
              }}
              accessibilityRole="button"
              accessibilityLabel="Pick an entire folder"
            >
              <Ionicons name="folder-outline" size={22} color={theme.text} />
              <View style={styles.menuRowBody}>
                <Text style={styles.menuRowText}>Folder</Text>
                <Text style={styles.menuRowHint}>Every file inside, structure kept</Text>
              </View>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
