import { baseName } from "./files";

/**
 * When a file is fetched again and its name is taken, the engine saves it as `name (1).ext`.
 * That second copy is the same file from the same share, so it must land on the share's own
 * entry and never become an entry of its own. Before this, a re-fetch after an app update put a
 * second "file" in a one-file share: the row turned into a folder of two and stopped opening.
 * Pure data in, data out — no React, no storage, no filesystem.
 */

const COLLISION = /^(.*) \((\d{1,4})\)(\.[^./]*)?$/;

/** `clip (1).mp4` → `clip.mp4`; a name with no such suffix → `null`. */
export function stripCollisionSuffix(name: string): string | null {
  const m = COLLISION.exec(baseName(name));
  if (!m) return null;
  const stem = m[1] ?? "";
  if (!stem) return null;
  return `${stem}${m[3] ?? ""}`;
}

/**
 * Which of a share's files a file that just landed belongs to. The exact name wins, so a share
 * that really does contain `clip (1).mp4` keeps it; only then is the suffix taken off.
 * Returns the base name to look up, or `null` when the share has no such file.
 */
export function matchLandedName(shareBaseNames: Iterable<string>, landedName: string): string | null {
  const names = shareBaseNames instanceof Set ? shareBaseNames : new Set(shareBaseNames);
  const exact = baseName(landedName);
  if (names.has(exact)) return exact;
  const stripped = stripCollisionSuffix(exact);
  if (stripped && names.has(stripped)) return stripped;
  return null;
}

export type FoldableFile = {
  name: string;
  size: number;
  isDownloaded: boolean;
  localPath?: string;
  downloadedAt?: number;
};

/**
 * Entries that are a second copy of another entry in the same share, as `[copyIndex, ownerIndex]`.
 * Every guard has to hold, because folding a real file away would hide it:
 * - the copy's name, minus ` (n)`, is the owner's name;
 * - the copy's name has no leading slash. Names from the sender's list carry one, and the entry
 *   the app made up for a stray file does not, so a share that really holds both files is left alone;
 * - the copy is on the phone (a made-up entry always is);
 * - the sizes agree, or one of them is unknown.
 */
export function findCollisionCopies(files: readonly FoldableFile[]): [number, number][] {
  const ownerByName = new Map<string, number>();
  files.forEach((f, i) => {
    const key = baseName(f.name);
    if (!ownerByName.has(key)) ownerByName.set(key, i);
  });
  const pairs: [number, number][] = [];
  files.forEach((f, i) => {
    if (!f.isDownloaded || f.name.startsWith("/")) return;
    const stripped = stripCollisionSuffix(f.name);
    if (!stripped) return;
    const owner = ownerByName.get(stripped);
    if (owner === undefined || owner === i) return;
    const o = files[owner];
    if (!o) return;
    if (f.size > 0 && o.size > 0 && f.size !== o.size) return;
    pairs.push([i, owner]);
  });
  return pairs;
}

/**
 * Fold each second copy into the entry it belongs to, so the share lists the file once.
 * The owner keeps its own copy on the phone unless that copy is proven gone (`isOnDisk` said
 * `false`) or it never had one; then it takes the second copy's path. The file that is no longer
 * named stays on the phone until Storage → Clean up removes it. `undefined` from the probe means
 * "could not check" and never costs the owner its path.
 */
export function foldCollisionCopies<T extends FoldableFile>(
  files: readonly T[],
  isOnDisk: (localPath: string) => boolean | undefined = () => undefined,
): { files: T[]; folded: number } {
  const pairs = findCollisionCopies(files);
  if (pairs.length === 0) return { files: files as T[], folded: 0 };
  const next = files.slice();
  const drop = new Set<number>();
  for (const [copyIdx, ownerIdx] of pairs) {
    const copy = next[copyIdx];
    const owner = next[ownerIdx];
    if (!copy || !owner) continue;
    const ownerHolds = owner.isDownloaded && !!owner.localPath && isOnDisk(owner.localPath) !== false;
    const copyHolds = !!copy.localPath && isOnDisk(copy.localPath) !== false;
    if (!ownerHolds && copyHolds) {
      next[ownerIdx] = {
        ...owner,
        isDownloaded: true,
        localPath: copy.localPath,
        downloadedAt: copy.downloadedAt ?? owner.downloadedAt,
        size: owner.size || copy.size,
      };
    }
    drop.add(copyIdx);
  }
  return { files: next.filter((_, i) => !drop.has(i)), folded: drop.size };
}
