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
// Nine modules this picker used to import are gone, and the list is the
// sprint's audit: `pickerStatus` and `pickerGrabGate` (the `Look again` card,
// the staged searching copy and a Grab button in every state), `pickerModel`
// and `rowCopy`'s picker half (superseded by `shareView`, which answers for
// the row as well so the two cannot drift), `ConfirmModal` (the stop confirm
// is gone - the blocks survive a stop), `previewHint`/`previewPrimaryLabel`
// (the button's label is the model's), `indicatorColor`/`RESOLVE_LOOKING_LABEL`
// and `PearSonarLite` (no animation in the picker; the Receive sheet keeps its
// pear). Each was a surface that could contradict another.
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

/**
 * A saved file's own frame, or its type icon.
 *
 * The same two pieces the folder sheet already uses — `previewModeFor` to
 * decide what the name is, and `useVideoThumbnail` to pull one frame out of a
 * video — so the picker and the sheet show the same tile for the same file.
 * The sheet had thumbnails and the picker did not, which is the whole of the
 * owner's clause-6 complaint.
 *
 * Its own component because `useVideoThumbnail` is a hook and the file rows
 * are a `.map`.
 */
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
    // A saved file's mark. Same footprint as the checkbox it replaces, so a
    // file reaching `saved` mid-list shifts nothing beside it.
    // The sender dot: the picker's whole answer to "is the sender there".
    // Replaces the sonar and the `Look again` card, both of which animated
    // about a wait the app cannot actually observe the end of.
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
    // The red x. Same footprint as the checkbox it stands in for, so a file
    // reaching `inProgress` shifts nothing beside it.
    // The x once the user has marked this file to stop: filled rather than
    // outlined, so "will stop on confirm" is visible at a glance.
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
    // the "wait"-tone notice banner. Muted, with an info
    // icon — a resolve still waiting on the sender has not failed, so it must
    // not render as a failure.
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
  /**
   * ONE source. `pickerView` carries every string, tick, percentage, control
   * and button this modal draws.
   *
   * What is deliberately NOT read here any more, and why each one was a bug:
   *
   *  - **`useState<Set<string>>` selection.** The owner ticked a file, saw no
   *    tick, and read `Grab 1 (9.2 MB)` on the button - because the checkbox
   *    rendered local state and the label rendered the record. The selection
   *    lives on the record now and ticking dispatches to the reducer.
   *  - **`transfers` / `transfer.percent`.** Share-wide, so the header said
   *    21% while the only file said 0%. Both come off `shareView` now, from one
   *    byte arithmetic.
   *  - **`pickerStatus` and `pickerGrabGate`.** They produced the
   *    `No sender found yet - tap Look again` card, the searching animation and
   *    a Grab button in every state. The picker shows a short message and
   *    whether the sender is online; the Receive sheet keeps its pear.
   *  - **`grabFailed`.** There is no red error after a grab, so nothing reads it.
   */
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
  // Its own memo, so the `saved` memo below has a stable dependency. A bare
  // `?? []` allocates a new array every render, which would re-seed the draft
  // on every progress event - the 1e defect in a new place.
  const files = useMemo(() => view?.files ?? [], [view?.files]);

  /**
   * THE draft. Part D: ticks, unticks and the x change nothing until the button
   * under the list is tapped, and the corner X throws the draft away.
   *
   * `null` means "not opened yet, or just discarded" - the draft is seeded from
   * the model on open rather than kept across opens, so a picker reopened after
   * an outside change shows what is actually saved.
   *
   * This is a picker-local selection, which 1f deleted on purpose. It does not
   * reintroduce that defect: back then the checkbox read local state while the
   * button label read the record, and the two disagreed. Everything here -
   * checkbox, label, strike-through - reads the draft, and the draft is seeded
   * from `shareView`. One source, held one layer closer to the user.
   */
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

  // Seeded on open and on a discard, never on every render: re-seeding while
  // the user is mid-edit would wipe their draft whenever a progress event
  // landed, which is the 1e defect in a new place.
  useEffect(() => {
    if (!previewVisible) {
      setTicked(null);
      setWillStop([]);
    }
  }, [previewVisible]);
  /**
   * Seeded once the REAL record is in hand, never off the synthesised one.
   *
   * `pickerHydrating` is true between opening the picker and `loadShare`
   * landing, and during those frames `pickerRecord` is a synthesised
   * `status: "ready", selection: undefined` stand-in. Seeding against it gave
   * the owner's queued three-file row six empty checkboxes and a `Grab N`
   * button where `Looks good` belonged (device run, step 3) — the draft is
   * one-shot, so the real selection arriving a tick later never re-seeded it.
   */
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
      // The SIZES, not a pre-made label. `view.button.label` is computed from
      // the record's saved selection, and in `ready` that is empty while the
      // draft is not - which is `Grab 0 (0 B)` beside a ticked box.
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

  /**
   * The x on the in-progress file. It MARKS a stop; it does not perform one.
   *
   * The file stays in the list, stays ticked and is drawn struck through with
   * the x active, so the user can see what Confirm is about to do and still
   * change their mind with the corner X.
   */
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

  /**
   * The success pulse, on the model's own signal.
   *
   * It used to fire on `pickerStatus` reaching `found`, which is one of the
   * surfaces this sprint removed. `senderOnline` is the same event with one
   * owner.
   */
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

  /**
   * Grab, for the first grab only.
   *
   * The selection is already on the record - that is the whole point of this
   * sprint - so this passes the model's own ticked list rather than a local
   * set, and `runDownload` re-reads it anyway.
   */

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
          {/* ONE status line, and no second surface.
              No sonar, no `Look again`: the message says what is happening and
              the dot says whether the sender is reachable. Polite - it changes
              on a timer with no user action. */}
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
          {/* The after-grab hint. One line, and the only second line the
              header is allowed. Part D's wording, because the gesture it
              describes is now a draft plus a button. */}
          {!!view?.hint && (
            <Text style={styles.hintLine}>
              {view.status === "ready" ? view.hint : DRAFT_HINT}
            </Text>
          )}
          {/* The partial-dedup acknowledgement, and only before a grab: it
              says what the user already holds, which after a grab the
              per-file `Saved` marks already say. */}
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
              // The DRAFT decides the tick and the strike-through, not the
              // record. `f.checked` is the saved state and is only the seed.
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
                    // Clause 6: a saved file opens from the picker. The tick
                    // beside it is not a control (`doneMark` is deliberately
                    // not tappable), so the row press is free to mean this.
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
                    /* The red x. Tapping it MARKS a stop; Confirm performs it.
                       `engineCancelTransfer` leaves the Corestore alone, so the
                       blocks stay and re-ticking the file resumes from them. */
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
                  {/* Clause 6: a saved image or video shows its own frame.
                      The path comes through the model with the file, so the
                      thumbnail and the open action below cannot point at
                      different files. */}
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
          {/* The button is back in every state, by instruction. `Grab N` for
              the first grab, then `Looks good` / `Confirm changes`, and
              `Resume` for a row the user stopped. */}
          {!!view && (
            <View style={styles.actions}>
              {/* `downloadAllBusy` suppresses the FIRST GRAB only. Changing a selection
                  mid-download is ordinary; only starting a second fresh download is the double-tap. */}
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
