import { useSafeAreaInsets } from "react-native-safe-area-context";

// There is no bottom tab bar. Screens only need to reserve
// the safe-area bottom inset. Kept the hook name for source compatibility.
export function useMainDockBottomInset(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom;
}
