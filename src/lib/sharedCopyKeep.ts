/**
 * Where the phone's own copy of a file it is sharing lives.
 *
 * The photo and file pickers hand over a copy in the caches or temporary folder, and that used
 * to be the only copy on record. The system empties those folders whenever it likes, and always
 * when a new version is installed over the old one, so a share made from Photos kept working
 * for other people while the phone that made it said "This file is no longer available locally".
 *
 * A picked copy is therefore moved, once the share exists, into a folder the system leaves
 * alone: `Documents/peardrop-shared/<share>/`. Moved, not copied, so it takes no extra room.
 * Nothing here touches the phone; it only says what should go where, so it can be tested.
 */

export type KeepStep = {
  /** Which file of the share this is, by position. */
  readonly index: number;
  readonly from: string;
  readonly to: string;
  /** `copy` when another share still needs the original; `move` otherwise. */
  readonly how: "move" | "copy";
};

/** The folder, under Documents, that holds every share's kept copies. */
export const KEPT_COPIES_FOLDER = "peardrop-shared";

function normalize(raw: string): string {
  let p = String(raw || "").trim();
  if (p.startsWith("file://")) {
    p = p.slice(7);
    if (p.startsWith("//")) p = p.slice(1);
  }
  try {
    p = decodeURI(p);
  } catch {
    // Compared as it is.
  }
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** iOS names the same folder with and without `/private` in front. Compared without. */
function comparable(path: string): string {
  const p = normalize(path);
  return p.startsWith("/private/var/") ? p.slice("/private".length) : p;
}

function isInside(path: string, root: string): boolean {
  const p = comparable(path);
  const r = comparable(root);
  return !!r && p.startsWith(`${r}/`);
}

/** The folder for one share's copies, or null when the share's id is not safe to put in a path. */
export function keptCopyDir(documentRoot: string, driveId: string): string | null {
  const root = normalize(documentRoot);
  const id = String(driveId || "");
  if (!root || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return `${root}/${KEPT_COPIES_FOLDER}/${id}`;
}

/** A file name with nothing in it that could leave the folder. */
function safeName(name: string, fallback: string): string {
  const last = String(name || "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = last.replace(/[\u0000-\u001f:]/g, "").replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

/**
 * What to do with each file of a new share so its copy survives.
 *
 * - A copy in a folder the system empties (`purgeableRoots`) is moved.
 * - A copy kept for ANOTHER share (shared again from the list) is copied, so deleting either
 *   share leaves the other's file alone.
 * - Anything else is the person's own file, somewhere of their choosing, and is left where it is.
 */
export function planKeptCopies(
  files: readonly { readonly name: string; readonly localPath: string }[],
  opts: { readonly purgeableRoots: readonly string[]; readonly keepDir: string },
): KeepStep[] {
  const keepDir = normalize(opts.keepDir);
  if (!keepDir) return [];
  const allShares = keepDir.slice(0, keepDir.lastIndexOf("/"));
  const taken = new Set<string>();
  const steps: KeepStep[] = [];
  files.forEach((file, index) => {
    const from = normalize(file.localPath);
    if (!from || from.split("/").includes("..")) return;
    if (isInside(from, keepDir)) return;
    const purgeable = opts.purgeableRoots.some((root) => isInside(from, root));
    const anotherShares = isInside(from, allShares);
    if (!purgeable && !anotherShares) return;
    const base = safeName(file.name, safeName(from, `file-${index + 1}`));
    let name = base;
    // Two files of one share may carry the same name from different folders.
    while (taken.has(name.toLowerCase())) name = `${index + 1}-${name}`;
    taken.add(name.toLowerCase());
    steps.push({ index, from, to: `${keepDir}/${name}`, how: anotherShares ? "copy" : "move" });
  });
  return steps;
}
