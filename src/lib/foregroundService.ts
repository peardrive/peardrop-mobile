import { NativeModules, Platform } from "react-native";

import { flush as flushDebugLog, log as debugLog } from "./debugLog";

/**
 * The shipping foreground service: the mechanism that keeps a backgrounded
 * transfer running, for every user, so it is not gated on `IS_DEBUG_BUILD`
 * and asks the user for nothing. Started from the AppState transition into
 * background and never while visible, because that is the path every clean
 * measured run came from. Devices that still stall need the fallback ladder.
 */

/** Shared across these rows so one grep pulls a whole session. */
const TAG = "rn.probe.oem";

type ServiceModule = {
  start: () => Promise<string>;
  stop: () => Promise<string>;
  update: (
    title: string,
    text: string,
    percent: number,
    cancelLabel: string
  ) => Promise<string>;
  drainServiceLog: () => Promise<string[]>;
  drainPendingCancel: () => Promise<boolean>;
  isScreenInteractive: () => Promise<boolean>;
};

/** The event `TransferService` emits when its Cancel action is tapped. Must
 *  match `EVENT_CANCEL_ALL` in TransferService.kt: there is no shared module
 *  across the JS/Kotlin boundary, so this is a matched pair of literals and a
 *  rename has to touch both. */
export const EVENT_CANCEL_ALL = "PeardropCancelAllTransfers";

const native: ServiceModule | undefined = (
  NativeModules as { PeardropTransferService?: ServiceModule }
).PeardropTransferService;

/** Whether this build carries the service at all. True on every Android
 *  build, but kept as a guard because a native module can always fail to
 *  register, and the alternative is an unhandled throw on a path that runs
 *  during backgrounding. */
export function isForegroundServiceAvailable(): boolean {
  return Platform.OS === "android" && !!native;
}

/** Drain what the service recorded about itself into the debug log.
 *  `start()` resolves as soon as the call is accepted, before
 *  `onStartCommand` has run, so it does not prove the service reached
 *  foreground state. Only `TransferService` knows that, and only in logcat. */
export async function drainServiceLog(reason: string): Promise<string[]> {
  if (!native) return [];
  try {
    const lines = await native.drainServiceLog();
    for (const line of lines) {
      const level = line.includes("THREW") ? "error" : "warn";
      debugLog(level, TAG, `fgs-service (${reason}) ${line}`);
    }
    return lines;
  } catch (err: unknown) {
    debugLog(
      "error",
      TAG,
      `fgs-service drain (${reason}) THREW ${String((err as Error)?.message || err)}`
    );
    return [];
  }
}

/** When to drain after an action. `onStartCommand` runs on the main thread a
 *  moment after the call returns, and a
 *  ForegroundServiceStartNotAllowedException surfaces there rather than at
 *  the call site. */
const DRAIN_DELAYS_MS = [400, 1800];

function scheduleDrains(reason: string): void {
  for (const delay of DRAIN_DELAYS_MS) {
    setTimeout(() => void drainServiceLog(`${reason}+${delay}ms`), delay);
  }
}

/** Whether the service is believed to be running. RN-side belief, not ground
 *  truth: the OS can stop a service without saying so, and `onTimeout` does
 *  exactly that. The service's own drained lines are the authority when the
 *  two disagree. */
let believedRunning = false;

export function isServiceBelievedRunning(): boolean {
  return believedRunning;
}

async function callNative(
  action: "start" | "stop",
  reason: string
): Promise<string> {
  if (!native) {
    debugLog("warn", TAG, `fgs ${action} skipped (${reason}) — native module absent`);
    return "unavailable";
  }
  await drainServiceLog(`before-${action}`);
  try {
    const result = await native[action]();
    const level = result.startsWith("error:") ? "error" : "warn";
    debugLog(level, TAG, `fgs ${action} (${reason}) -> ${result} at=${Date.now()}`);
    // Only a clean result updates the belief: an error means the service is
    // not running, and the next freeze would be blamed on it regardless.
    if (!result.startsWith("error:")) {
      believedRunning = action === "start";
    } else if (action === "start") {
      believedRunning = false;
    }
    scheduleDrains(action);
    return result;
  } catch (err: unknown) {
    const message = String((err as Error)?.message || err);
    debugLog("error", TAG, `fgs ${action} (${reason}) THREW ${message} at=${Date.now()}`);
    if (action === "start") believedRunning = false;
    scheduleDrains(action);
    return `threw:${message}`;
  }
}

export function startForegroundService(reason: string): Promise<string> {
  return callNative("start", reason);
}

export async function stopForegroundService(reason: string): Promise<string> {
  believedRunning = false;
  // Drain before releasing the service: stopping it is exactly when the OS
  // becomes free to freeze, so the line explaining the stop is what gets lost.
  await flushDebugLog();
  return callNative("stop", reason);
}

/** Whether the screen was on. `null` when unobtainable — unknown, not false.
 *  Needs no permission, and is used only for freeze attribution rather than
 *  for the service decision, so it may be async and may fail. */
export async function isScreenOn(): Promise<boolean | null> {
  if (!native?.isScreenInteractive) return null;
  try {
    return await native.isScreenInteractive();
  } catch {
    return null;
  }
}

/**
 * Update the ongoing notification's text and progress.
 *
 * The notification must show real progress rather than a static string: a
 * `dataSync` Play declaration is asked what user-visible feature the type
 * serves, and this is a notification users will see often. Silently ignored
 * when the service is not running — Android drops a `notify` for a
 * notification id that no foreground service owns.
 */
export async function updateServiceProgress(
  title: string,
  text: string,
  percent: number,
  cancelLabel: string
): Promise<void> {
  if (!native || !believedRunning) return;
  try {
    await native.update(
      title,
      text,
      Math.max(-1, Math.min(100, Math.round(percent))),
      cancelLabel
    );
  } catch {
    // Never let a notification refresh break a transfer.
  }
}

/**
 * take a Cancel tap that could not be delivered live.
 *
 * The notification's Cancel emits `EVENT_CANCEL_ALL` straight into JS when a
 * ReactContext exists, which is the expected path. This is the fallback for
 * when it does not — the tap is held natively and collected here on the next
 * foreground transition, so a cancel the user pressed cannot silently vanish.
 *
 * Returns false on any failure, including an absent module: a spurious
 * "true" would cancel transfers nobody asked to cancel, which is far worse
 * than missing a queued one.
 */
export async function drainPendingCancel(): Promise<boolean> {
  if (!native?.drainPendingCancel) return false;
  try {
    const pending = await native.drainPendingCancel();
    if (pending) {
      debugLog("warn", TAG, `fgs pending cancel drained at=${Date.now()}`);
    }
    return !!pending;
  } catch (err: unknown) {
    debugLog(
      "error",
      TAG,
      `fgs drainPendingCancel THREW ${String((err as Error)?.message || err)}`
    );
    return false;
  }
}
