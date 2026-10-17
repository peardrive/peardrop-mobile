// `fileKind` imports `fileExt` back from here. The cycle is safe: `fileExt` is
// a hoisted declaration, and nothing below runs at module init.
import { fileKindFor, ICON_BY_KIND } from "./fileKind";

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
// An extension missing here falls through to "unsupported" and `*/*`: a video that neither previews nor opens.
const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp", "3g2"];
const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];
const DOC_EXTS = ["pdf", "doc", "docx", "txt", "md", "rtf", "odt"];
const ARCHIVE_EXTS = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"];
// What the app can render, which is a narrower question than what a file is; the icon's answer comes from the kind module.
const TEXT_PREVIEW_EXTS = ["txt", "md", "json", "csv", "log", "xml", "yaml", "yml"];

export type PreviewMode = "image" | "text" | "video" | "audio" | "unsupported";

export type IconName =
  | "image-outline"
  | "videocam-outline"
  | "musical-notes-outline"
  | "document-text-outline"
  | "document-outline"
  | "archive-outline"
  | "grid-outline"
  | "easel-outline"
  | "cog-outline"
  // The one glyph with no `-outline` twin, verified against the installed glyphmap rather than assumed from the naming.
  | "logo-android"
  | "folder-outline";

/** Emoji-based icon kept for any code path that still wants a glyph; prefer the icon-name lookup for new rendering. */
export function fileIcon(name: string): string {
  const ext = fileExt(name);
  if (IMAGE_EXTS.includes(ext)) return "🖼️";
  if (VIDEO_EXTS.includes(ext)) return "🎬";
  if (AUDIO_EXTS.includes(ext)) return "🎵";
  if (ARCHIVE_EXTS.includes(ext)) return "🗜️";
  if (DOC_EXTS.includes(ext)) return "📄";
  return "📦";
}

/** One icon per file, by kind, and the single source of truth for every surface; multi-file bundles have their own. */
// Delegates to the kind module rather than keeping a second copy of the table, which is how a document landed on the generic glyph.
export function fileIconName(name: string): IconName {
  return ICON_BY_KIND[fileKindFor(name)];
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

/** Truncate a filename for display without losing the extension, cutting from just before it so file-type recognition survives. */
// With no extension the ellipsis goes at the end, and a limit too short to leave room returns the name unchanged.
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

/** A human-readable type label combining the extension with its category, falling back to the category alone when there is no extension. */
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

/** The package-archive type, its own constant because it is the one here with behaviour attached: it is what makes a view intent resolve to the system installer instead of to nothing. */
export const APK_MIME = "application/vnd.android.package-archive";

export function mimeFromName(name: string): string {
  const ext = fileExt(name);
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  if (["txt", "md"].includes(ext)) return "text/plain";
  // A package archive fell through to a wildcard, which resolves to nothing useful, and that is why a received one read as an unrecognised format.
  // Naming the type installs nothing — that needs a permission this app deliberately does not request — it only lets the share sheet and any installer offer themselves as targets.
  if (ext === "apk") return APK_MIME;
  if (ext === "zip") return "application/zip";
  if (AUDIO_EXTS.includes(ext)) return "audio/*";
  if (VIDEO_EXTS.includes(ext)) return "video/*";
  return "*/*";
}
