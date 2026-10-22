/**
 * Toast copy, split out of `Toast.tsx` so jest can load it — copy no test can read asserts whatever
 * it likes. It claims nothing the app cannot establish: no connectivity detection, no link expiry.
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
