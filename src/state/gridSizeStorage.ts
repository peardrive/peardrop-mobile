import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  DEFAULT_GRID_SIZE,
  gridSizeFrom,
  type GridSize,
} from "../vendor/pearkit/FileViews/fileViewLogic";

/**
 * How big the pictures in the grid are: Large (3 across), Medium (4) or Small (5). Chosen in
 * Settings → Appearance and kept across launches. The sizes and their names are Pearkit's, so
 * every app offers the same three. One copy in memory, the same pattern as the list view.
 */

const STORAGE_KEY = "peardrop.grid-size";

let current: GridSize = DEFAULT_GRID_SIZE;
let hydrating: Promise<void> | null = null;
/** Set once the user chooses, so a slow first read cannot undo the choice. */
let touched = false;
const listeners = new Set<() => void>();

function publish(next: GridSize) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Read what was saved. Safe to call any number of times. */
export function hydrateGridSize(): Promise<void> {
  if (!hydrating) {
    hydrating = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!touched) publish(gridSizeFrom(raw));
      })
      .catch(() => {
        // Nothing saved that can be read: Medium stands.
      });
  }
  return hydrating;
}

export function getGridSize(): GridSize {
  return current;
}

export function setGridSize(size: GridSize): void {
  touched = true;
  const next = gridSizeFrom(size);
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

export function useGridSize(): GridSize {
  return useSyncExternalStore(subscribe, getGridSize, getGridSize);
}

// Read at start, so the grid opens at the size it was left at.
void hydrateGridSize();
