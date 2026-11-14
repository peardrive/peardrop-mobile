import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as ScreenOrientation from "expo-screen-orientation";

import {
  screenRotationFor,
  windowOrientationsFor,
  type PlayerKind,
  type RotationLock,
} from "../lib/playerLogic";
import { usePlayerSettings } from "../state/playerSettingsStorage";

/**
 * Turns the screen for the video player and for nothing else.
 *
 * The app is upright everywhere. While a video is open the screen follows the Rotation setting
 * (turn with the phone, stay upright, or stay sideways); the moment the player closes it is put
 * upright again, so the list never shows sideways.
 *
 * Two things have to agree on iPhone: the window the player lives in must allow the direction
 * (`orientations`, given to the modal), and the phone must be asked to turn to it (`lockAsync`).
 * On Android the second is enough.
 */

const LOCK: Record<RotationLock, ScreenOrientation.OrientationLock> = {
  auto: ScreenOrientation.OrientationLock.DEFAULT,
  portrait: ScreenOrientation.OrientationLock.PORTRAIT_UP,
  landscape: ScreenOrientation.OrientationLock.LANDSCAPE,
};

/** One request at a time, in the order they were made: the last one asked is the one that stays. */
let queue: Promise<void> = Promise.resolve();

function turnScreen(lock: RotationLock): void {
  queue = queue
    .then(() => ScreenOrientation.lockAsync(LOCK[lock]))
    .catch(() => {
      // A phone that cannot turn that way stays as it is; the player still works.
    });
}

export function usePlayerRotation(
  open: boolean,
  kind: PlayerKind | null,
): { orientations: ("portrait" | "landscape")[]; onShown: () => void } {
  const { rotation } = usePlayerSettings();
  const lock = screenRotationFor(open, kind, rotation);
  const shown = useRef(false);
  const lockRef = useRef(lock);
  lockRef.current = lock;

  useEffect(() => {
    if (!open) shown.current = false;
  }, [open]);

  useEffect(() => {
    // Upright is always safe to ask for at once. Turning away from upright waits on iPhone until
    // the player is on screen: asked earlier, the list underneath would turn first.
    if (lock === "portrait" || Platform.OS !== "ios" || shown.current) turnScreen(lock);
  }, [lock]);

  // Whatever happens to the screen that hosts the player, the app is left upright.
  useEffect(() => () => turnScreen("portrait"), []);

  const onShown = useCallback(() => {
    shown.current = true;
    turnScreen(lockRef.current);
  }, []);

  return { orientations: windowOrientationsFor(lock), onShown };
}
