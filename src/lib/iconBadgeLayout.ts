/** Where the badge goes, as a function of glyph size: below the glyph inside the box, or omitted when there is no room. */
// Absolutely positioned it clipped inside the picker, where the icon box is the glyph's own height.

/** The smallest glyph that can carry a badge beneath it. */
export const BADGE_MIN_GLYPH_PX = 28;

export type IconBadgeLayout = {
  readonly showBadge: boolean;
  /** The badge's own font size. `0` when it is not drawn. */
  readonly fontSize: number;
  /** The icon box's total height, glyph plus the badge's line box. The box grows rather than the badge overlapping, which is the whole fix. */
  readonly boxHeight: number;
};

export function iconBadgeLayout(size: number, hasBadge: boolean): IconBadgeLayout {
  const px = Number.isFinite(size) ? Math.max(0, size) : 0;
  if (!hasBadge || px < BADGE_MIN_GLYPH_PX) {
    return { showBadge: false, fontSize: 0, boxHeight: px };
  }
  // The ratio the overlapping badge already used, so the letters stay the size they have been; only their position changes.
  const fontSize = Math.max(8, Math.round(px * 0.3));
  // `* 1.2` is the line box three uppercase letters need at this size; without
  // it the descender-free glyph still clips on Android.
  return { showBadge: true, fontSize, boxHeight: px + Math.round(fontSize * 1.2) };
}
