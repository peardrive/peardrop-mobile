import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAppTheme } from "../state/ThemeContext";
import { fileKindBadge, fileKindFor } from "../lib/fileKind";
import { fileIconName } from "../lib/files";
import { iconBadgeLayout } from "../lib/iconBadgeLayout";

/** One file's glyph, plus the badge for the kinds that share one; the kind and badge decisions are other modules'. */
export default function FileTypeIcon({
  name,
  size = 28,
  color,
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  const { theme } = useAppTheme();
  const tint = color ?? theme.text;
  const badge = badgeForName(name);
  const layout = iconBadgeLayout(size, !!badge);
  return (
    <View style={[styles.wrap, { height: layout.boxHeight }]}>
      <Ionicons name={fileIconName(name)} size={size} color={tint} />
      <FileKindBadge text={badge} size={size} color={tint} />
    </View>
  );
}

/** The badge a name earns, or null. Exported so a row that already has an
 * icon name can add the badge without re-deriving the kind. */
export function badgeForName(name: string): string | null {
  return fileKindBadge(fileKindFor(name));
}

/** Drawn below the glyph in normal flow, so the box reports its real height and no surface can clip the letters. */
// Absolutely positioned it read fine on the row's larger tile and clipped inside the picker, where the box is glyph-height.
export function FileKindBadge({
  text,
  size,
  color,
}: {
  text: string | null;
  size: number;
  color: string;
}) {
  const layout = iconBadgeLayout(size, !!text);
  if (!layout.showBadge) return null;
  return (
    <Text
      style={[styles.badge, { color, fontSize: layout.fontSize }]}
      numberOfLines={1}
      // Decorative: the file name beside it already says what this is.
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {text}
    </Text>
  );
}

// Theme-free, so it is created once rather than per render.
const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  badge: {
    fontWeight: "800",
    letterSpacing: -0.3,
    // A tight line box: the three letters have no descenders, and the default
    // Android line height would add a gap the icon box did not budget for.
    includeFontPadding: false,
  },
});
