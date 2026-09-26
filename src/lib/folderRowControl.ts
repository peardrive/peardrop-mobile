/**
 * What the right-hand control on a folder-modal row may be. Decided here, and
 * deliberately as a total function over the row's state with no tone input at
 * all: a status tone once reached a whole-share stop through this control, and
 * a tone that is not a parameter cannot re-acquire a destructive action by
 * accident. That is stronger than a ladder that happens not to produce one.
 */

/** The right-hand control on one folder-contents row. There is deliberately
 *  no `"stop"` member: reintroducing a row-level control that stops a share
 *  has to widen the union, which is a visible change rather than a flipped
 *  boolean. */
export type FolderRowControl =
  | { kind: "none" }
  | { kind: "open"; accessibilityLabel: string };

/** Decide the control for a row. `hasLocalCopy` is the whole decision: the
 *  only thing a per-file control may do is open that file, so a row with
 *  nothing on disk yet — a child being received right now, or one never
 *  grabbed — gets no control at all. */
export function folderRowControl(args: {
  fileName: string;
  hasLocalCopy: boolean;
}): FolderRowControl {
  const { fileName, hasLocalCopy } = args;
  if (!hasLocalCopy) return { kind: "none" };
  return { kind: "open", accessibilityLabel: `Open ${fileName} in another app` };
}
