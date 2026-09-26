import { baseName } from "./files";
import type { OpenLinkResult } from "../state/types";

/**
 * reopening a received share's
 * picker from what is already on disk, and grabbing **only** what is missing.
 *
 * ## Two separate defects live here
 *
 * **1 · The picker had no offline source.** `SharePreviewModal` renders
 * `openResult`, and the only producer of that value is
 * `applyDedupClassification` in `src/state/ShareLinkFlowContext.tsx`, reached
 * only after a **live** `engineOpenDrive`. So a share the user had already
 * resolved once — whose whole file list is sitting in
 * `peardrop-received-shares.json` — could not show its picker again without the
 * sender being found first. `storedShareToOpenResult` is the adapter that
 * closes that: same shape, no network, no engine call.
 *
 * **2 · Any grab that bypasses the resolve re-fetches files the user already
 * has.** The already-downloaded skip is **RN-side only**: `runDownload`
 * partitions on `alreadyDownloadedNames`, which is populated *exclusively* by a
 * successful resolve. The engine skips nothing — it selects by `wantedSet` and
 * collides through `uniquePath`, which produces `` `${stem} (${i})${ext}` ``.
 * **So an offline grab produces `photo (1).jpg` duplicates by construction
 * unless the partition is rebuilt from `files[].isDownloaded`.** That is what
 * `partitionGrabNames` is for.
 *
 * ## `name` is the drive entry KEY, and that is why this works at all
 *
 * The phase-2h scout's finding was that `ReceivedShareFile.path` is dead in
 * practice — `healShareFiles` never sets it and `markFilesDownloaded`'s insert
 * branch omits it — so a picker built from disk has **names only**, while the
 * engine matches by `normalizeKey(f.key)`.
 *
 * It works because of what the stored `name` actually is:
 * `healShareFiles` writes `{ name: m.name }` straight off `manifest.files[]`,
 * and `OpenLinkResult.files[].name` **is the drive entry key**, leading `/`
 * included (`src/state/types.ts`, `DriveFileRef`). So for every file that is
 * *not yet downloaded* — precisely the set a re-grab needs — the stored `name`
 * is verbatim the key `engineDownload`'s `wantedSet` compares against. No new
 * persisted field is required, and none is added.
 *
 * The one place the two diverge is `markFilesDownloaded`, which re-keys an
 * entry it had to insert to `baseName(name)`. That only happens for a file the
 * manifest did not list, and such a file is `isDownloaded: true` by definition,
 * so it never enters the fetch set. `displayName` below carries the human
 * spelling so the modal renders the name and addresses with the key — the
 * `DriveFileRef` rule, applied at the one place this module produces both.
 *
 * ## Why a pure module
 *
 * `ShareLinkFlowContext.tsx` and `MainScreen.tsx` are both `.tsx` and
 * unreachable from the jest suite. Nothing here imports React,
 * RNFS or any store.
 */

/** Structurally `ReceivedShareFile`. Not an import — see the header. */
export type StoredFileLike = {
  name: string;
  size?: number | null | undefined;
  isDownloaded?: boolean | null | undefined;
  localPath?: string | null | undefined;
};

/** Structurally `ReceivedShare`, narrowed to what this module reads. */
export type StoredShareLike = {
  shareKey: string;
  shareLink: string;
  shareName?: string | null | undefined;
  /** / contract C-4: the engine drive id, persisted on the record. */
  driveId?: string | null | undefined;
  /** / contract C-5: the folder the engine last wrote this share into. */
  downloadDir?: string | null | undefined;
  files: readonly StoredFileLike[];
};

/**
 * "Held" requires **both** `isDownloaded` and a `localPath` — the same pair
 * `describeHoldings` uses and the same pair the row's `localFiles` derivation
 * uses. A flag with no path is not a file the user can open, and the flag is
 * only as good as its last existence check.
 */
export function isHeld(f: StoredFileLike | null | undefined): boolean {
  return !!f && f.isDownloaded === true && typeof f.localPath === "string" && f.localPath.length > 0;
}

/** Names of the files this device already holds. */
export function heldNames(files: readonly StoredFileLike[]): string[] {
  return files.filter((f) => isHeld(f)).map((f) => f.name);
}

/** Names of the files this device is still missing. The re-grab set. */
export function missingNames(files: readonly StoredFileLike[]): string[] {
  return files.filter((f) => !isHeld(f)).map((f) => f.name);
}

export type GrabPartition = {
  /** Sent to `startDownload`. */
  fetch: string[];
  /** Already on disk — skipped, and reported as "kept your existing copy". */
  keep: string[];
};

/**
 * Split the names a grab was asked for into fetch and keep, **using the stored
 * download flags rather than a resolve's `alreadyDownloadedNames`.**
 *
 * `requested` omitted (or empty) means "everything in the share", which is what
 * the modal's "Grab everything" does.
 *
 * A requested name that is not in the share at all is passed through to `fetch`
 * rather than dropped: the caller asked for it, the engine is the authority on
 * whether the drive has it, and silently discarding a request is how a grab
 * reports success having fetched nothing.
 */
export function partitionGrabNames(
  files: readonly StoredFileLike[],
  requested?: readonly string[] | null,
): GrabPartition {
  const targets =
    requested && requested.length > 0 ? Array.from(requested) : files.map((f) => f.name);
  /**
   * THE FIX. This set is what `runDownload`'s `alreadySet` is on the resolve
   * path — except it is rebuilt from the stored `isDownloaded`/`localPath` pair
   * instead of from a resolve's `alreadyDownloadedNames`, which is empty on any
   * path that did not resolve. Remove it and an offline re-grab re-fetches every
   * file the user already has, and `uniquePath` writes each one a second time as
   * `photo (1).jpg`.
   */
  const heldSet = new Set(heldNames(files));
  return {
    fetch: targets.filter((n) => !heldSet.has(n)),
    keep: targets.filter((n) => heldSet.has(n)),
  };
}

/**
 * The offline adapter: a stored `ReceivedShare` rendered as the shape
 * `SharePreviewModal` already consumes.
 *
 * `hasManifest: true` is not a guess. A
 * `ReceivedShare` is written **only** on a resolve that
 * `classifyResolve(manifest) === "usable"` already accepted, so the existence
 * of this record is itself the evidence that a manifest was parsed for this
 * share. The field's contract is *"the engine actually parsed the manifest"* —
 * past tense is what it says, and it is true here.
 *
 * `driveId` is carried through when the record has one (contract C-4) so the
 * caller can reopen the drive by id instead of re-resolving the link.
 */
export function storedShareToOpenResult(share: StoredShareLike): OpenLinkResult {
  const files = share.files.map((f) => ({
    // The drive entry key. Addresses; never rendered. See the header.
    name: f.name,
    // What a human sees. Renders; never addresses.
    displayName: baseName(f.name),
    size: typeof f.size === "number" && Number.isFinite(f.size) ? Math.max(0, f.size) : 0,
  }));
  return {
    ok: true,
    hasManifest: true,
    ...(share.driveId ? { driveId: share.driveId } : {}),
    shareName: share.shareName || "Share",
    totalBytes: files.reduce((a, f) => a + f.size, 0),
    files,
  };
}
