import { AppState, type AppStateStatus } from "react-native";

import { log as debugLog } from "./debugLog";
import { IS_DEBUG_BUILD } from "./devGate";
import {
  isForegroundServiceAvailable,
  startForegroundService,
  stopForegroundService,
} from "./foregroundService";

/**
 * Sprint 7D's foreground-service harness rows — what is left of them after
 * 8A promoted the service itself into shipping code.
 *
 * The bridge, the drain and the `believedRunning` bookkeeping all moved to
 * `foregroundService.ts`. This file deliberately keeps NO native access of
 * its own: two modules holding independent beliefs about whether the service
 * is running is precisely how a start and its stop drift apart.
 *
 * What remains here is the one thing the harness needs and the product does
 * not — a way to start the service from the background transition
 * WITHOUT consulting the activity predicate, so the mechanism can be tested
 * on a borrowed device that has no transfer in flight.
 *
 * Debug builds only. In release the arm cannot be engaged, so the only thing
 * that starts the service is `applyServiceForBackground` in backend.ts.
 */

const TAG = "rn.probe.oem";

export { isForegroundServiceAvailable, startForegroundService, stopForegroundService };

// ---------------------------------------------------------------------
// Background-start arm (harness only)
// ---------------------------------------------------------------------

/**
 * Android 12+ forbids starting a foreground service from the background, and
 * this project targets SDK 36. Whether a start from the `background`
 * AppState transition lands inside a grace window or throws
 * ForegroundServiceStartNotAllowedException outright is exactly the sort of
 * thing this arc has been wrong about when assuming rather than measuring.
 *
 * Session-only state: the operator taps the row and backgrounds immediately,
 * so nothing needs to survive a restart.
 *
 * Note this arm fires ALONGSIDE the shipping lifecycle, not instead of it.
 * If a transfer happens to be active, both will call start; the second call
 * is harmless, since `startForegroundService` on a running service just
 * re-enters `onStartCommand` and re-posts the same notification.
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
  // Guarded inside the module, not only at the call site. Metro does not
  // tree-shake, so this file ships in release builds; making the entry point
  // inert here means no release build can register the harness listener even
  // if some future caller forgets the gate.
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
