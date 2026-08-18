import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { formatBytes, formatRelativeOrDate } from "../lib/format";
import {
  buildDownloads,
  buildRecents,
  folderDisplayName,
  mergeFolderListings,
  pageEntries,
  selectionSummary,
  selectedEntries,
  shouldShowFolderLabels,
  thumbnailFor,
  toDisplayUri,
  typeBadge,
  type BrowseEntry,
  type ShareHistoryEntry,
} from "../lib/fileBrowse";
import {
  directoryFromUri,
  grantFolderAccess,
  listDirectoryOneLevel,
} from "../lib/folderShare";
import {
  addGrantedFolder,
  getGrantedFolders,
  removeGrantedFolder,
} from "../state/grantedFoldersStorage";
import FolderAccessModal from "./FolderAccessModal";

// These bound the data held in memory; `PAGE_SIZE` bounds what's mounted at
// once, so a large Downloads folder doesn't mount hundreds of Image views on
// first render.
const RECENT_SHARES_LIMIT = 60;
const DOWNLOADS_LIMIT = 500;
const PAGE_SIZE = 40;

export type FilePickerSheetProps = {
  visible: boolean;
  /** Share history, newest-first ordering handled internally. */
  history: ShareHistoryEntry[];
  /** Back / cancel. Routed through MainScreen's shared picker-exit path. */
  onCancel: () => void;
  /** Confirmed multi-selection, in list order. */
  onConfirm: (entries: BrowseEntry[]) => void;
  /** One-tap re-share of a previously shared file. */
  onReshare: (entry: BrowseEntry) => void;
  /** Escape hatch to the OS document picker ("Internal Storage"). */
  onBrowseOther: () => void;
  /** Shortcut into the existing 5D photo path. */
  onPickPhotos: () => void;
  /** True while the parent materializes + hands off to the share flow. */
  busy?: boolean;
};

/**
 * PearDrop's own file-selection screen.
 *
 * The reason it exists is the top-left back button: it's ours, so cancel
 * behaves. Storage shortcuts up top, "Recent shares" below, then the granted
 * Downloads folder — without widening file access. Internal Storage is a
 * styled entry point to the OS picker, not an in-app browser.
 */
export default function FilePickerSheet({
  visible,
  history,
  onCancel,
  onConfirm,
  onReshare,
  onBrowseOther,
  onPickPhotos,
  busy = false,
}: FilePickerSheetProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Merged, date-ordered listing across every granted folder. */
  const [files, setFiles] = useState<BrowseEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [folderModalOpen, setFolderModalOpen] = useState(false);

  const recentShares = useMemo(
    () => buildRecents(history, { limit: RECENT_SHARES_LIMIT }),
    [history],
  );
  const sharesPage = useMemo(
    () => pageEntries(recentShares, PAGE_SIZE),
    [recentShares],
  );
  const filesPage = useMemo(() => pageEntries(files, shown), [files, shown]);
  const showFolderLabels = shouldShowFolderLabels(folders.length);

  // Only the folder rows are checkbox-selectable; recent shares are
  // one-tap re-share. Keeping the summary scoped to the same list the
  // checkboxes come from means the count can't drift from the UI.
  const summary = useMemo(
    () => selectionSummary(files, selected),
    [files, selected],
  );

  /**
   * List every granted folder and merge the results into one date-ordered
   * list. A folder that no longer resolves — revoked in system settings,
   * SD card pulled — is dropped from our list and the others still load.
   * One dead folder must not blank the whole section.
   */
  const loadFolders = useCallback(async (uris: string[]) => {
    if (!uris.length) {
      setFiles([]);
      setFolders([]);
      return;
    }
    setFilesLoading(true);
    setFilesError(null);
    try {
      const listings: BrowseEntry[][] = [];
      const alive: string[] = [];
      const dead: string[] = [];
      for (const uri of uris) {
        try {
          const listed = listDirectoryOneLevel(directoryFromUri(uri));
          listings.push(
            buildDownloads(listed, {
              limit: DOWNLOADS_LIMIT,
              folderLabel: folderDisplayName(uri),
            }),
          );
          alive.push(uri);
        } catch {
          dead.push(uri);
        }
      }
      for (const uri of dead) await removeGrantedFolder(uri);
      setFolders(alive);
      setFiles(mergeFolderListings(listings, { limit: DOWNLOADS_LIMIT }));
      if (dead.length) {
        const names = dead
          .map((u) => folderDisplayName(u) || "a folder")
          .join(", ");
        setFilesError(`No longer reachable: ${names}. Removed from the list.`);
      }
    } finally {
      setFilesLoading(false);
    }
  }, []);

  // Rehydrate grants each time the sheet opens; clear selection and
  // collapse paging so a stale pick can't leak into this open.
  useEffect(() => {
    if (!visible) {
      setSelected(new Set());
      setShown(PAGE_SIZE);
      setFolderModalOpen(false);
      return;
    }
    let alive = true;
    void getGrantedFolders().then((uris) => {
      if (!alive) return;
      void loadFolders(uris);
    });
    return () => {
      alive = false;
    };
  }, [visible, loadFolders]);

  const onAddFolder = useCallback(async () => {
    setFilesError(null);
    try {
      const dir = await grantFolderAccess();
      // Back-out of the grant dialog is not an error — say nothing.
      if (!dir) return;
      const next = await addGrantedFolder(dir.uri);
      await loadFolders(next);
    } catch {
      setFilesError("Couldn't open that folder. Try Internal Storage.");
    }
  }, [loadFolders]);

  const onRemoveFolder = useCallback(
    async (uri: string) => {
      const next = await removeGrantedFolder(uri);
      // Drop any selection that lived in the folder being removed.
      setSelected((prev) => {
        const gone = new Set(
          files.filter((e) => e.folderLabel === folderDisplayName(uri)).map((e) => e.uri),
        );
        const kept = new Set([...prev].filter((u) => !gone.has(u)));
        return kept;
      });
      await loadFolders(next);
    },
    [files, loadFolders],
  );

  const toggle = useCallback((uri: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }, []);

  const onPressSend = useCallback(() => {
    const picked = selectedEntries(files, selected);
    if (!picked.length) return;
    onConfirm(picked);
  }, [files, selected, onConfirm]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Top-left back — the whole reason this screen exists. Matches the
            Settings / ReportBug header affordance. */}
        <View style={styles.header}>
          <Pressable
            onPress={onCancel}
            hitSlop={10}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={22} color={theme.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Send files</Text>
          <View style={styles.backBtn} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollInner}
          showsVerticalScrollIndicator={false}
        >
          {/* "Internal Storage" is a styled entry point to the OS document
              picker — no in-app folder browsing, no new permissions. */}
          <ShortcutRow
            icon="phone-portrait-outline"
            title="Internal Storage"
            a11yHint="Browse everything with the system picker"
            onPress={onBrowseOther}
            styles={styles}
            theme={theme}
          />
          <ShortcutRow
            icon="images-outline"
            title="Photos"
            a11yHint="Pick photos from your gallery"
            onPress={onPickPhotos}
            styles={styles}
            theme={theme}
          />

          {/* Recent shares, one tap to send again. */}
          {recentShares.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>RECENT SHARES</Text>
              <Text style={styles.sectionHint}>Tap to send again</Text>
              {sharesPage.visible.map((e) => (
                <FileRow
                  key={`share_${e.uri}`}
                  entry={e}
                  mode="reshare"
                  onPress={() => onReshare(e)}
                  styles={styles}
                  theme={theme}
                />
              ))}
            </>
          )}

          {/* One merged, date-ordered list across every granted folder —
              the user thinks in files, not folders, and the folder is a
              label on the row. Managing which folders feed it lives in
              the Folders modal rather than cluttering this header. */}
          <View style={styles.downloadsHeader}>
            <Text style={styles.sectionLabel}>RECENT FILES</Text>
            {folders.length > 0 && !filesLoading && (
              <Pressable
                onPress={() => setFolderModalOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Manage the folders PearDrop can read"
              >
                <Text style={styles.linkText}>Folders</Text>
              </Pressable>
            )}
          </View>
          {folders.length > 0 && !filesLoading && (
            <Text style={styles.sectionHint}>
              {`From ${folders
                .map((u) => folderDisplayName(u) || "a folder")
                .join(", ")}`}
            </Text>
          )}

          {filesLoading ? (
            <View style={styles.inlineBusy}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : folders.length > 0 ? (
            files.length > 0 ? (
              <>
                {filesPage.visible.map((e) => (
                  <FileRow
                    key={e.uri}
                    entry={e}
                    mode="select"
                    checked={selected.has(e.uri)}
                    showFolder={showFolderLabels}
                    onPress={() => toggle(e.uri)}
                    styles={styles}
                    theme={theme}
                  />
                ))}
                {filesPage.remaining > 0 && (
                  <Pressable
                    style={styles.showMore}
                    onPress={() => setShown((n) => n + PAGE_SIZE)}
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${filesPage.remaining} more files`}
                  >
                    <Text style={styles.showMoreText}>
                      Show {filesPage.remaining} more
                    </Text>
                  </Pressable>
                )}
              </>
            ) : (
              <Text style={styles.emptyHint}>
                Nothing in{" "}
                {folders.length === 1 ? "that folder" : "those folders"}.
              </Text>
            )
          ) : (
            <Pressable
              style={styles.grantCard}
              onPress={onAddFolder}
              accessibilityRole="button"
              accessibilityLabel="Add a folder PearDrop can read"
            >
              <Ionicons name="folder-open-outline" size={22} color={theme.primary} />
              <View style={styles.grantBody}>
                <Text style={styles.grantTitle}>Add a folder</Text>
                <Text style={styles.grantHint}>
                  Its files show up here, ready to send without the system
                  picker. Downloads is a good first one. Android asks once
                  per folder, and PearDrop only ever reads what you add.
                </Text>
              </View>
            </Pressable>
          )}

          {!!filesError && <Text style={styles.errText}>{filesError}</Text>}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            style={[
              styles.primaryBtn,
              (summary.count === 0 || busy) && styles.disabled,
            ]}
            onPress={onPressSend}
            disabled={summary.count === 0 || busy}
            accessibilityRole="button"
            accessibilityLabel={
              summary.count === 0
                ? "Pick files to send"
                : `Send ${summary.count} files`
            }
          >
            {busy ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Text style={styles.primaryText}>
                {summary.count === 0
                  ? "Pick files to send"
                  : `Send ${summary.count} (${formatBytes(summary.bytes)})`}
              </Text>
            )}
          </Pressable>
        </View>

        <FolderAccessModal
          visible={folderModalOpen}
          folders={folders}
          onClose={() => setFolderModalOpen(false)}
          onAdd={() => void onAddFolder()}
          onRemove={(uri) => void onRemoveFolder(uri)}
        />
      </View>
    </Modal>
  );
}

/**
 * Title-only shortcut row. The descriptive subtitle was dropped — the
 * titles carry their own meaning and the stacked hints made the top of
 * the screen read as dense. `a11yHint` keeps the explanation for
 * TalkBack, where there's no visual context to lean on.
 */
function ShortcutRow({
  icon,
  title,
  a11yHint,
  onPress,
  styles,
  theme,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  a11yHint: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={a11yHint}
    >
      <View style={styles.shortcutIcon}>
        <Ionicons name={icon} size={22} color={theme.primary} />
      </View>
      <Text style={[styles.shortcutTitle, styles.fileMain]}>{title}</Text>
      <Ionicons name="chevron-forward" size={16} color={theme.muted} />
    </Pressable>
  );
}

/**
 * Image thumbnail or type icon.
 *
 * The platform `Image` fetches asynchronously off the JS thread, so
 * mounting one never blocks the row — the icon renders immediately and is
 * swapped when (if) the bitmap arrives. A load failure falls back to the
 * same icon rather than leaving a hole; cache-evicted recents hit this
 * path routinely.
 */
function Thumb({
  name,
  uri,
  styles,
  theme,
}: {
  name: string;
  uri: string;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const spec = useMemo(() => thumbnailFor(name), [name]);
  const [failed, setFailed] = useState(false);
  // Reset on uri change so a recycled row doesn't inherit a stale failure.
  useEffect(() => setFailed(false), [uri]);

  if (spec.kind === "image" && !failed) {
    return (
      <View style={styles.thumbWrap}>
        <Image
          source={{ uri: toDisplayUri(uri) }}
          style={styles.thumbImage}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessible={false}
        />
      </View>
    );
  }

  const badge = typeBadge(name);
  const icon = spec.kind === "icon" ? spec.icon : "image-outline";
  return (
    <View style={[styles.thumbWrap, styles.thumbIconWrap]}>
      <Ionicons name={icon} size={18} color={theme.primary} />
      {!!badge && (
        <Text style={styles.thumbBadge} numberOfLines={1}>
          {badge}
        </Text>
      )}
    </View>
  );
}

function FileRow({
  entry,
  mode,
  checked = false,
  showFolder = false,
  onPress,
  styles,
  theme,
}: {
  entry: BrowseEntry;
  /** "select" shows a checkbox; "reshare" is a one-tap send-again row. */
  mode: "select" | "reshare";
  checked?: boolean;
  /** Append the origin folder — only useful once the list spans several. */
  showFolder?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const meta = [
    entry.size != null ? formatBytes(entry.size) : null,
    entry.modifiedAt ? formatRelativeOrDate(entry.modifiedAt) : null,
    showFolder && entry.folderLabel ? entry.folderLabel : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole={mode === "select" ? "checkbox" : "button"}
      accessibilityState={mode === "select" ? { checked } : undefined}
      accessibilityLabel={
        mode === "select" ? `Pick ${entry.name}` : `Send ${entry.name} again`
      }
    >
      {mode === "select" && (
        <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
          {checked ? (
            <Ionicons name="checkmark" size={14} color={theme.onPrimary} />
          ) : null}
        </View>
      )}
      <Thumb name={entry.name} uri={entry.uri} styles={styles} theme={theme} />
      <View style={styles.fileMain}>
        <Text style={styles.fileName} numberOfLines={1}>
          {entry.name}
        </Text>
        {!!meta && <Text style={styles.fileMeta}>{meta}</Text>}
      </View>
      {mode === "reshare" && (
        <Ionicons name="arrow-redo-outline" size={18} color={theme.muted} />
      )}
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.pad,
      paddingBottom: 8,
    },
    backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    headerTitle: { color: theme.text, fontWeight: "700", fontSize: 18 },
    scrollInner: { paddingHorizontal: theme.pad, paddingBottom: 16 },
    pressed: { opacity: 0.85 },
    sectionLabel: {
      color: theme.muted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginTop: 18,
      marginBottom: 2,
    },
    sectionHint: { color: theme.muted, fontSize: 12, marginBottom: 4 },
    downloadsHeader: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
    },
    linkText: { color: theme.primary, fontWeight: "600", fontSize: 13 },
    shortcut: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      marginTop: 8,
    },
    shortcutIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: theme.surfaceSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    shortcutTitle: { color: theme.text, fontWeight: "700", fontSize: 15 },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
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
    checkboxChecked: { backgroundColor: theme.primary, borderColor: theme.primary },
    thumbWrap: {
      width: 40,
      height: 40,
      borderRadius: 10,
      overflow: "hidden",
      backgroundColor: theme.surfaceSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    thumbIconWrap: {
      borderWidth: 1,
      borderColor: theme.border,
    },
    thumbImage: { width: "100%", height: "100%" },
    thumbBadge: {
      color: theme.muted,
      fontSize: 8,
      fontWeight: "700",
      letterSpacing: 0.4,
      marginTop: 1,
    },
    fileMain: { flex: 1, minWidth: 0 },
    fileName: { color: theme.text, fontSize: 14, fontWeight: "500" },
    fileMeta: { color: theme.muted, fontSize: 12, marginTop: 2 },
    showMore: {
      paddingVertical: 12,
      alignItems: "center",
    },
    showMoreText: { color: theme.primary, fontWeight: "700", fontSize: 14 },
    grantCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      padding: 14,
      marginTop: 6,
    },
    grantBody: { flex: 1, minWidth: 0 },
    grantTitle: { color: theme.text, fontWeight: "700", fontSize: 15 },
    grantHint: { color: theme.muted, fontSize: 12, marginTop: 3, lineHeight: 16 },
    inlineBusy: { paddingVertical: 20, alignItems: "center" },
    emptyHint: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      paddingVertical: 12,
    },
    errText: { color: theme.danger, fontSize: 13, marginTop: 10, lineHeight: 18 },
    footer: {
      paddingHorizontal: theme.pad,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      backgroundColor: theme.bg,
    },
    primaryBtn: {
      backgroundColor: theme.primary,
      paddingVertical: 14,
      borderRadius: 14,
      alignItems: "center",
    },
    primaryText: { color: theme.onPrimary, fontWeight: "700", fontSize: 15 },
    disabled: { opacity: 0.55 },
  });
}
