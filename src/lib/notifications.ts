import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

import { DEFAULT_THEME_ID, themes } from "../ui/themes";

/**
 * Minimal local-notification layer for peardrop. The only events we care
 * about right now are transfer completions while the app is backgrounded;
 * everything else stays in-app as toasts.
 *
 * Permission is requested lazily on the first attempt. If the user denies,
 * subsequent calls are silently dropped — we never block the transfer flow
 * waiting for OS prompts.
 */

/**
 * The one Android channel this app posts on. Registration
 * (`ensureNotificationsReady`) and scheduling (`notifyTransferComplete`,
 * plus the Settings test row) must use this same constant — a mismatch is
 * silent: Android drops or misfiles the notification with no error.
 */
export const TRANSFER_CHANNEL_ID = "transfers";

/**
 * The accent Android tints the notification's small icon with.
 *
 * Read from the theme rather than restated as a hex, so the notification
 * cannot drift away from the app. `paper` is `DEFAULT_THEME_ID`; a fixed
 * theme is deliberate here — this value is read outside React (and, for
 * the channel, once at boot), so it cannot follow a live theme change, and
 * a notification whose tint depended on when the channel happened to be
 * registered would be worse than one that is simply always brand green.
 *
 * Both accent paths in expo-notifications 55.0.20 take `#RRGGBB`.
 */
export const NOTIFICATION_ACCENT = themes[DEFAULT_THEME_ID].primary;

let configured = false;
let channelReady: Promise<void> | null = null;
let permissionResolved: Promise<boolean> | null = null;

function ensureConfigured() {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Register the notification channel and install the presentation handler.
 *
 * Call once at app boot, above the provider that starts the worklet — the
 * two share no state, so this must not wait on it. Android 8+ silently
 * refuses a notification whose channel doesn't exist, and until this runs
 * there is no channel, so this is the difference between a notification
 * the user sees and one that vanishes.
 *
 * Deliberately does NOT request permission: channel registration is free
 * and needs no consent, while the permission prompt is a interruption that
 * belongs at a moment the user can make sense of (see MainScreen's share
 * funnel). Keeping them apart is what lets the prompt move without
 * touching delivery.
 *
 * Idempotent — the promise is memoised, so repeated calls are one call.
 * `setNotificationChannelAsync` resolves to null off Android, so no
 * platform branch is needed here.
 */
export async function ensureNotificationsReady(): Promise<void> {
  ensureConfigured();
  if (!channelReady) {
    channelReady = (async () => {
      try {
        await Notifications.setNotificationChannelAsync(TRANSFER_CHANNEL_ID, {
          name: "Transfers",
          importance: Notifications.AndroidImportance.DEFAULT,
          // The notification LED / edge-light colour. Distinct
          // from the small-icon tint below — this one is a channel property
          // and Android freezes it at creation, so changing it later needs
          // a channel id change (which is out of scope and would orphan
          // the user's existing per-channel settings).
          enableLights: true,
          lightColor: NOTIFICATION_ACCENT,
        });
      } catch {
        // Best-effort: a channel we couldn't register just means the
        // notification falls back to the system default. Never fatal.
      }
    })();
  }
  return channelReady;
}

export async function ensurePermission(): Promise<boolean> {
  ensureConfigured();
  if (!permissionResolved) {
    permissionResolved = (async () => {
      try {
        const existing = await Notifications.getPermissionsAsync();
        if (existing.granted) return true;
        if (!existing.canAskAgain) return false;
        const res = await Notifications.requestPermissionsAsync();
        return !!res.granted;
      } catch {
        return false;
      }
    })();
  }
  return permissionResolved;
}

/**
 * Fire a local notification. We only show it when the app is NOT in the
 * foreground; foreground completions are already surfaced by the toast and
 * the TransferCard completing its progress fill, so a banner on top would
 * feel double-spammy.
 */
export async function notifyTransferComplete(options: {
  title: string;
  body: string;
}): Promise<void> {
  try {
    if (AppState.currentState === "active") return;
    const ok = await ensurePermission();
    if (!ok) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: options.title,
        body: options.body,
        sound: true,
        // Tints the small icon. ExpoNotificationBuilder resolves
        // `notificationContent.color ?: <manifest meta-data>`, so this wins
        // over the build-time default and works even on a build whose
        // manifest predates the meta-data.
        color: NOTIFICATION_ACCENT,
      },
      // A `null` trigger fires immediately but carries no channel, so
      // Android files the notification under whatever default the library
      // supplies. `{ channelId }` is the documented immediate-delivery
      // trigger that also names the channel — same timing, right bucket.
      trigger: { channelId: TRANSFER_CHANNEL_ID },
    });
  } catch {
    // Best-effort; never let a notification error interrupt UI flow.
  }
}
