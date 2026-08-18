import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

/**
 * Minimal local-notification layer for peardrop. The only events we care
 * about right now are transfer completions while the app is backgrounded;
 * everything else stays in-app as toasts.
 *
 * Permission is requested lazily on the first attempt. If the user denies,
 * subsequent calls are silently dropped — we never block the transfer flow
 * waiting for OS prompts.
 */

let configured = false;
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

async function ensurePermission(): Promise<boolean> {
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
      },
      trigger: null,
    });
  } catch {
    // Best-effort; never let a notification error interrupt UI flow.
  }
}
