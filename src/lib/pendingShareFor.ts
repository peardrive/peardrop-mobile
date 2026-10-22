/** The naming step's prefill, and the de-duplication that makes a bundle's in-drive keys unique. */
// Pure and react-free, so the prefill ladder and the de-dupe are reachable by the suite.

import { baseName, previewModeFor } from "./files";
import { defaultBundleName, prefillForSingleFile, splitExtension } from "./shareName";

export type PickedShareFile = {
  readonly uri: string;
  readonly name: string;
  readonly size?: number;
};

/** `folder` is generic so this module imports no expo surface; the screen supplies the type. */
export type PendingNameShare<F = unknown> = {
  readonly kind: "files" | "photos" | "folder";
  readonly defaultName: string;
  /** The fixed suffix shown beside the field for a single file. Empty for bundles and folders. */
  readonly ext: string;
  readonly files: PickedShareFile[];
  readonly folder?: F;
  readonly fileCount: number;
  /** Items the share sheet offered that could not be read, told to the user in the naming step. */
  readonly droppedCount?: number;
};

/** RNFS and bare-fs need the decoded form; an expo-file-system URI arrives percent-encoded. */
export function normalizeLocalPath(uri: string): string {
  let p = String(uri || "");
  if (p.startsWith("file://")) {
    p = p.slice(7);
    if (p.startsWith("//")) p = p.slice(1);
  }
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

/** Matches `uuid.ext` or `uuid`, so a synthesized peer filename is never shown as raw hex. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)?$/i;

export function isUuidLikeName(name: string): boolean {
  return UUID_RE.test(String(name || "").trim());
}

export function typeLabelForFile(name: string): string {
  const mode = previewModeFor(name);
  if (mode === "image") return "Shared photo";
  if (mode === "video") return "Shared video";
  if (mode === "audio") return "Shared audio";
  if (mode === "text") return "Shared document";
  return "Shared file";
}

export function defaultShareName(kind: "files" | "photos", fileCount: number): string {
  if (kind === "photos") return fileCount === 1 ? "Photo" : "Photos";
  return fileCount === 1 ? "File" : "Files";
}

/** The engine's own collision spelling, so the two ends of a share agree about a renamed file. */
// `uniquePath` in the engine produces `photo (1).jpg`; a bundle's keys are de-duped to match.
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const safe = String(name || "").trim() || "file";
  if (!taken.has(safe.toLowerCase())) return safe;
  const { base, ext } = splitExtension(safe);
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return safe;
}

/** One in-drive key per file, in the order given. Case-insensitive, because the receiver's
 *  filesystem is: two keys differing only in case would collide on arrival, not here. */
export function dedupeShareNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const next = uniqueName(baseName(String(raw || "")), taken);
    taken.add(next.toLowerCase());
    out.push(next);
  }
  return out;
}

/** The in-drive keys for a bundle, or null for a single file: the engine renames a lone entry to
 *  the chosen title only when no relPath is set, and passing one would silence that rename. */
export function relPathsForShare(files: readonly PickedShareFile[]): string[] | null {
  if (files.length <= 1) return null;
  return dedupeShareNames(files.map((f) => f.name));
}

/** Build the naming step. One file: its base name, with the extension as fixed text, or the human
 *  type label when the name is UUID-shaped. Bundle: a common base, else Photos/Files. */
export function pendingShareFor<F = unknown>(
  kind: "files" | "photos",
  files: PickedShareFile[],
  droppedCount = 0,
): PendingNameShare<F> {
  if (files.length === 1) {
    const only = files[0]!;
    const { base } = prefillForSingleFile(
      only.name,
      typeLabelForFile(only.name).replace(/^Shared /, "") || defaultShareName(kind, 1),
      isUuidLikeName,
    );
    // The suffix is read from the URI, the same place the engine reads it, or the field shows
    // `.jpg` while the engine appends `.jpeg` and the user gets `Hello.jpg.jpeg`.
    const { ext } = splitExtension(baseName(normalizeLocalPath(only.uri)));
    return { kind, defaultName: base, ext, files, fileCount: 1, droppedCount };
  }
  return {
    kind,
    defaultName: defaultBundleName(
      files.map((f) => f.name),
      defaultShareName(kind, files.length),
    ),
    ext: "",
    files,
    fileCount: files.length,
    droppedCount,
  };
}
