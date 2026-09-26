export function fileExt(name: string): string {
  const clean = String(name || "").toLowerCase();
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(dot + 1) : "";
}

export function baseName(pathOrName: string): string {
  const s = String(pathOrName || "")
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/");
  return s.split("/").pop() || pathOrName;
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"];
// An extension missing from this list falls through to previewModeFor →
// "unsupported" and mimeFromName → "*/*": neither previews nor opens.
const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp", "3g2"];
const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];
const DOC_EXTS = ["pdf", "doc", "docx", "txt", "md", "rtf", "odt"];
const TEXT_CODE_EXTS = [
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml",
  "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "hpp", "cs", "sh", "html", "css",
];
const ARCHIVE_EXTS = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"];
const EXEC_EXTS = ["exe", "dmg", "apk", "deb", "app", "msi"];
/** `.apk` is the one entry in `EXEC_EXTS` that means something on the device
 *  the user is holding. It stays in `EXEC_EXTS`, because `mimeFromName` and
 *  every other consumer still want it classified as an executable; it is
 *  split out only for the icon. */
const ANDROID_PACKAGE_EXTS = ["apk"];
const TEXT_PREVIEW_EXTS = ["txt", "md", "json", "csv", "log", "xml", "yaml", "yml"];
const PDF_EXTS = ["pdf"];

export type PreviewMode = "image" | "text" | "video" | "audio" | "unsupported";

export type IconName =
  | "image-outline"
  | "videocam-outline"
  | "musical-notes-outline"
  | "document-text-outline"
  | "document-outline"
  | "archive-outline"
  | "cog-outline"
  // The one glyph here without an `-outline` twin: Ionicons ships
  // `logo-android` and no `logo-android-outline`.
  | "logo-android"
  | "folder-outline";

/** Emoji-based icon kept for any code path that still wants a glyph. Prefer
 *  `fileIconName` for new rendering. */
export function fileIcon(name: string): string {
  const ext = fileExt(name);
  if (IMAGE_EXTS.includes(ext)) return "🖼️";
  if (VIDEO_EXTS.includes(ext)) return "🎬";
  if (AUDIO_EXTS.includes(ext)) return "🎵";
  if (ARCHIVE_EXTS.includes(ext)) return "🗜️";
  if (DOC_EXTS.includes(ext)) return "📄";
  return "📦";
}

/** Ionicons-based content-aware icon, and the single source of truth for what
 *  icon a file gets across the app. Multi-file bundles call
 *  `bundleIconName()` instead. */
export function fileIconName(name: string): IconName {
  const ext = fileExt(name);
  if (IMAGE_EXTS.includes(ext)) return "image-outline";
  if (VIDEO_EXTS.includes(ext)) return "videocam-outline";
  if (AUDIO_EXTS.includes(ext)) return "musical-notes-outline";
  if (PDF_EXTS.includes(ext)) return "document-outline";
  if (TEXT_CODE_EXTS.includes(ext)) return "document-text-outline";
  if (ARCHIVE_EXTS.includes(ext)) return "archive-outline";
  // Before EXEC_EXTS, which also contains "apk".
  if (ANDROID_PACKAGE_EXTS.includes(ext)) return "logo-android";
  if (EXEC_EXTS.includes(ext)) return "cog-outline";
  return "document-outline";
}

export function bundleIconName(): IconName {
  return "folder-outline";
}

export function previewModeFor(name: string): PreviewMode {
  const ext = fileExt(name);
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (TEXT_PREVIEW_EXTS.includes(ext)) return "text";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return "unsupported";
}

/** Truncate a filename for display without losing the extension, cutting just
 *  before it so file-type recognition survives. With no extension the ellipsis
 *  goes at the end, and a `maxLen` too short to truncate sensibly returns the
 *  name unchanged. */
export function truncateMiddle(name: string, maxLen: number = 28): string {
  const s = String(name || "");
  if (s.length <= maxLen) return s;
  const ELLIPSIS = "…"; // single-char "…", visually 1 column

  const dot = s.lastIndexOf(".");
  // Treat as "no extension" if there's no dot, the dot is leading, or the
  // "extension" is implausibly long (think "this.is.not.really.an.ext").
  if (dot <= 0 || s.length - dot > 8) {
    if (maxLen <= 1) return s;
    return s.slice(0, maxLen - 1) + ELLIPSIS;
  }

  const ext = s.slice(dot); // includes the leading dot
  // Reserve at least one stem character + ellipsis + extension.
  const stemBudget = maxLen - ext.length - 1; // -1 for ellipsis
  if (stemBudget < 1) return s; // can't truncate sensibly; render full
  return s.slice(0, stemBudget) + ELLIPSIS + ext;
}

/** Human-readable type label combining the file's extension with its
 *  category. Falls back to just the category when the name has no extension,
 *  or "File" when nothing is known. */
export function humanFileType(name: string): string {
  const ext = fileExt(name);
  const extLabel = ext ? ext.charAt(0).toUpperCase() + ext.slice(1) : "";
  const mode = previewModeFor(name);
  const kind =
    mode === "image"
      ? "Photo"
      : mode === "video"
        ? "Video"
        : mode === "audio"
          ? "Audio"
          : mode === "text"
            ? "Document"
            : "File";
  return extLabel ? `${extLabel} ${kind}` : kind;
}

/** Android package archive. Its own constant because it is the one MIME here
 *  with behaviour attached rather than just a label: it is what makes an
 *  `ACTION_VIEW` resolve to the system package installer instead of to
 *  nothing. */
export const APK_MIME = "application/vnd.android.package-archive";

export function mimeFromName(name: string): string {
  const ext = fileExt(name);
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  if (["txt", "md"].includes(ext)) return "text/plain";
  // An ACTION_VIEW carrying "*/*" resolves to nothing useful. Naming the type
  // installs nothing; it lets a package-installer offer itself as a target.
  if (ext === "apk") return APK_MIME;
  if (ext === "zip") return "application/zip";
  if (AUDIO_EXTS.includes(ext)) return "audio/*";
  if (VIDEO_EXTS.includes(ext)) return "video/*";
  return "*/*";
}
