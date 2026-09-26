/**
 * `ToastKind`, on its own.
 *
 * Split from `src/ui/Toast.tsx` only so that `src/lib/toastCopy.ts` can name
 * the type without importing a module that pulls in `react-native`,
 * `react-native-safe-area-context` and the theme context — none of which jest
 * can load. `Toast.tsx` re-exports it, so every existing import site is
 * unchanged.
 */
export type ToastKind = "info" | "success" | "error" | "warning";
