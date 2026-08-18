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
const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];
const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];
const DOC_EXTS = ["pdf", "doc", "docx", "txt", "md", "rtf", "odt"];
const TEXT_CODE_EXTS = [
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml",
  "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "hpp", "cs", "sh", "html", "css",
];
const ARCHIVE_EXTS = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"];
const EXEC_EXTS = ["exe", "dmg", "apk", "deb", "app", "msi"];
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
  | "folder-outline";

/**
 * Emoji-based icon, for code paths that want a glyph. Prefer `fileIconName`
 * (Ionicons) for new rendering.
 */
export function fileIcon(name: string): string {
  const ext = fileExt(name);
  if (IMAGE_EXTS.includes(ext)) return "🖼️";
  if (VIDEO_EXTS.includes(ext)) return "🎬";
  if (AUDIO_EXTS.includes(ext)) return "🎵";
  if (ARCHIVE_EXTS.includes(ext)) return "🗜️";
  if (DOC_EXTS.includes(ext)) return "📄";
  return "📦";
}

/**
 * Ionicons content-aware icon — the single source of truth for what icon a
 * file gets across the app. Multi-file bundles call `bundleIconName()`.
 */
export function fileIconName(name: string): IconName {
  const ext = fileExt(name);
  if (IMAGE_EXTS.includes(ext)) return "image-outline";
  if (VIDEO_EXTS.includes(ext)) return "videocam-outline";
  if (AUDIO_EXTS.includes(ext)) return "musical-notes-outline";
  if (PDF_EXTS.includes(ext)) return "document-outline";
  if (TEXT_CODE_EXTS.includes(ext)) return "document-text-outline";
  if (ARCHIVE_EXTS.includes(ext)) return "archive-outline";
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

/**
 * Truncate a filename for display without losing the extension. Cuts from
 * just before the extension so file-type recognition is preserved.
 *
 * Examples (maxLen = 28):
 *   "vacation.jpg" → "vacation.jpg"
 *   "PXL_20260426_192739229.jpg" → "PXL_20260426_19273…jpg"
 *   "really_long_video_name_from_camera.mp4" → "really_long_video_n…mp4"
 *   "no-extension-here-very-long-name" → "no-extension-here-very-l…"
 *
 * If the file has no extension, the ellipsis goes at the end. If maxLen is
 * shorter than 3+ext, returns the unchanged name.
 */
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

/**
 * Human-readable type label combining the file's extension with its
 * category — e.g. "Mp4 Video", "Jpg Photo", "Pdf Document". Used by the
 * File-info modal's Details section. Falls back to just the category when
 * the name has no extension, or "File" when nothing is known.
 */
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

export function mimeFromName(name: string): string {
  const ext = fileExt(name);
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  if (["txt", "md"].includes(ext)) return "text/plain";
  if (AUDIO_EXTS.includes(ext)) return "audio/*";
  if (VIDEO_EXTS.includes(ext)) return "video/*";
  return "*/*";
}
