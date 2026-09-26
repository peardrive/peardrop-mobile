import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

import { log as debugLog } from "./debugLog";
import { DEFAULT_THEME_ID, themes } from "../ui/themes";

/**
 * Minimal local-notification layer for peardrop. The only events we care
 * about right now are transfer completions while the app is backgrounded;
 * everything else stays in-app as toasts.
 *
 * permission is requested ONLY from the
 * foreground, off a user gesture — `ensurePermission`. The posting path
 * (`notifyTransferComplete`) reads the permission and never asks for it. If the
 * user denies, subsequent calls are silently dropped — we never block the
 * transfer flow waiting for OS prompts.
 */

/**
 * The one Android channel this app posts on. Registration
 * (`ensureNotificationsReady`) and scheduling (`notifyTransferComplete`,
 * plus the Settings test row) must use this same constant — a mismatch is
 * silent: Android drops or misfiles the notification with no error.
 */
export const TRANSFER_CHANNEL_ID = "transfers";

/**
 * the accent Android tints the notification's small icon with.
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
          // the notification LED / edge-light colour. Distinct
          // from the small-icon tint below — this one is a channel property
          // and Android freezes it at creation, so changing it later needs
          // a channel id change, which would orphan the user's existing
          // per-channel settings.
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

/**
 * Ask the OS for POST_NOTIFICATIONS, prompting if it can.
 *
 * **this function prompts, so it may only be
 * called from the foreground, off a user gesture.** The two product call sites
 * are the share-creation funnel (`MainScreen.tsx`, `sharePaths` returned ok)
 * and the Grab confirm (`ShareLinkFlowContext.tsx`, `runDownload`). Both are a
 * tap the user just made, with the app in front of them. Nothing on a
 * background path may call this — see `notifyTransferComplete` below, which
 * reads the permission without prompting.
 *
 * Every outcome goes through `debugLog`, not `console.warn`: only `debugLog`
 * reaches the exported log, and "was the dialog ever shown, and what did they
 * answer" is the question a permission report turns on.
 *
 * The result is memoised for the process lifetime (`permissionResolved`), so a
 * denial is terminal until the process restarts. That is deliberate — the ask
 * is one interruption per launch — but it is also why the background read below
 * must not go through here: a backstop that populated this memo would silently
 * consume the one ask the foreground path is entitled to.
 */
export async function ensurePermission(): Promise<boolean> {
  ensureConfigured();
  if (!permissionResolved) {
    permissionResolved = (async () => {
      try {
        const existing = await Notifications.getPermissionsAsync();
        if (existing.granted) {
          debugLog("info", "rn.notify", "permission already granted");
          return true;
        }
        if (!existing.canAskAgain) {
          debugLog(
            "warn",
            "rn.notify",
            "permission not granted and the OS will not show the prompt again",
          );
          return false;
        }
        const res = await Notifications.requestPermissionsAsync();
        debugLog(
          "info",
          "rn.notify",
          `permission prompt shown granted=${!!res.granted}`,
        );
        return !!res.granted;
      } catch {
        debugLog("warn", "rn.notify", "permission check threw; treating as denied");
        return false;
      }
    })();
  }
  return permissionResolved;
}

/**
 * Read the permission WITHOUT prompting, and without touching the memo.
 *
 * The old `notifyTransferComplete` called
 * `ensurePermission` from a position the `AppState === "active"` early return
 * guarantees is backgrounded — so the only ask a receive-only user could ever
 * get was an OS dialog thrown over whatever app they were actually using, at
 * the moment they are least able to make sense of it. The adjacent comment in
 * `MainScreen.tsx` already called that "the worst moment to ask and a likely
 * denial"; the code here did it anyway.
 *
 * Deliberately does not populate `permissionResolved`: a background completion
 * must leave the foreground ask untouched and unspent.
 */
async function hasPermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    return !!existing.granted;
  } catch {
    return false;
  }
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
    // a READ, never an ask. See
    // `hasPermission` for why this cannot be `ensurePermission`.
    const ok = await hasPermission();
    if (!ok) {
      debugLog(
        "warn",
        "rn.notify",
        "completion notification dropped: POST_NOTIFICATIONS not granted " +
          "(no prompt from the background — the foreground asks are the " +
          "share funnel and the Grab confirm)",
      );
      return;
    }
    await Notifications.scheduleNotificationAsync({
      content: {
        title: options.title,
        body: options.body,
        sound: true,
        // tints the small icon. ExpoNotificationBuilder resolves
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
