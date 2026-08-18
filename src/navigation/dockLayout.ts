import { useSafeAreaInsets } from "react-native-safe-area-context";

// With no bottom tab bar, screens only reserve the safe-area bottom inset.
// The hook name is retained for source compatibility.
export function useMainDockBottomInset(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom;
}
