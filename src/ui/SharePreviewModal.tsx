import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAppTheme } from "../state/ThemeContext";
import { useShareLinkFlow } from "../state/ShareLinkFlowContext";
import type { AppTheme } from "./themes";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatBytes } from "../lib/format";
import { baseName } from "../lib/files";
import FileTypeIcon from "./FileTypeIcon";
// Nine modules this picker once imported are gone, among them `pickerStatus`, `pickerGrabGate` and `PearSonarLite`: each was a surface that could contradict another, and the model answers for the row as well, so the two cannot drift.
import {
  DRAFT_HINT,
  draftButton,
  draftDiff,
  isMarkedToStop,
  type DraftInput,
} from "../lib/pickerDraft";
import { previewSubtitle } from "../lib/sharePreviewCopy";
import { haptics } from "../lib/haptics";
import { ToastOutlet, useToast } from "./Toast";
import { openSavedFile } from "../lib/openSavedFile";
import { previewModeFor } from "../lib/files";
import { useVideoThumbnail } from "../lib/videoThumbnail";

/** A saved file's own frame, or its type icon, from the same two pieces the folder sheet uses so both show the same tile for the same file. */
// Its own component because the frame hook cannot run inside the file rows' map.
function SavedFileThumb({
  name,
  localPath,
  theme,
  styles,
}: {
  name: string;
  localPath: string | null;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const uri = localPath
    ? localPath.startsWith("file://")
      ? localPath
      : `file://${localPath}`
    : null;
  const mode = previewModeFor(name);
  const imageUri = mode === "image" ? uri : null;
  const videoThumb = useVideoThumbnail(mode === "video" ? uri : null);
  const thumbUri = imageUri ?? videoThumb;
  if (thumbUri) {
    return (
      <Image source={{ uri: thumbUri }} style={styles.thumbImage} resizeMode="cover" />
    );
  }
  return <FileTypeIcon name={name} size={28} color={theme.text} />;
}

function createStyles(theme: AppTheme, bottomInset: number) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // A dialog window OCCLUDES an activity-window toast, it does not dim it,
      // so dropping the wash never made one tappable. Restored at the house
      // 0.5; T1 is what actually fixes the toast.
      backgroundColor: theme.scrim,
      justifyContent: "flex-end",
      padding: 16,
    },
    sheet: {
      maxHeight: "88%",
      borderRadius: 20,
      borderWidth: 1,
      borderColor: theme.border,
      // theme.bg is the only AppTheme color guaranteed to be fully opaque
      // across every theme (paper / cream / void / etc. all use solid hex).
      // theme.card is the tint meant to overlay theme.bg, but the modal's
      // direct child rendering layered tint over the scrim instead of bg —
      // which destroyed opacity. Solid theme.bg is the simplest fix.
      backgroundColor: theme.bg,
      padding: 16,
      // The only bottom-anchored surface in the tree that ignored this. The
      // primary button's edge sat 16 dp off the physical bottom, inside the
      // Android gesture inset. Same recipe as BottomSheet.tsx.
      paddingBottom: bottomInset + 16,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 10,
      elevation: 4,
    },
    // House header, copied from ShareQrModal.tsx:622-645: spacer + centred
    // truncating title + closeCircle. Replaces a lone text "Close" row, which
    // was the only text close among nine sheets and ~20x30 dp of target.
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginBottom: 8,
    },
    // Mirrors the close circle so the title stays optically centred.
    titleSlot: { width: 28, height: 28 },
    title: {
      flex: 1,
      textAlign: "center",
      color: theme.text,
      fontWeight: "700",
      fontSize: 18,
    },
    closeCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.tabBadgeBg,
    },
    meta: {
      color: theme.muted,
      fontSize: 13,
      textAlign: "center",
      marginBottom: 12,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 8,
    },
    hintText: { color: theme.muted, fontSize: 13, flexShrink: 1 },
    selectAll: { color: theme.primary, fontWeight: "600", fontSize: 13 },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    fileRowFirst: { borderTopWidth: 0 },
    // Dim already-downloaded rows so the new files draw the eye.
    fileRowAlreadyHave: { opacity: 0.7 },
    gotItBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.primaryMuted,
      backgroundColor: theme.surfaceSubtle,
    },
    gotItBadgeText: {
      color: theme.primary,
      fontSize: 11,
      fontWeight: "700",
    },
    // Same footprint as the checkbox it replaces, so a file reaching saved shifts nothing beside it.
    // The sender dot replaces the sonar and the Look again card, which animated about a wait the app cannot observe ending.
    senderDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    // The after-grab hint, under the one status line.
    hintLine: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 4,
      marginBottom: 2,
    },
    // Same footprint as the checkbox it stands in for; filled once marked, so "will stop on confirm" is visible at a glance.
    cancelMarkActive: {
      backgroundColor: theme.danger,
      borderColor: theme.danger,
    },
    // A file marked to stop. Struck through, because Confirm is what performs
    // it and the user has to be able to see what they are about to agree to.
    fileNameStruck: {
      textDecorationLine: "line-through",
    },
    cancelMark: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 11,
      borderWidth: 1,
      borderColor: theme.danger,
    },
    savedMark: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    // The in-progress file's thin bar, inside the file's own meta column.
    fileBarTrack: {
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.border,
      marginTop: 6,
      overflow: "hidden",
    },
    fileBarFill: {
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.primary,
    },
    filePct: {
      color: theme.muted,
      fontSize: 11,
      fontWeight: "700",
      marginLeft: 8,
    },
    // Neutral, deliberately: a per-file problem is a fact about one file, not
    // an error the share is in. `theme.muted`, never `theme.danger`.
    fileNote: {
      color: theme.muted,
      fontSize: 11,
      marginTop: 4,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
    },
    checkboxChecked: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    // A 28-wide centring View, so the row gap stays at 10 now that the glyph
    // is an Ionicon rather than an emoji in a Text.
    iconSlot: { width: 28, alignItems: "center", justifyContent: "center" },
    /** Fills the icon slot exactly, so a thumbnail never reflows the row. */
    thumbImage: { width: 28, height: 28, borderRadius: 4 },
    fileMain: { flex: 1, minWidth: 0 },
    fileName: { color: theme.text, fontSize: 14, fontWeight: "500" },
    fileMeta: { color: theme.muted, fontSize: 12, marginTop: 2 },
    actions: { flexDirection: "row", gap: 10, marginTop: 16 },
    primaryBtn: {
      flex: 1,
      backgroundColor: theme.primary,
      paddingVertical: 14,
      borderRadius: 14,
      alignItems: "center",
    },
    primaryText: { color: theme.onPrimary, fontWeight: "700", fontSize: 15 },
    disabled: { opacity: 0.55 },
    // The one status line. The sonar mounts inside it while looking, so the
    // row has no fixed height and must not clip.
    lookupRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 12,
    },
    lookupText: {
      flex: 1,
      color: theme.muted,
      fontSize: 12,
      lineHeight: 16,
    },
    // Muted with an info icon: a resolve still waiting on the sender has not failed, so it must not render as one.
    waitBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
    },
    waitBannerText: {
      flex: 1,
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
    },
    // flexShrink matters: the sheet caps at 88% of the screen while this caps
    // at 360 dp, and RN's default flexShrink of 0 meant that on a short
    // viewport or at a large font scale the list refused to give way and
    // pushed the only button past the sheet's bottom edge.
    list: { maxHeight: 360, flexShrink: 1 },
  });
}

export default function SharePreviewModal() {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => createStyles(theme, insets.bottom),
    [theme, insets.bottom],
  );
  /** One source: the view carries every string, tick, percentage, control and button this modal draws. */
  // A local selection set made checkbox and label disagree; a share-wide percentage made header and file disagree.
  const {
    previewVisible,
    closePreview,
    openResult,
    linkError,
    downloadAllBusy,
    downloadSelectedFromPreview,
    pickerView,
    pickerHydrating,
    confirmSelection,
  } = useShareLinkFlow();
  const { show: showToast } = useToast();

  const view = pickerView;
  // Its own memo for a stable dependency: a bare `?? []` allocates each render and re-seeds the draft on every progress event.
  const files = useMemo(() => view?.files ?? [], [view?.files]);

  /** The draft: ticks, unticks and the x change nothing until confirm, and the corner close throws it away. */
  // Null means not opened or just discarded; the draft is seeded from the model on open rather than kept across opens.
  const [ticked, setTicked] = useState<string[] | null>(null);
  const [willStop, setWillStop] = useState<string[]>([]);

  /** What the record has saved, straight off the model. */
  const saved = useMemo(
    () =>
      files
        .filter((f) => f.state === "selected" || f.state === "inProgress")
        .map((f) => f.name),
    [files],
  );

  // Seeded on open and on discard only: re-seeding mid-edit would wipe the draft whenever a progress event landed.
  useEffect(() => {
    if (!previewVisible) {
      setTicked(null);
      setWillStop([]);
    }
  }, [previewVisible]);
  /** Seeded once the real record is in hand, never off the synthesised stand-in. */
  // The stand-in says nothing is chosen, and the draft is one-shot, so seeding against it left an already-queued row with empty boxes that the real selection could never re-seed.
  useEffect(() => {
    if (previewVisible && !pickerHydrating && ticked === null && files.length > 0) {
      setTicked(saved);
    }
  }, [previewVisible, pickerHydrating, ticked, files.length, saved]);

  const draft: DraftInput = useMemo(
    () => ({
      status: view?.status ?? "ready",
      saved,
      ticked: ticked ?? saved,
      willStop,
      // The sizes, not a pre-made label: the model's label is computed from the saved selection, which is empty before a first grab while the draft is not.
      files: files.map((f) => ({ name: f.name, size: f.size })),
      // Straight off the model: a share holding any saved file is past its
      // first grab, whatever the status says. See `DraftInput.hasGrabbed`.
      hasGrabbed: files.some((f) => f.state === "done"),
      // What is actually on disk, so `Looks good` can never appear over a file
      // that is still outstanding. See `DraftInput.held`.
      held: files.filter((f) => f.state === "done").map((f) => f.name),
    }),
    [view?.status, files, saved, ticked, willStop],
  );
  const button = draftButton(draft);

  /** Clause 6: open a saved file, through the one shared open path. */
  async function onOpenSavedFile(path: string) {
    await openSavedFile(path, (msg) => showToast(msg, { kind: "error" }));
  }

  /** A tick. Draft only — nothing is written and no engine call is made. */
  function onToggle(key: string) {
    setTicked((prev) => {
      const base = prev ?? saved;
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    });
  }

  /** The x on the in-progress file marks a stop; it does not perform one. */
  // The file stays listed, ticked and struck through with the x active, so the user can see what confirming will do and still change their mind.
  function onMarkStop(key: string) {
    setWillStop((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  /** The corner X discards the draft. `closePreview` clears it via the effect
   *  above, so this only has to close. */
  function onDiscard() {
    setTicked(null);
    setWillStop([]);
    closePreview();
  }

  function onPressButton() {
    if (!button.enabled) return;
    if (button.kind === "grab") {
      void downloadSelectedFromPreview(ticked ?? saved);
      return;
    }
    if (button.kind === "confirm" || button.kind === "resume") {
      void confirmSelection(draftDiff(draft));
    }
    onDiscard();
  }

  /** The success pulse, on the model's own sender signal rather than on a removed status module. */
  const prevOnlineRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!previewVisible) {
      prevOnlineRef.current = null;
      return;
    }
    const prev = prevOnlineRef.current;
    prevOnlineRef.current = view?.senderOnline ?? false;
    if (prev === null) return;
    if (!prev && view?.senderOnline) haptics.success();
  }, [previewVisible, view?.senderOnline]);

  /** Grab, for the first grab only. The selection is already on the record, so this passes the model's ticked list rather than a local set. */

  return (
    <Modal visible={previewVisible} transparent animationType="fade" onRequestClose={closePreview}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDiscard} />
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <View style={styles.titleSlot} />
            {/* Middle ellipsis keeps the extension visible, which a tail cut
                does not: "Q3-report-fin….pdf" beats "Q3-report-fina…". */}
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
              {openResult?.shareName || "Share"}
            </Text>
            {/* Discards the draft, by instruction. `closePreview` alone would
                leave the ticks in state for the next open. */}
            <Pressable
              onPress={onDiscard}
              style={styles.closeCircle}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close without changing anything"
            >
              <Ionicons name="close" size={16} color={theme.muted} />
            </Pressable>
          </View>
          <Text style={styles.meta}>
            {previewSubtitle(files.length, openResult?.totalBytes)}
          </Text>
          {/* One status line and no second surface: the message says what is happening and the dot says whether the sender is reachable. */}
          <View style={styles.lookupRow} accessibilityLiveRegion="polite">
            <View
              style={[
                styles.senderDot,
                {
                  backgroundColor: view?.senderOnline
                    ? theme.primary
                    : theme.muted,
                },
              ]}
              accessibilityLabel={view?.senderOnline ? "Sender online" : "Sender offline"}
            />
            <Text
              style={[
                styles.lookupText,
                view?.senderOnline === true && { color: theme.primaryMuted },
              ]}
            >
              {view?.header ?? ""}
            </Text>
          </View>
          {/* The after-grab hint: one line, and the only second line the header is allowed. */}
          {!!view?.hint && (
            <Text style={styles.hintLine}>
              {view.status === "ready" ? view.hint : DRAFT_HINT}
            </Text>
          )}
          {/* The partial-dedup acknowledgement, and only before a grab, because afterwards the per-file marks already say what is held. */}
          {view?.status === "ready" &&
            !!linkError &&
            linkError.trigger === "already-held" && (
              <View style={styles.waitBanner}>
                <Ionicons
                  name="information-circle-outline"
                  size={16}
                  color={theme.muted}
                />
                <Text style={styles.waitBannerText}>{linkError.text}</Text>
              </View>
            )}
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {files.map((f, index) => {
              const name = baseName(f.name);
              // A saved file with a path joins the tappable set — opening it is
              // clause 6, and `doneMark` stays a mark rather than a control.
              const tappable =
                f.control === "checkbox" ||
                f.control === "cancel" ||
                (f.state === "done" && !!f.localPath);
              // The draft decides the tick and the strike-through; the record's saved state is only the seed.
              const isTicked = (ticked ?? saved).includes(f.name);
              const marked = isMarkedToStop(draft, f.name);
              return (
                <Pressable
                  key={`${f.name}_${index}`}
                  style={[
                    styles.fileRow,
                    index === 0 && styles.fileRowFirst,
                    f.state === "done" && styles.fileRowAlreadyHave,
                    f.state === "gone" && styles.fileRowAlreadyHave,
                  ]}
                  onPress={() => {
                    if (f.control === "cancel") onMarkStop(f.name);
                    else if (f.control === "checkbox") onToggle(f.name);
                    // A saved file opens from the picker: the tick beside it is not tappable, so the row press means this.
                    else if (f.state === "done" && f.localPath) {
                      void onOpenSavedFile(f.localPath);
                    }
                  }}
                  disabled={!tappable}
                  accessibilityRole={f.control === "cancel" ? "button" : "checkbox"}
                  accessibilityState={
                    f.control === "cancel"
                      ? { selected: marked }
                      : { checked: isTicked, disabled: !tappable }
                  }
                  accessibilityLabel={
                    f.control === "cancel"
                      ? marked
                        ? `${name}, will stop on confirm`
                        : `Stop this file`
                      : f.state === "done"
                        ? `${name}, saved`
                        : f.state === "gone"
                          ? `${name}, no longer shared`
                          : `Pick ${name}`
                  }
                >
                  {/* The control column, straight off the model. No surface
                      decides this any more. */}
                  {f.control === "doneMark" ? (
                    <View style={styles.savedMark}>
                      <Ionicons name="checkmark" size={16} color={theme.primary} />
                    </View>
                  ) : f.control === "cancel" ? (
                    /* The red x marks a stop and confirming performs it; the cancel leaves the store alone, so the blocks stay and re-ticking resumes from them. */
                    <View style={[styles.cancelMark, marked && styles.cancelMarkActive]}>
                      <Ionicons
                        name="close"
                        size={16}
                        color={marked ? theme.onPrimary : theme.danger}
                      />
                    </View>
                  ) : f.control === "checkbox" ? (
                    <View style={[styles.checkbox, isTicked && styles.checkboxChecked]}>
                      {isTicked ? (
                        <Ionicons name="checkmark" size={14} color={theme.onPrimary} />
                      ) : null}
                    </View>
                  ) : (
                    <View style={styles.savedMark} />
                  )}
                  {/* A saved image or video shows its own frame, and the path comes through the model with the file so the thumbnail and the open action cannot point at different files. */}
                  <View style={styles.iconSlot}>
                    <SavedFileThumb
                      name={f.name}
                      localPath={f.state === "done" ? f.localPath : null}
                      theme={theme}
                      styles={styles}
                    />
                  </View>
                  <View style={styles.fileMain}>
                    <Text
                      style={[styles.fileName, marked && styles.fileNameStruck]}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {name}
                    </Text>
                    <Text style={styles.fileMeta}>{formatBytes(f.size)}</Text>
                    {/* The in-progress file's own bar, at the model's
                        percentage - the same number as the header. */}
                    {f.state === "inProgress" && (
                      <View style={styles.fileBarTrack}>
                        <View
                          style={[styles.fileBarFill, { width: `${f.pct ?? 0}%` }]}
                        />
                      </View>
                    )}
                  </View>
                  {f.state === "inProgress" && (
                    <Text style={styles.filePct}>{f.pct ?? 0}%</Text>
                  )}
                  {f.state === "done" && (
                    <View style={styles.gotItBadge}>
                      <Ionicons name="checkmark" size={12} color={theme.primary} />
                      <Text style={styles.gotItBadgeText}>Saved</Text>
                    </View>
                  )}
                  {f.state === "gone" && (
                    <Text style={styles.fileNote}>No longer shared</Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
          {/* The button is present in every state: a first grab, then a confirm, and a resume for a row the user stopped. */}
          {!!view && (
            <View style={styles.actions}>
              {/* The busy flag suppresses the first grab only: gating every kind made the button a spinner for the whole of a download, so a marked stop could not be committed and the control was decorative.
                  Changing a selection mid-download is the ordinary case, not a conflicting one; only starting a fresh download while one is already starting is the genuine double-tap. */}
              {(() => {
                const busy = downloadAllBusy && button.kind === "grab";
                return (
                  <Pressable
                    style={[
                      styles.primaryBtn,
                      (!button.enabled || busy) && styles.disabled,
                    ]}
                    onPress={onPressButton}
                    disabled={!button.enabled || busy}
                    accessibilityRole="button"
                    accessibilityLabel={button.label}
                  >
                    {busy ? (
                      <ActivityIndicator color={theme.onPrimary} />
                    ) : (
                      <Text style={styles.primaryText}>{button.label}</Text>
                    )}
                  </Pressable>
                );
              })()}
            </View>
          )}
        </View>
      </View>
      {/* last child on purpose: this Modal is its own Android window,
          and a root-level toast would be painted under it (and untappable).
          While this sheet is open its outlet is the last registered, so it
          owns the toast; it unregisters on close and the root takes over.
          See src/lib/toastOutletSelect.ts. */}
      {previewVisible && <ToastOutlet />}
    </Modal>
  );
}
