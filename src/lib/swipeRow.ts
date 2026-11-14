/**
 * The decisions a swiped row makes, kept free of react-native so jest can reach them.
 *
 * A row rests at 0. Dragged left it uncovers Delete (and far enough left, deletes). Dragged right
 * from rest it travels a short way and, let go past the mark, selects the row.
 */

/** Width of the Delete button a left swipe uncovers. */
export const REVEAL_WIDTH = 96;
/** How far a row can be pulled to the right. */
export const SELECT_WIDTH = 72;
/** Let go at or past this far right and the row is selected. */
export const SELECT_AT = 44;

const REVEAL_AT = -REVEAL_WIDTH * 0.4;
const DELETE_AT = -REVEAL_WIDTH * 1.6;

/** Sideways travel before the row takes the finger from the list. */
export const CLAIM_DISTANCE = 8;
/** How much more sideways than up-and-down the finger must be going. */
export const CLAIM_SLANT = 1.2;

/**
 * Is this finger swiping the row rather than scrolling the list?
 *
 * Asked on every move until it answers yes. Answering early matters because a swipe made with a
 * thumb is never level, and the list takes the finger for itself once it has drifted about 8 to
 * 10 points up or down. On Android a row that has already answered yes keeps the finger. On
 * iPhone it does not, which is why the row also stops the list scrolling while it is being swiped
 * (`onSwipeActive` in SwipeableRow); this rule only makes the window before that as short as it
 * can be without taking a scroll for a swipe.
 */
export function wantsSwipe(dx: number, dy: number): boolean {
  const across = Math.abs(dx);
  return across > CLAIM_DISTANCE && across > Math.abs(dy) * CLAIM_SLANT;
}

/**
 * How far the row may follow the finger, given where it was resting (`offset`: 0, or minus the
 * Delete width when Delete is already uncovered).
 *
 * Left is free. Right stops at rest, unless the row was at rest and can be selected, in which case
 * it stops a short way out.
 */
export function swipeTravel(offset: number, dx: number, canSelect: boolean): number {
  const furthestRight = canSelect && offset === 0 ? SELECT_WIDTH : 0;
  return Math.min(furthestRight - offset, dx);
}

export type SwipeOutcome = "delete" | "reveal" | "select" | "rest";

/** What letting go means. */
export function swipeRelease(offset: number, dx: number, canSelect: boolean): SwipeOutcome {
  const final = offset + swipeTravel(offset, dx, canSelect);
  if (final < DELETE_AT) return "delete";
  if (final < REVEAL_AT) return "reveal";
  if (canSelect && offset === 0 && final >= SELECT_AT) return "select";
  return "rest";
}
