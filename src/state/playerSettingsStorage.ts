import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  DEFAULT_PLAYER_SETTINGS,
  parsePlayerSettings,
  serializePlayerSettings,
  type PlayerSettings,
} from "../lib/playerLogic";

/**
 * The two player settings that stay as they were left, for every file and across launches:
 * Loop and Rotation. One copy in memory, shared by the player and the screen that hosts it.
 */

const STORAGE_KEY = "peardrop.player-settings";

let current: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS };
let hydrating: Promise<void> | null = null;
/** Set once the user changes something, so a slow first read cannot undo it. */
let touched = false;
const listeners = new Set<() => void>();

function publish(next: PlayerSettings) {
  if (next.loop === current.loop && next.rotation === current.rotation) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Read what was saved. Safe to call any number of times. */
export function hydratePlayerSettings(): Promise<void> {
  if (!hydrating) {
    hydrating = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!touched) publish(parsePlayerSettings(raw));
      })
      .catch(() => {
        // Nothing saved that can be read: the defaults stand.
      });
  }
  return hydrating;
}

export function getPlayerSettings(): PlayerSettings {
  return current;
}

export function setPlayerSettings(patch: Partial<PlayerSettings>): void {
  touched = true;
  const next = parsePlayerSettings(serializePlayerSettings({ ...current, ...patch }));
  publish(next);
  // Saving is best-effort; the copy in memory already holds the choice for this launch.
  AsyncStorage.setItem(STORAGE_KEY, serializePlayerSettings(next)).catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePlayerSettings(): PlayerSettings {
  return useSyncExternalStore(subscribe, getPlayerSettings, getPlayerSettings);
}

// Read at start, so the first video already opens the way the last one was left.
void hydratePlayerSettings();
