/** What kind of file a name says it is, and the one icon for it; split from the icon so the badge has something to key on. */
// Extension-only: nothing here opens a file or trusts a mime type a peer sent.
import { fileExt, type IconName } from "./files";

export type FileKind =
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "document"
  | "spreadsheet"
  | "slides"
  | "androidPackage"
  | "executable"
  | "other";

/** Extension to kind, first match wins, and the order is the only thing that resolves an extension claimed by two lists. */
// Some text extensions sit under document or spreadsheet here while the preview decision still treats them as text, deliberately: what a file looks like in a list and what the app can render are different questions.
const KIND_BY_EXT: readonly (readonly [FileKind, readonly string[]])[] = [
  ["pdf", ["pdf"]],
  ["image", ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"]],
  ["video", ["mp4", "mov", "mkv", "webm", "avi", "m4v", "3gp", "3g2"]],
  ["audio", ["mp3", "m4a", "wav", "ogg", "flac", "aac", "opus"]],
  ["archive", ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]],
  ["spreadsheet", ["xls", "xlsx", "csv"]],
  ["slides", ["ppt", "pptx"]],
  // Before `executable`, which also contains apk: the phone the user is
  // holding can install one, and a cog said nothing about that.
  ["androidPackage", ["apk"]],
  ["executable", ["exe", "dmg", "deb", "app", "msi"]],
  [
    "document",
    [
      "doc", "docx", "txt", "rtf", "odt", "md", "json", "log", "xml", "yaml",
      "yml", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
      "swift", "c", "h", "cpp", "hpp", "cs", "sh", "html", "css",
    ],
  ],
];

/** Case-insensitive, because an extension is not a statement about case. */
export function fileKindFor(name: string): FileKind {
  const ext = fileExt(name);
  if (!ext) return "other";
  for (const [kind, exts] of KIND_BY_EXT) {
    if (exts.includes(ext)) return kind;
  }
  return "other";
}

/** Every icon here is checked against the installed glyph map by its test. */
export const ICON_BY_KIND: Readonly<Record<FileKind, IconName>> = {
  pdf: "document-text-outline",
  image: "image-outline",
  video: "videocam-outline",
  audio: "musical-notes-outline",
  archive: "archive-outline",
  document: "document-text-outline",
  spreadsheet: "grid-outline",
  slides: "easel-outline",
  androidPackage: "logo-android",
  executable: "cog-outline",
  other: "document-outline",
};

/** Only one kind carries a text badge: the glyph it shares with the generic document is what made it unrecognisable, and the three letters are what fix that. */
export function fileKindBadge(kind: FileKind): string | null {
  return kind === "pdf" ? "PDF" : null;
}
