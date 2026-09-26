/**
 * The curated toast copy, split out of `src/ui/Toast.tsx` so it can be tested:
 * `Toast.tsx` imports `react-native` and the theme context, so jest cannot
 * load it, and copy that no test can read asserts whatever it likes.
 * `Toast.tsx` re-exports everything here, so its importers are unaffected.
 *
 * The copy claims nothing the app cannot establish: no connectivity detection
 * exists here, links do not expire, and "the host is offline" is
 * indistinguishable from "discovery is still running".
 */

import type { ToastKind } from "./toastKind";

export type ToastVariantId =
  | "no-connection"
  | "peer-not-found"
  | "file-unavailable"
  | "something-wrong";

export type ToastVariant = {
  title: string;
  body: string;
  kind: ToastKind;
};

export const TOAST_VARIANTS: Record<ToastVariantId, ToastVariant> = {
  "no-connection": {
    title: "Couldn't connect",
    body: "Nothing answered. Give it another go?",
    kind: "error",
  },
  "peer-not-found": {
    title: "Still looking",
    body: "Haven't found the other pear yet. Give it another go?",
    kind: "warning",
  },
  "file-unavailable": {
    title: "File unavailable",
    body: "The file couldn't be reached right now.",
    kind: "warning",
  },
  "something-wrong": {
    title: "Something went wrong",
    body: "We hit an unexpected snag. Try again in a moment.",
    kind: "error",
  },
};
