import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { fileViewFrom, type FileViewMode } from "../vendor/pearkit/FileViews/fileViewLogic";

/**
 * How the list of shares is shown: list, expanded list or grid. It stays as it was left, across
 * launches. One copy in memory, the same pattern as the player settings.
 */

const STORAGE_KEY = "peardrop.file-view";

/** The views this app offers, out of the ones Pearkit has. */
export const FILE_VIEW_MODES: readonly FileViewMode[] = ["list", "expanded", "grid"];

let current: FileViewMode = fileViewFrom(null, FILE_VIEW_MODES);
let hydrating: Promise<void> | null = null;
/** Set once the user chooses, so a slow first read cannot undo the choice. */
let touched = false;
const listeners = new Set<() => void>();

function publish(next: FileViewMode) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Read what was saved. Safe to call any number of times. */
export function hydrateFileView(): Promise<void> {
  if (!hydrating) {
    hydrating = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!touched) publish(fileViewFrom(raw, FILE_VIEW_MODES));
      })
      .catch(() => {
        // Nothing saved that can be read: the expanded list stands.
      });
  }
  return hydrating;
}

export function getFileView(): FileViewMode {
  return current;
}

export function setFileView(mode: FileViewMode): void {
  touched = true;
  const next = fileViewFrom(mode, FILE_VIEW_MODES);
  publish(next);
  // Saving is best-effort; the copy in memory already holds the choice for this launch.
  AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFileView(): FileViewMode {
  return useSyncExternalStore(subscribe, getFileView, getFileView);
}

// Read at start, so the list opens in the view it was left in.
void hydrateFileView();
