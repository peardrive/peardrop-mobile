import { useSafeAreaInsets } from "react-native-safe-area-context";

// the bottom tab bar is gone. Screens now only need to reserve
// the safe-area bottom inset. Kept the hook name for source compatibility.
export function useMainDockBottomInset(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom;
}
