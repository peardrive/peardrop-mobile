/**
 * Which colour the looking indicator draws in.
 *
 * The rings and the tinted pear sit on `surfaceSubtle`, a translucent layer
 * over `bg`. `theme.primary` measures 1.53:1 on `pear` and 1.63:1 on `paper`
 * against that composite — well under WCAG 1.4.11's 3:1 floor for non-text
 * graphics, and `paper` is the default theme.
 *
 * The fallback is `primaryMuted`, NOT `text`: a black pear is legible and wrong.
 * `primaryMuted` is the brand's own deeper green on both failing themes
 * (`#4d7c0f`, 4.25 / 4.12 — picked for light surfaces by an earlier contrast
 * audit, `themes.ts:140-142`) and clears 3:1 on all 11, worst 3.41 on `slate`.
 *
 * Computed rather than tabulated per theme, so a future theme cannot quietly
 * ship an invisible indicator.
 */
import type { AppTheme } from "../ui/themes";

/** WCAG 1.4.11: non-text graphics need 3:1 against what they sit on. */
const NON_TEXT_CONTRAST_FLOOR = 3;

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(color: string): Rgba {
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    return {
      r: parseInt(short[1]! + short[1]!, 16),
      g: parseInt(short[2]! + short[2]!, 16),
      b: parseInt(short[3]! + short[3]!, 16),
      a: 1,
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) {
    return {
      r: parseInt(long[1]!, 16),
      g: parseInt(long[2]!, 16),
      b: parseInt(long[3]!, 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(hex);
  if (rgba) {
    const parts = rgba[1]!.split(",").map((p) => Number(p.trim()));
    return {
      r: parts[0] ?? 0,
      g: parts[1] ?? 0,
      b: parts[2] ?? 0,
      a: parts[3] === undefined ? 1 : parts[3],
    };
  }
  // Unparseable: treat as opaque black, the conservative end. A colour we
  // cannot measure must not be allowed to score well.
  return { r: 0, g: 0, b: 0, a: 1 };
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function composite(over: Rgba, under: Rgba): Rgba {
  return {
    r: over.r * over.a + under.r * (1 - over.a),
    g: over.g * over.a + under.g * (1 - over.a),
    b: over.b * over.a + under.b * (1 - over.a),
    a: 1,
  };
}

function luminanceOf(rgba: Rgba): number {
  return (
    0.2126 * channelLuminance(rgba.r) +
    0.7152 * channelLuminance(rgba.g) +
    0.0722 * channelLuminance(rgba.b)
  );
}

/**
 * `bg` may be translucent, in which case `under` is what it sits on. Without
 * that composite step a `rgba(255,255,255,0.03)` surface would measure as
 * near-white on a near-black screen.
 */
export function contrastRatio(fg: string, bg: string, under?: string): number {
  const surface = under
    ? composite(parseColor(bg), parseColor(under))
    : parseColor(bg);
  const front = composite(parseColor(fg), surface);
  const a = luminanceOf(front);
  const b = luminanceOf(surface);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export function indicatorColor(theme: AppTheme): string {
  const ratio = contrastRatio(theme.primary, theme.surfaceSubtle, theme.bg);
  return ratio >= NON_TEXT_CONTRAST_FLOOR ? theme.primary : theme.primaryMuted;
}
