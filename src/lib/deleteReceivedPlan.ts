/**
 * What "Delete" on a received share removes: the app's own copies under
 * `<root>/peardrop/downloads`, plus the corestore via the engine. It never
 * touches files the user copied to `Downloads/PearDrop`, which is not under
 * the app's document directory and so can never match. Decided in a module
 * rather than in the screen so the safety property is directly testable.
 */

/** A downloaded-file index entry, narrowed to what the plan needs. */
export type LegacyDownloadedEntry = {
  id: string;
  path: string;
  shareLink?: string;
};

/** A share's per-file record, narrowed to what the plan needs. */
export type ShareFileRef = {
  name: string;
  localPath?: string;
};

export type ReceivedDeletePlan = {
  /** Absolute paths to unlink. Every one is inside the app's own downloads. */
  unlink: string[];
  /** `receivedFilesStorage` entry ids to drop from the index. */
  legacyIds: string[];
  /**
   * Paths that belong to this share but sit **outside** the app's own storage —
   * a user's own copy. Reported so the caller can say so, never unlinked.
   */
  keptOutsideApp: string[];
};

/** `<documentDirectoryPath>/peardrop/downloads` — the only unlinkable subtree. */
export function appOwnedDownloadsRoot(documentDirectoryPath: string): string {
  return `${normalizePath(documentDirectoryPath).replace(/\/+$/, "")}/peardrop/downloads`;
}

function normalizePath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
}

/** Is `candidate` a file the app itself wrote into its own downloads
 *  directory? Deliberately strict: a traversal segment anywhere disqualifies
 *  the path rather than being resolved away, because this gate guards an
 *  `unlink` and the safe answer to an unclear path is no. */
export function isAppOwnedCopy(candidate: string, documentDirectoryPath: string): boolean {
  const p = normalizePath(candidate);
  const root = appOwnedDownloadsRoot(documentDirectoryPath);
  if (!p || !root || root === "/peardrop/downloads") return false;
  if (p.split("/").includes("..")) return false;
  // A trailing slash on the root is required: `<root>evil/x` must not match.
  return p.startsWith(`${root}/`) && p.length > root.length + 1;
}

/** Work out exactly what Delete removes for one received share. Both halves
 *  are needed: unlinking the bytes without dropping the index entries leaves
 *  the dedup probe claiming the files are already here, and dropping the
 *  entries without unlinking leaves files with nothing pointing at them. */
export function planReceivedDelete(args: {
  shareFiles: ShareFileRef[];
  legacy: LegacyDownloadedEntry[];
  shareLink: string;
  documentDirectoryPath: string;
  /** Link normalizer, injected so this module stays free of `links.ts`'s deps. */
  normalizeLink: (raw: string) => string | null;
}): ReceivedDeletePlan {
  const { shareFiles, legacy, shareLink, documentDirectoryPath, normalizeLink } = args;
  const wanted = normalizeLink(shareLink);

  const unlink = new Set<string>();
  const keptOutsideApp = new Set<string>();
  const legacyIds = new Set<string>();

  const consider = (raw: string | undefined) => {
    if (!raw) return;
    if (isAppOwnedCopy(raw, documentDirectoryPath)) unlink.add(normalizePath(raw));
    else keptOutsideApp.add(normalizePath(raw));
  };

  for (const f of shareFiles) consider(f.localPath);

  for (const entry of legacy) {
    // An entry belongs here only if its link normalizes to the same value;
    // guessing for a link-less entry risks deleting another share's files.
    if (!entry.shareLink || !wanted) continue;
    if (normalizeLink(entry.shareLink) !== wanted) continue;
    legacyIds.add(entry.id);
    consider(entry.path);
  }

  return {
    unlink: Array.from(unlink),
    legacyIds: Array.from(legacyIds),
    keptOutsideApp: Array.from(keptOutsideApp),
  };
}

export type DeleteConfirmCopy = { title: string; body: string };

/** The confirm text, which has to say exactly what happens: which copies go
 *  and which stay. It deliberately does not promise that pasting the link
 *  again will offer the files, because that also depends on the sender still
 *  hosting, which this device cannot establish. */
export function describeDeleteConfirm(kind: "received" | "hosted"): DeleteConfirmCopy {
  if (kind === "received") {
    return {
      title: "Delete this share?",
      body:
        "Removes PearDrop's copy of these files from this device. " +
        "Anything you saved to Downloads stays. Can't undo.",
    };
  }
  return {
    title: "Delete this drive?",
    body: "Removes the data from your device. Can't undo.",
  };
}
