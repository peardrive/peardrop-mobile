import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { useBackend } from "../state/backend";
import type { AppTheme } from "./themes";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatBytes } from "../lib/format";
import { baseName, fileIconName } from "../lib/files";
import {
  pickerLookupStatus,
  type PickerLookupState,
} from "../lib/pickerLookupStatus";
import { pickerGrabGate } from "../lib/pickerGrabGate";
import {
  previewHint,
  previewPrimaryLabel,
  previewSubtitle,
} from "../lib/sharePreviewCopy";
import { haptics } from "../lib/haptics";
import { indicatorColor } from "../lib/indicatorColor";
import { RESOLVE_LOOKING_LABEL } from "../lib/resolveHint";
import PearSonarLite from "./PearSonarLite";
import { ToastOutlet } from "./Toast";

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
    errBanner: { color: theme.danger, fontSize: 13, marginBottom: 12, lineHeight: 18 },
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
    // not render in the red errBanner style.
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
    // Amber-tinted advisory banner. Distinct from errBanner
    // (red) because the share might still work; we just want to warn the
    // user that the other side appears to be offline.
    offlineBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.primaryMuted,
      backgroundColor: theme.surfaceSubtle,
      marginBottom: 12,
    },
    offlineBannerText: {
      flex: 1,
      color: theme.muted,
      fontSize: 12,
      lineHeight: 16,
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
  const {
    previewVisible,
    closePreview,
    openResult,
    linkError,
    downloadAllBusy,
    downloadAllFromPreview,
    downloadSelectedFromPreview,
    alreadyDownloadedNames,
    sessionDriveId,
    pendingPreselection,
    relookupPreview,
    resolving,
  } = useShareLinkFlow();
  const { transfers } = useBackend();

  const files = useMemo(() => openResult?.files ?? [], [openResult]);
  const alreadySet = useMemo(
    () => new Set(alreadyDownloadedNames),
    [alreadyDownloadedNames],
  );
  const isPartialMatch = alreadySet.size > 0;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Offline detection while the preview is open. After the
  // resolve succeeds and the modal opens, the receiver's drive stays
  // joined to the swarm — its peer-connected / peer-disconnected events
  // reflect whether the sender is still reachable. If we have zero
  // connected peers >10 s after the modal opened, surface a warning
  // banner. We don't auto-close — the user might want to dismiss
  // manually or wait it out — this is purely advisory.
  const modalOpenedAtRef = useRef<number | null>(null);
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (previewVisible) {
      modalOpenedAtRef.current = Date.now();
      setTickNow(Date.now());
      const id = setInterval(() => setTickNow(Date.now()), 1000);
      return () => clearInterval(id);
    }
    modalOpenedAtRef.current = null;
    return undefined;
  }, [previewVisible]);
  // The picker resolves underneath itself, so say so. Reuses the tick above
  // rather than adding a second timer.
  const lookup = useMemo(
    () =>
      pickerLookupStatus({
        resolving,
        sessionDriveId,
        noticeTone: linkError?.tone ?? null,
        elapsedMs: modalOpenedAtRef.current ? tickNow - modalOpenedAtRef.current : 0,
      }),
    [resolving, sessionDriveId, linkError, tickNow],
  );
  /**
   * One buzz, on the edge into `found`.
   *
   * `lookup` is recomputed by the 1 Hz tick above, so anything that fires in
   * render or off the whole object would buzz every second — hence the
   * dependency on `lookup.state` (a string) rather than `lookup`, plus the
   * explicit edge check.
   *
   * `null` seeds from the FIRST computed state rather than from "looking":
   * on the paste/scan path `sessionDriveId` is already set in the commit that
   * opens this modal, so the first render is `found`. A hardcoded seed would
   * add a second buzz to every paste, on top of the provider's own.
   */
  const prevLookupRef = useRef<PickerLookupState | null>(null);
  useEffect(() => {
    if (!previewVisible) {
      prevLookupRef.current = null;
      return;
    }
    const prev = prevLookupRef.current;
    prevLookupRef.current = lookup.state;
    if (prev === null) return;
    if (prev !== "found" && lookup.state === "found") haptics.success();
  }, [previewVisible, lookup.state]);
  const sessionTransfer = useMemo(
    () =>
      sessionDriveId
        ? transfers.find((t) => t.driveId === sessionDriveId)
        : undefined,
    [transfers, sessionDriveId],
  );
  const offlineBannerVisible =
    previewVisible &&
    !!sessionDriveId &&
    !!modalOpenedAtRef.current &&
    tickNow - modalOpenedAtRef.current > 10_000 &&
    (!sessionTransfer || sessionTransfer.peersConnected === 0);

  // When the modal opens, default selection state depends on
  // whether we're in a partial-match scenario.
  // - Partial match (some files already downloaded): pre-select only the
  //   NEW files. Already-downloaded files are unchecked + badged + dim.
  //   Tapping the primary action ("Grab N") then defaults to fetching
  //   exactly the missing files.
  // - No match: keep previous behavior — nothing selected, primary action
  //   reads "Grab everything".
  // Closing the modal clears selection so the next open starts fresh.
  useEffect(() => {
    if (!previewVisible) {
      setSelected(new Set());
      return;
    }
    // smart-regrab pre-selection wins. The hint comes from tapping
    // a missing child row in an expanded bundle; it tells the modal exactly
    // which file to pre-check. Already-downloaded files are still rendered
    // dimmed + badged via alreadySet — preselected names that happen to
    // already be downloaded are skipped (no reason to pre-check an existing
    // file).
    if (pendingPreselection && pendingPreselection.length > 0) {
      const manifestNames = new Set(files.map((f) => f.name));
      const initial = pendingPreselection.filter(
        (n) => manifestNames.has(n) && !alreadySet.has(n),
      );
      setSelected(new Set(initial));
      return;
    }
    if (isPartialMatch) {
      const newOnes = files
        .map((f) => f.name)
        .filter((n) => !alreadySet.has(n));
      setSelected(new Set(newOnes));
    } else {
      setSelected(new Set());
    }
  }, [previewVisible, openResult, isPartialMatch, files, alreadySet, pendingPreselection]);

  const allKeys = useMemo(() => files.map((f) => f.name), [files]);
  const selectedKeys = useMemo(() => allKeys.filter((k) => selected.has(k)), [allKeys, selected]);
  const selectedBytes = useMemo(
    () => files.filter((f) => selected.has(f.name)).reduce((acc, f) => acc + (f.size ?? 0), 0),
    [files, selected]
  );
  const someSelected = selectedKeys.length > 0;
  const allSelected = selectedKeys.length > 0 && selectedKeys.length === allKeys.length;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allKeys));
  }

  // "Grab everything" for a one-file share came from a label that never
  // branched on the count. Both the label and the subtitle are functions now.
  const gate = pickerGrabGate({
    lookupState: lookup.state,
    downloadAllBusy,
    grabLabel: previewPrimaryLabel({
      fileCount: files.length,
      selectedCount: selectedKeys.length,
      selectedBytes,
    }),
  });
  const hint = previewHint(files.length, gate.grabAllowed);

  // the in-modal Grab blink is gone — the "Got it" badge already
  // tells the user which files are downloaded. The acknowledging blink now
  // lives on the main list's bundle row (auto-expanded if needed).
  const onPressGrab = () => {
    // Belt and braces. The button is already disabled unless the gate allows
    // it; a handler that silently returns is the defect this item removed.
    if (!gate.grabAllowed) return;
    if (someSelected) void downloadSelectedFromPreview(selectedKeys);
    else void downloadAllFromPreview();
  };

  return (
    <Modal visible={previewVisible} transparent animationType="fade" onRequestClose={closePreview}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={closePreview} />
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <View style={styles.titleSlot} />
            {/* Middle ellipsis keeps the extension visible, which a tail cut
                does not: "Q3-report-fin….pdf" beats "Q3-report-fina…". */}
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
              {openResult?.shareName || "Share"}
            </Text>
            <Pressable
              onPress={closePreview}
              style={styles.closeCircle}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={16} color={theme.muted} />
            </Pressable>
          </View>
          <Text style={styles.meta}>
            {previewSubtitle(files.length, openResult?.totalBytes)}
          </Text>
          {/* The status row moved ABOVE the pick controls: it is the thing the
              user is waiting on, and the controls below it depend on it.
              Polite — it changes on a timer with no user action. */}
          <View style={styles.lookupRow} accessibilityLiveRegion="polite">
            {lookup.state === "looking" ? (
              /* Gated on `looking`, and ReceiveSheet's own arm is gated on
                 `visible && resolving`, so only one sonar is ever mounted. */
              <PearSonarLite
                size={30}
                color={indicatorColor(theme)}
                label={RESOLVE_LOOKING_LABEL}
              />
            ) : (
              <Ionicons
                name={
                  lookup.state === "found"
                    ? "checkmark-circle-outline"
                    : "search-outline"
                }
                size={14}
                color={lookup.state === "found" ? theme.primaryMuted : theme.muted}
              />
            )}
            <Text
              style={[
                styles.lookupText,
                lookup.state === "found" && { color: theme.primaryMuted },
              ]}
            >
              {lookup.text}
            </Text>
          </View>
          {/* One status line, not two. `no-manifest` is now carried by the row
              above, so its banner would repeat it verbatim.

              Suppressed by TRIGGER, not by tone. Four triggers share the
              `wait` tone and three reach `linkError`; dropping the whole
              `wait` arm would leave `still-resolving` and `already-held` with
              no arm at all, and the `else` arm would then render both of
              them red — the exact defect this banner removed.

              Known gap, PRE-EXISTING and deliberately not fixed here:
              `already-held` keeps this arm but is wiped about one frame after
              it appears on the paste/scan path. `applyDedupClassification`
              sets the notice and calls `clearOnSuccess()` in the same batch;
              the emptied draft re-runs the debounce effect, whose
              `!linkDraft.trim()` branch calls `setLinkError(null)`. So the
              acknowledgement survives only on the reopen-picker path, where
              the draft is already empty. The fix is in that shared effect, not
              here — out of this round's scope. Do not read this arm as proof
              the message is visible. */}
          {!!linkError &&
            linkError.trigger !== "no-manifest" &&
            (linkError.tone === "wait" ? (
              <View style={styles.waitBanner}>
                <Ionicons
                  name="information-circle-outline"
                  size={16}
                  color={theme.muted}
                />
                <Text style={styles.waitBannerText}>{linkError.text}</Text>
              </View>
            ) : (
              <Text style={styles.errBanner}>{linkError.text}</Text>
            ))}
          {/*
            PearDrop has **no connectivity detection at all**. The only thing
            the condition at `:192-197` establishes is that ten seconds passed
            with no peer attached, which is equally the signature of DHT
            discovery still running normally. The copy below must not assert
            a cause it cannot observe (an "offline" state, a Wi-Fi problem) —
            it says only what is true at that moment: still looking, it can
            take a moment, plus the one thing the user can actually act on,
            which is the sender's phone being awake with PearDrop open. Links
            never expire, so nothing here may imply they do.
            `scripts/check-copy.mjs` (`npm run check:copy`) fails the build on
            "offline", "network", "check your" and "expire" in user-facing
            copy, and scans JSX text, not just string literals, to catch
            exactly this kind of banner.

            The `offlineBanner*` style/state names do not match this
            constraint and are left alone here as out of scope — they are not
            user-facing, and the check cannot see identifiers. Do not let the
            name talk you into asserting an offline cause.
          */}
          {offlineBannerVisible && (
            <View style={styles.offlineBanner} accessibilityLiveRegion="polite">
              <Ionicons name="search-outline" size={16} color={theme.muted} />
              <Text style={styles.offlineBannerText}>
                Still looking for the sender — this can take a moment. Their phone
                needs to be awake with PearDrop open.
              </Text>
            </View>
          )}
          {/* Only for 2+ files: with one file the checkbox, the hint and
              "Pick all" are three controls answering a one-answer question. */}
          {files.length > 1 && (
            <View style={styles.topRow}>
              <Text style={styles.hintText}>
                {someSelected ? `${selectedKeys.length} picked` : (hint ?? "")}
              </Text>
              <Pressable
                onPress={toggleAll}
                accessibilityRole="button"
                accessibilityLabel="Toggle select all"
              >
                <Text style={styles.selectAll}>
                  {allSelected ? "Clear all" : "Pick all"}
                </Text>
              </Pressable>
            </View>
          )}
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {files.map((f, index) => {
              const name = baseName(f.displayName || f.name);
              const checked = selected.has(f.name);
              const alreadyHave = alreadySet.has(f.name);
              return (
                <Pressable
                  key={`${f.name}_${index}`}
                  style={[
                    styles.fileRow,
                    index === 0 && styles.fileRowFirst,
                    alreadyHave && styles.fileRowAlreadyHave,
                  ]}
                  onPress={() => toggle(f.name)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={
                    alreadyHave
                      ? `${name}, already downloaded`
                      : `Pick ${name}`
                  }
                >
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked ? <Ionicons name="checkmark" size={14} color={theme.onPrimary} /> : null}
                  </View>
                  <View style={styles.iconSlot}>
                    {/* fileIcon's own header says to prefer fileIconName for
                        new rendering. f.name, not the display name, matching
                        the main list. */}
                    <Ionicons
                      name={fileIconName(f.name)}
                      size={26}
                      color={theme.text}
                    />
                  </View>
                  <View style={styles.fileMain}>
                    <Text
                      style={styles.fileName}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {name}
                    </Text>
                    <Text style={styles.fileMeta}>{formatBytes(f.size)}</Text>
                  </View>
                  {alreadyHave && (
                    <View style={styles.gotItBadge}>
                      <Ionicons
                        name="checkmark"
                        size={12}
                        color={theme.primary}
                      />
                      <Text style={styles.gotItBadgeText}>Got it</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
          {/* One slot. "Look again" REPLACES Grab rather than joining it, so
              nothing shifts when the lookup settles. */}
          <View style={styles.actions}>
            {gate.kind === "lookAgain" ? (
              <Pressable
                style={styles.primaryBtn}
                onPress={() => void relookupPreview()}
                accessibilityRole="button"
                accessibilityLabel={gate.label}
              >
                <Text style={styles.primaryText}>{gate.label}</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.primaryBtn, !gate.enabled && styles.disabled]}
                onPress={onPressGrab}
                disabled={!gate.enabled}
                accessibilityRole="button"
                accessibilityLabel={gate.label}
              >
                {gate.busy ? (
                  <ActivityIndicator color={theme.onPrimary} />
                ) : (
                  <Text style={styles.primaryText}>{gate.label}</Text>
                )}
              </Pressable>
            )}
          </View>
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
