/**
 * The share picker's three strings, as functions. Copy left inline in a component is copy no
 * deny-list can see, and the file-count pluralisation was real logic no test could reach.
 */
import { formatBytes, formatBytesOrUnknown } from "./format";

/** Shown only when picking one of several is actually possible. */
export const PREVIEW_PICK_ONE_HINT = "Tap any file to grab just that one";

/**
 * `formatBytesOrUnknown`, NOT `formatBytes`: a manifest can arrive with no sizes, and
 * "1 file · 0 B" claims the share is empty when all we know is that nobody told us the size.
 */
export function previewSubtitle(
  fileCount: number,
  totalBytes?: number | null,
): string {
  const noun = fileCount === 1 ? "file" : "files";
  return `${fileCount} ${noun} · ${formatBytesOrUnknown(totalBytes)}`;
}

/** Hidden for a single file, and while Grab is disabled where it would invite a tap that cannot work. */
export function previewHint(
  fileCount: number,
  grabEnabled: boolean,
): string | null {
  if (!grabEnabled) return null;
  if (fileCount < 2) return null;
  return PREVIEW_PICK_ONE_HINT;
}

/** `formatBytes` here, not `formatBytesOrUnknown`: these rows were ticked, so a dash would hide a real sum. */
export function previewPrimaryLabel(args: {
  fileCount: number;
  selectedCount: number;
  selectedBytes: number;
}): string {
  if (args.selectedCount > 0) {
    return `Grab ${args.selectedCount} (${formatBytes(args.selectedBytes)})`;
  }
  return args.fileCount === 1 ? "Grab" : "Grab everything";
}
