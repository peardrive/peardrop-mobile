import { Directory, File, Paths } from "expo-file-system";
import * as LegacyFs from "expo-file-system/legacy";
import { isPickerCancellation } from "./pickerResult";

export type EnumeratedFile = {
  uri: string;
  name: string;
  relPath: string;
  size: number;
};

export type EnumerateOptions = {
  maxFiles: number;
};

export class FolderTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Folder exceeds the ${limit}-file limit.`);
    this.name = "FolderTooLargeError";
    this.limit = limit;
  }
}

const SKIP_NAMES = new Set(["node_modules", "__pycache__"]);

function shouldSkip(name: string): boolean {
  if (!name) return true;
  if (name.startsWith(".")) return true;
  if (SKIP_NAMES.has(name)) return true;
  return false;
}

// `Paths.basename` splits only on URI-level `/`, so a SAF child URI yields
// the whole percent-encoded document ID, and child URIs carry a trailing `/`.
/** Exported so the naming step can default a folder share to the folder's own
 *  name, which it must read before `enumerateFolder` runs: enumeration copies
 *  every file into cache, and a cancel after that leaves the copies behind. */
export function leafName(uri: string): string {
  const stripped = uri.replace(/\/+$/, "");
  const lastSlash = stripped.lastIndexOf("/");
  let tail = lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
  try {
    tail = decodeURIComponent(tail);
  } catch {
    /* keep raw tail */
  }
  const parts = tail.split("/").filter(Boolean);
  return parts[parts.length - 1] || "file";
}

// The declared `Directory.pickDirectoryAsync` return type and the runtime
// augmented `Directory` class drift, so use the inferred return type.
export type PickedDirectory = Awaited<ReturnType<typeof Directory.pickDirectoryAsync>>;

export async function pickFolder(): Promise<PickedDirectory | null> {
  try {
    return await Directory.pickDirectoryAsync();
  } catch (err: unknown) {
    // `isPickerCancellation` checks the documented error codes, not just a
    // message substring, so a back-out returns null rather than an error.
    if (isPickerCancellation(err)) return null;
    throw err;
  }
}

export async function enumerateFolder(
  root: PickedDirectory,
  opts: EnumerateOptions,
): Promise<EnumeratedFile[]> {
  const out: EnumeratedFile[] = [];
  await walk(root, "", out, opts);
  return out;
}

async function walk(
  dir: PickedDirectory,
  relPrefix: string,
  out: EnumeratedFile[],
  opts: EnumerateOptions,
): Promise<void> {
  const children = dir.list();
  for (const child of children) {
    const name = leafName(child.uri);
    if (shouldSkip(name)) continue;
    const relPath = relPrefix ? `${relPrefix}/${name}` : name;
    if (child instanceof File) {
      if (out.length >= opts.maxFiles) throw new FolderTooLargeError(opts.maxFiles);
      const cachePath = await materializeToCache(child, name);
      out.push({
        uri: cachePath,
        name,
        relPath,
        size: typeof child.size === "number" ? child.size : 0,
      });
    } else {
      await walk(child as PickedDirectory, relPath, out, opts);
    }
  }
}

// The engine needs real file:// paths, and SAF content:// sources stream
// cleanly only via the legacy `copyAsync`: the new File API's `bytes()` /
// `open()` paths go through `javaFile` and OOM on media-sized SAF sources.
// Exported so the in-app picker materializes SAF rows under the same rule.
export async function materializeUriToCache(
  sourceUri: string,
  leafFileName: string,
  prefix = "peardrop-pick",
): Promise<string> {
  const stamp = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dest = new File(Paths.cache, `${prefix}-${stamp}_${leafFileName}`);
  await LegacyFs.copyAsync({ from: sourceUri, to: dest.uri });
  return dest.uri;
}

async function materializeToCache(source: File, leafFileName: string): Promise<string> {
  return materializeUriToCache(source.uri, leafFileName, "peardrop-folder");
}

/** Open the SAF folder-grant dialog. The returned URI is persistable and
 *  Android accumulates these rather than replacing, so each call adds one
 *  more readable folder at the cost of one dialog and no manifest permission.
 *  Returns null when the user backs out, matching `pickFolder`. */
export async function grantFolderAccess(): Promise<PickedDirectory | null> {
  try {
    return await Directory.pickDirectoryAsync(downloadsInitialUri());
  } catch (err: unknown) {
    if (isPickerCancellation(err)) return null;
    throw err;
  }
}

/** Best-effort initial location for the grant dialog. An OEM provider that
 *  does not recognize the name opens at its own default rather than failing,
 *  so this stays a hint rather than a requirement. */
function downloadsInitialUri(): string | undefined {
  try {
    return LegacyFs.StorageAccessFramework.getUriForDirectoryInRoot("Download");
  } catch {
    return undefined;
  }
}

/** Rebuild a Directory handle from a stored grant URI. The SAF permission
 *  lives in the system's persisted-permission table, not in the handle, so
 *  reconstructing it across launches is enough. */
export function directoryFromUri(uri: string): PickedDirectory {
  return new Directory(uri) as PickedDirectory;
}

/** List one level of a previously-granted directory. Directories are dropped:
 *  this picker is deliberately not a folder tree. Throws if the grant is no
 *  longer valid, which callers treat as "re-prompt". */
export function listDirectoryOneLevel(dir: PickedDirectory): {
  uri: string;
  name: string;
  size?: number | null;
  modificationTime?: number | null;
}[] {
  const out: {
    uri: string;
    name: string;
    size?: number | null;
    modificationTime?: number | null;
  }[] = [];
  for (const child of dir.list()) {
    if (!(child instanceof File)) continue;
    const name = leafName(child.uri);
    if (shouldSkip(name)) continue;
    out.push({
      uri: child.uri,
      name,
      size: child.size,
      modificationTime: child.modificationTime,
    });
  }
  return out;
}
