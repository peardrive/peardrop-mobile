import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/**
 * Thin wrapper over expo-haptics so callers don't have to guard every call
 * with platform checks. expo-haptics already no-ops on web; this layer adds
 * try/catch so a device that lacks a taptic engine can't crash the render.
 *
 * The event names are phrased around user intent ("actionDone") instead of
 * the raw pattern ("light impact") so we can retune the feel in one place
 * without chasing call sites.
 */

const unsupported = Platform.OS === "web";

function safeImpact(style: Haptics.ImpactFeedbackStyle): void {
  if (unsupported) return;
  try {
    void Haptics.impactAsync(style);
  } catch {
    // ignore: some devices (emulator, iPod touch) lack haptic hardware
  }
}

function safeNotify(type: Haptics.NotificationFeedbackType): void {
  if (unsupported) return;
  try {
    void Haptics.notificationAsync(type);
  } catch {
    // ignore
  }
}

export const haptics = {
  /** Completed an action the user initiated (copy, add, clear, tap toggle). */
  actionDone() {
    safeImpact(Haptics.ImpactFeedbackStyle.Light);
  },
  /** Selection changes in pickers / list checkmarks. */
  selection() {
    if (unsupported) return;
    try {
      void Haptics.selectionAsync();
    } catch {
      /* ignore */
    }
  },
  /** A meaningful positive milestone (transfer complete, share created). */
  success() {
    safeNotify(Haptics.NotificationFeedbackType.Success);
  },
  /** Non-fatal warning (timeouts, soft failures). */
  warning() {
    safeNotify(Haptics.NotificationFeedbackType.Warning);
  },
  /** Hard failure (download failed, link invalid). */
  error() {
    safeNotify(Haptics.NotificationFeedbackType.Error);
  },
};
