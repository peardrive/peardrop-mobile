import { NativeModules, Platform } from "react-native";

import { flush as flushDebugLog, log as debugLog } from "./debugLog";

/**
 * the shipping foreground service.
 *
 * Promoted from 6R's spike / 7D's harness. This is no longer gated on
 * `IS_DEBUG_BUILD`: the service is the mechanism that keeps a backgrounded
 * transfer running, on every device, for every user.
 *
 * ## What the measurements said
 *
 * Screen locked, unplugged, phone untouched, 2026-09-13:
 *
 *   Redmi (clean install, Autostart OFF)  ran-normally  425/~424 ticks, 2.0 s max gap
 *   Redmi (re-run,        Autostart OFF)  ran-normally  308/~309 ticks, 2.0 s max gap
 *   Samsung S21 FE                        ran-normally  228/~396 ticks,  31 s max gap
 *   Samsung (third)                       ran-normally  213/~283 ticks, 7.2 s max gap
 *   Samsung S24 Ultra                     ran-normally   52/~312 ticks,  75 s max gap
 *
 * On the Redmi the service is BETTER than the Autostart permission, which
 * had a 29 s gap in its own screen-locked run. That is what retires 7A/7B's
 * permission-first surface: this asks the user for nothing.
 *
 * The Samsung numbers are the reason Phase 3's fallback exists. Every one is
 * `ran-normally`, and three of them are nowhere near clean.
 *
 * ## Start from background, never while visible
 *
 * Every clean run above came from the AppState → background path. The
 * foreground-start arm froze at 60% on the S24 Ultra. Arm and device are not
 * fully separated in that comparison, so this follows the measured-good path
 * rather than claiming to explain it.
 */

/** Shared with the 7D harness rows so one grep pulls a whole session. */
const TAG = "rn.probe.oem";

type ServiceModule = {
  start: () => Promise<string>;
  stop: () => Promise<string>;
  update: (title: string, text: string, percent: number) => Promise<string>;
  drainServiceLog: () => Promise<string[]>;
  isScreenInteractive: () => Promise<boolean>;
};

const native: ServiceModule | undefined = (
  NativeModules as { PeardropTransferService?: ServiceModule }
).PeardropTransferService;

/**
 * Whether this build carries the service at all.
 *
 * As of 8A the `<service>` element is in the real `main` manifest and the
 * package is registered unconditionally, so this is true on every Android
 * build. It stays as a guard because a native module can always fail to
 * register, and the alternative is an unhandled throw on a path that runs
 * during backgrounding.
 */
export function isForegroundServiceAvailable(): boolean {
  return Platform.OS === "android" && !!native;
}

/**
 * Drain what the service recorded about itself into the debug log.
 *
 * `start()` resolves as soon as `startForegroundService` returns — BEFORE
 * `onStartCommand` has run — so its "started" string proves the call was
 * accepted, not that the service reached foreground state. Only
 * `TransferService` knows that, and it only says so to logcat, which never
 * reaches an exported log. This is the bridge.
 */
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

/**
 * When to drain after an action. `onStartCommand` runs on the main thread a
 * moment after the call returns, and a ForegroundServiceStartNotAllowedException
 * surfaces there rather than at the call site.
 */
const DRAIN_DELAYS_MS = [400, 1800];

function scheduleDrains(reason: string): void {
  for (const delay of DRAIN_DELAYS_MS) {
    setTimeout(() => void drainServiceLog(`${reason}+${delay}ms`), delay);
  }
}

/**
 * Whether we believe the service is running.
 *
 * RN-side belief, not ground truth — the OS can stop a service without
 * telling us, and `onTimeout` does exactly that. Used to avoid redundant
 * start/stop calls and, in Phase 3, to attribute a freeze. The service's own
 * drained lines are the authority when the two disagree.
 */
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
    // Only a clean result updates the belief. An
    // "error:ForegroundServiceStartNotAllowedException:…" means the service
    // is NOT running, and recording otherwise would mis-attribute the next
    // freeze to a mechanism that never engaged.
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
  // drain the debug buffer BEFORE releasing the service.
  //
  // The caller logs why it is stopping immediately before calling this, and
  // `debugLog` buffers on a 1 s timer whose forced flush is bound to the
  // AppState transition, not to this moment. Stopping the service is exactly
  // when the OS becomes free to freeze the process — so without this the line
  // explaining the stop is the thing most likely to be lost, and an export
  // would show a service that started and then silently vanished.
  //
  // Here rather than at each call site so a future stop cannot forget it.
  // `flush()` swallows its own errors and never rejects.
  await flushDebugLog();
  return callNative("stop", reason);
}

/**
 * Whether the screen was on. `null` when unobtainable — unknown, not false.
 *
 * Needs no permission (`PowerManager.isInteractive`). Used only for freeze
 * attribution, never for the service decision, so it is allowed to be async
 * and allowed to fail.
 */
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
  percent: number
): Promise<void> {
  if (!native || !believedRunning) return;
  try {
    await native.update(title, text, Math.max(-1, Math.min(100, Math.round(percent))));
  } catch {
    // Never let a notification refresh break a transfer.
  }
}
