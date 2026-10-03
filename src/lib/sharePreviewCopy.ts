/**
 * The share picker's three strings.
 *
 * None of them was a function before. The file count's pluralisation was an
 * inline JSX ternary — real logic no test could reach, which is also how
 * "Grab everything" came to be the label for a one-file share. The total size
 * never appeared at all, though `openResult.totalBytes` was already populated
 * on both paths.
 *
 * Here rather than in the `.tsx` for the Amendment A-3 reason: jest renders no
 * component in this project, so copy left in a component is copy no deny-list
 * can see.
 */
import { formatBytes, formatBytesOrUnknown } from "./format";

/** Shown only when picking one of several is actually possible. */
export const PREVIEW_PICK_ONE_HINT = "Tap any file to grab just that one";

/**
 * "1 file · 33.1 MB" / "4 files · 2.0 KB".
 *
 * `formatBytesOrUnknown`, NOT `formatBytes`: a manifest can arrive with no
 * sizes, and "1 file · 0 B" claims the share is empty when all we know is that
 * nobody told us how big it is.
 */
export function previewSubtitle(
  fileCount: number,
  totalBytes?: number | null,
): string {
  const noun = fileCount === 1 ? "file" : "files";
  return `${fileCount} ${noun} · ${formatBytesOrUnknown(totalBytes)}`;
}

/**
 * The pick-one hint, or null.
 *
 * Hidden for a single file (there is no "just that one" to pick) and hidden
 * while Grab is disabled, where it would invite a tap that cannot work.
 */
export function previewHint(
  fileCount: number,
  grabEnabled: boolean,
): string | null {
  if (!grabEnabled) return null;
  if (fileCount < 2) return null;
  return PREVIEW_PICK_ONE_HINT;
}

/**
 * The Grab button's label in the `found` state.
 *
 * `formatBytes` here, not `formatBytesOrUnknown`: these rows were ticked by
 * the user, so a dash would hide a real sum of real sizes.
 */
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
