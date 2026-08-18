/**
 * Pure list logic for the in-app file picker.
 *
 * Two sections: "Recent" (files this app has shared before — usage history,
 * no permission needed) and "Downloads" (one level of the folder the user
 * granted via SAF). One level, not a folder tree, by design.
 *
 * Free of native imports so it stays unit-testable under the node jest
 * environment; anything touching expo-file-system lives in `folderShare.ts`.
 */

import type { PickedFile } from "./pickerResult";
import { fileExt, fileIconName, previewModeFor, type IconName } from "./files";

export type BrowseSource = "recent" | "downloads";

export type BrowseEntry = {
  /** Doubles as the selection key — unique per row. */
  uri: string;
  name: string;
  size?: number;
  /** ms since epoch. Undefined when the source can't tell us. */
  modifiedAt?: number;
  source: BrowseSource;
  /**
   * Which granted folder this row came from, for the origin label. Only
   * set on "downloads" rows, and only meaningful once the merged list
   * spans more than one folder.
   */
  folderLabel?: string;
};

/** Minimal shape of a `SharedFilePathsEntry`, so this module stays pure. */
export type ShareHistoryEntry = {
  files: { name: string; localPath: string; size?: number }[];
  savedAt: number;
};

/**
 * Newest first, with a name tiebreak so equal timestamps don't reorder
 * between renders. Entries with no timestamp sort last — an unknown date
 * is not evidence of recency.
 */
export function sortBrowseEntries(list: BrowseEntry[]): BrowseEntry[] {
  return [...list].sort((a, b) => {
    const at = a.modifiedAt ?? -1;
    const bt = b.modifiedAt ?? -1;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

/** First occurrence wins — call after sorting so the newest copy survives. */
export function dedupeByUri(list: BrowseEntry[]): BrowseEntry[] {
  const seen = new Set<string>();
  const out: BrowseEntry[] = [];
  for (const e of list) {
    if (!e.uri || seen.has(e.uri)) continue;
    seen.add(e.uri);
    out.push(e);
  }
  return out;
}

/**
 * Build the "Recent" section from PearDrop's own share history.
 *
 * This is the honest recents source: it's what the user actually sent,
 * not a guess from filesystem mtimes. The timestamp is the share's
 * `savedAt`, so ordering reflects "when you shared it" — which is the
 * question this list is answering.
 *
 * Cache eviction means some of these paths no longer resolve; the caller
 * existence-checks before rendering (same contract the share list uses).
 */
export function buildRecents(
  history: ShareHistoryEntry[],
  opts: { limit: number },
): BrowseEntry[] {
  const flat: BrowseEntry[] = [];
  for (const entry of history ?? []) {
    for (const f of entry?.files ?? []) {
      if (!f?.localPath) continue;
      flat.push({
        uri: f.localPath,
        name: f.name || f.localPath.split("/").pop() || "file",
        size: f.size,
        modifiedAt: entry.savedAt,
        source: "recent",
      });
    }
  }
  return dedupeByUri(sortBrowseEntries(flat)).slice(0, Math.max(0, opts.limit));
}

/**
 * Build the "Downloads" section from a granted SAF directory listing.
 * Directories are dropped rather than made tappable — one level only.
 */
export function buildDownloads(
  files: {
    uri: string;
    name: string;
    size?: number | null;
    modificationTime?: number | null;
  }[],
  opts: { limit: number; folderLabel?: string },
): BrowseEntry[] {
  const mapped: BrowseEntry[] = (files ?? [])
    .filter((f) => !!f?.uri)
    .map((f) => ({
      uri: f.uri,
      name: f.name || f.uri.split("/").pop() || "file",
      size: typeof f.size === "number" ? f.size : undefined,
      modifiedAt:
        typeof f.modificationTime === "number" ? f.modificationTime : undefined,
      source: "downloads" as const,
      ...(opts.folderLabel ? { folderLabel: opts.folderLabel } : {}),
    }));
  return dedupeByUri(sortBrowseEntries(mapped)).slice(0, Math.max(0, opts.limit));
}

/**
 * Fold every granted folder's listing into one date-ordered list.
 *
 * The point of multi-folder access is that the user stops thinking about
 * folders — they see their newest files, wherever those live, and the
 * folder is just a label on the row. Sorting across the union (rather
 * than concatenating per-folder blocks) is what delivers that.
 *
 * A folder that failed to list contributes nothing and doesn't break the
 * others; the caller decides what to do about the failure.
 */
export function mergeFolderListings(
  listings: BrowseEntry[][],
  opts: { limit: number },
): BrowseEntry[] {
  const flat = (listings ?? []).flat().filter(Boolean);
  return dedupeByUri(sortBrowseEntries(flat)).slice(0, Math.max(0, opts.limit));
}

/**
 * Origin labels are noise when there's only one folder in play — the
 * section already says which. Show them only once the list actually
 * spans more than one.
 */
export function shouldShowFolderLabels(folderCount: number): boolean {
  return folderCount > 1;
}

/**
 * SAF hands back `content://` URIs. The engine reads through bare-fs and
 * needs a real `file://` path, so those have to be copied into cache
 * first — same constraint `folderShare.materializeToCache` exists for.
 * Cache paths from share history are already `file://` and pass straight
 * through.
 */
export function needsMaterialization(uri: string): boolean {
  return String(uri || "").startsWith("content://");
}

export function partitionForMaterialization(entries: BrowseEntry[]): {
  direct: BrowseEntry[];
  needsCopy: BrowseEntry[];
} {
  const direct: BrowseEntry[] = [];
  const needsCopy: BrowseEntry[] = [];
  for (const e of entries) {
    (needsMaterialization(e.uri) ? needsCopy : direct).push(e);
  }
  return { direct, needsCopy };
}

/** Rows the user checked, in the order they appear in the list. */
export function selectedEntries(
  list: BrowseEntry[],
  selected: Set<string>,
): BrowseEntry[] {
  return list.filter((e) => selected.has(e.uri));
}

export function selectionSummary(
  list: BrowseEntry[],
  selected: Set<string>,
): { count: number; bytes: number } {
  const picked = selectedEntries(list, selected);
  return {
    count: picked.length,
    bytes: picked.reduce((acc, e) => acc + (e.size ?? 0), 0),
  };
}

/**
 * What to draw in a row's leading slot.
 *
 * Images get a real thumbnail — the platform `Image` renders the uri directly,
 * with no generation step and no extra access. Everything else gets a type
 * icon; thumbnail *generation* for pdf/video/office types is a rendering
 * pipeline, deliberately not a picker concern.
 */
export type ThumbSpec =
  | { kind: "image" }
  | { kind: "icon"; icon: IconName };

export function thumbnailFor(name: string): ThumbSpec {
  if (previewModeFor(name) === "image") return { kind: "image" };
  return { kind: "icon", icon: fileIconName(name) };
}

/**
 * Share history stores *bare* paths — `saveSharedFilePathsEntry` runs
 * them through `normalizeLocalPath`, which strips the `file://` scheme so
 * bare-fs can read them. The platform `Image` needs a scheme back, so add
 * one for display. Scheme-carrying uris (SAF `content://`, picker
 * `file://`) pass through untouched.
 *
 * Display only — the engine's `normalizeFilePath` accepts either form, so
 * nothing on the share path depends on this.
 */
export function toDisplayUri(uri: string): string {
  const s = String(uri || "");
  if (!s) return s;
  if (s.startsWith("/")) return `file://${s}`;
  return s;
}

/**
 * Short uppercase extension label for the icon tile — the "PDF" / "PY" /
 * "ZIP" chip Telegram puts on non-image rows. Empty string when there's
 * no usable extension, so the caller can skip the chip entirely rather
 * than render an empty box.
 */
export function typeBadge(name: string, maxLen = 4): string {
  const ext = fileExt(name);
  if (!ext) return "";
  return ext.slice(0, maxLen).toUpperCase();
}

/**
 * Human-readable name for a SAF tree URI, for labelling the granted
 * folder. The user can grant *any* folder (there's a "Change" affordance),
 * so the UI must not hardcode "Downloads" — it shows whatever they picked.
 *
 * Tree URIs look like:
 *   content://com.android.externalstorage.documents/tree/primary%3ADownload
 *   content://…/tree/primary%3ADocuments%2FWork
 *   content://…/tree/1234-5678%3AMyFolder          (SD card volume)
 *
 * Returns "" when nothing usable can be derived, so the caller can fall
 * back to generic wording rather than printing a URI at the user.
 */
export function folderDisplayName(treeUri: string): string {
  const raw = String(treeUri || "");
  if (!raw) return "";
  const TREE = "/tree/";
  const treeIdx = raw.lastIndexOf(TREE);
  let tail =
    treeIdx >= 0
      ? raw.slice(treeIdx + TREE.length)
      : raw.slice(raw.lastIndexOf("/") + 1);
  // Some providers append a /document/… segment to the tree URI.
  tail = tail.split("/document/")[0] ?? tail;
  try {
    tail = decodeURIComponent(tail);
  } catch {
    /* keep the raw tail */
  }
  // Strip the volume prefix ("primary:", "1234-5678:").
  const colon = tail.lastIndexOf(":");
  if (colon >= 0) tail = tail.slice(colon + 1);
  const parts = tail.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Incremental reveal. The Downloads listing can be large and every image row
 * mounts a real `Image`, so the screen reveals a page at a time — the data
 * stays complete while what's mounted is bounded.
 */
export function pageEntries<T>(
  list: T[],
  shown: number,
): { visible: T[]; remaining: number } {
  const safe = Math.max(0, shown);
  const visible = list.slice(0, safe);
  return { visible, remaining: Math.max(0, list.length - visible.length) };
}

/**
 * Map browse rows onto the exact `PickedFile` shape the OS picker paths
 * produce, so selection joins the existing share flow with no downstream
 * change. `uriOverrides` carries post-materialization `file://` paths for
 * the SAF rows, keyed by original uri.
 */
export function toPickedFiles(
  entries: BrowseEntry[],
  uriOverrides: Record<string, string> = {},
): PickedFile[] {
  return entries
    .map((e) => ({
      name: e.name,
      size: e.size,
      uri: uriOverrides[e.uri] ?? e.uri,
    }))
    .filter((f) => !!f.uri);
}
