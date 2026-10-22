/**
 * A total function over the row's state with no tone input at all: a tone that is not a parameter
 * cannot re-acquire a destructive action by accident.
 */

/** No `"stop"` member, deliberately: a row-level control that stops a share has to widen the
 *  union, which is a visible change rather than a flipped boolean. */
export type FolderRowControl =
  | { kind: "none" }
  | { kind: "open"; accessibilityLabel: string };

/** `hasLocalCopy` is the whole decision: a per-file control may only open that file, so a row with
 *  nothing on disk gets no control. */
export function folderRowControl(args: {
  fileName: string;
  hasLocalCopy: boolean;
}): FolderRowControl {
  const { fileName, hasLocalCopy } = args;
  if (!hasLocalCopy) return { kind: "none" };
  return { kind: "open", accessibilityLabel: `Open ${fileName} in another app` };
}
