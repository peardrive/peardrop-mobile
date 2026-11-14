/**
 * The order of the three-dots menu, in one place.
 *
 * The menu is built by a long run of conditions in MainScreen, each adding a line when it applies.
 * The order people see is decided here instead, by key, so moving a line is a one-word change and
 * a test can say what the order is.
 */

/** Top to bottom. The last four are the ones that stop, start or remove something. */
export const KEBAB_ORDER = [
  "qr", // "Share": the QR code and the link
  "favorite",
  "open",
  "save-downloads",
  "select-multiple",
  "copy",
  "info",
  "retry",
  "pause-resume", // "Pause" or "Resume": the one line that changes a download's state
  "change-selection",
  "pin",
  "reshare",
  "stop",
  "share", // "Start sharing"
  "delete",
] as const;

const CLOSING = new Set<string>(["reshare", "stop", "share", "delete"]);
const FIRST_CLOSING = KEBAB_ORDER.findIndex((key) => CLOSING.has(key));

function rank(key: string | undefined): number {
  const at = key == null ? -1 : (KEBAB_ORDER as readonly string[]).indexOf(key);
  // A line this list has not heard of goes above the stop, start and remove lines, never below
  // Delete and never in among the everyday ones at the top.
  return at === -1 ? FIRST_CLOSING - 0.5 : at;
}

/** The same lines in the standing order. Lines with the same place keep the order they came in. */
export function orderKebabItems<T extends { key?: string }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, place: rank(item.key) }))
    .sort((a, b) => a.place - b.place || a.index - b.index)
    .map((entry) => entry.item);
}
