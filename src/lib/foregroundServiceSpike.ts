import { AppState, type AppStateStatus } from "react-native";

import { log as debugLog } from "./debugLog";
import { IS_DEBUG_BUILD } from "./devGate";
import {
  isForegroundServiceAvailable,
  startForegroundService,
  stopForegroundService,
} from "./foregroundService";

/**
 * Harness rows for the foreground service; it keeps no native access of its own, because two
 * modules with independent beliefs about whether the service runs is how a start and stop drift.
 */

const TAG = "rn.probe.oem";

export { isForegroundServiceAvailable, startForegroundService, stopForegroundService };

// Background-start arm (harness only)

/**
 * Android 12+ forbids a background foreground-service start, so whether one lands inside a grace
 * window or throws has to be measured. A second start on a running service just re-posts.
 */
let armed = false;
let subscription: { remove: () => void } | null = null;
const listeners = new Set<(v: boolean) => void>();

function onAppStateChange(next: AppStateStatus): void {
  if (next !== "background") return;
  debugLog("warn", TAG, `fgs harness arm: appstate -> background at=${Date.now()}`);
  void startForegroundService("harness-background-arm");
}

export function isBackgroundStartArmed(): boolean {
  return armed;
}

export function setBackgroundStartArmed(next: boolean): void {
  // Guarded inside the module, not only at the call site: Metro does not
  // tree-shake, so this file ships in release builds.
  if (!IS_DEBUG_BUILD) return;
  if (armed === next) return;
  armed = next;
  if (next) {
    subscription = AppState.addEventListener("change", onAppStateChange);
    debugLog("warn", TAG, `fgs harness arm ARMED at=${Date.now()}`);
  } else {
    subscription?.remove();
    subscription = null;
    debugLog("warn", TAG, `fgs harness arm disarmed at=${Date.now()}`);
  }
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {}
  }
}

export function subscribeBackgroundStart(listener: (v: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
