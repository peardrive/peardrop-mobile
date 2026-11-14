import { useContext, useMemo } from "react";
import { Dimensions, Platform } from "react-native";
import { initialWindowMetrics, useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { InsideModal } from "./AppModal";

/**
 * The edges of the screen itself (status bar and camera cut-out, home bar), for anything drawn
 * inside a modal.
 *
 * The app's pages sit inside the safe area already: expo-router's default layout wraps them in a
 * SafeAreaView, so on a page `useSafeAreaInsets()` reads zero, and that is right there. A modal
 * is different: on iPhone it covers the whole screen, clock and home bar included, and the same
 * zero puts its buttons under the clock, where they are hard to see and to tap. So:
 *
 * - on a page, keep using `useSafeAreaInsets()`;
 * - for the contents of a modal, use `useScreenInsets()`;
 * - for a piece that is mounted in both places (the toast), use `useInsetsHere()`.
 *
 * These are the edges of the screen held upright: the largest reading taken while upright. Only
 * the video player turns sideways; it works its own edges out from these (`playerEdges`), and a
 * reading taken while it is sideways is ignored here, or every other modal would keep a wide
 * margin down each side afterwards.
 * Android keeps the live reading it shipped with until this has been looked at on an Android phone.
 */
const largest: EdgeInsets = {
  top: initialWindowMetrics?.insets.top ?? 0,
  bottom: initialWindowMetrics?.insets.bottom ?? 0,
  left: initialWindowMetrics?.insets.left ?? 0,
  right: initialWindowMetrics?.insets.right ?? 0,
};

export function useScreenInsets(): EdgeInsets {
  const live = useSafeAreaInsets();
  const window = Dimensions.get("window");
  if (window.height >= window.width) {
    largest.top = Math.max(largest.top, live.top);
    largest.bottom = Math.max(largest.bottom, live.bottom);
    largest.left = Math.max(largest.left, live.left);
    largest.right = Math.max(largest.right, live.right);
  }
  const { top, bottom, left, right } = largest;
  const screen = useMemo(() => ({ top, bottom, left, right }), [top, bottom, left, right]);
  return Platform.OS === "ios" ? screen : live;
}

/** The right edges wherever this is mounted: the screen's inside a modal, the page's outside one. */
export function useInsetsHere(): EdgeInsets {
  const inModal = useContext(InsideModal);
  const live = useSafeAreaInsets();
  const screen = useScreenInsets();
  return inModal ? screen : live;
}
