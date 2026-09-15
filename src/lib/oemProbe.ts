import { Linking, Platform } from "react-native";
import * as IntentLauncher from "expo-intent-launcher";

import { log as debugLog } from "./debugLog";
import { IS_DEBUG_BUILD } from "./devGate";
import {
  classifyProbeError,
  describeTarget,
  type ProbeCandidate,
  type ProbeOutcome,
} from "./oemProbeCandidates";

/**
 * fire ONE candidate and report what happened.
 *
 * Deliberately not a ladder. `openBackgroundSettings()` falls through on
 * failure because a user needs to land somewhere; this needs the opposite,
 * because a ladder hides which rung worked and which rung worked is the whole
 * question. One tap, one intent, one outcome.
 *
 * Gated inside the module as well as at the call site, on the same signal the
 * rows use. Metro does not tree-shake, so this file is in the release bundle;
 * making the entry point inert here means no future caller can fire an OEM
 * intent from a shipping build by forgetting a wrapper.
 */

/** Distinct tag so a probe session can be grepped out of a mixed log. */
export const PROBE_TAG = "rn.probe.oem";

/**
 * How long to wait for a rejection before calling it a launch.
 *
 * `IntentLauncher.startActivityAsync` uses `startActivityForResult`, and its
 * promise is held until the launched activity RETURNS — so awaiting it would
 * mean the verdict, the toast and the log line all arrive minutes later, when
 * the operator comes back, and in the order they happened to return rather
 * than the order they tapped. Only the failure path settles promptly:
 * `startActivityForResult` throws synchronously in native and is rejected on
 * the spot.
 *
 * So the signal is "did it reject immediately", and this is the window for
 * immediately. 700 ms is comfortably longer than a bridge round-trip and
 * shorter than a person can tap twice.
 *
 * The consequence is that `launched` means "the start call did not throw" —
 * which is why the borrowed-device protocol asks the operator to record the
 * TITLE of the screen that opened. A candidate that successfully opens the
 * wrong screen is the failure mode this project has already paid for twice
 * (see the APP_PERM_EDITOR note in openBackgroundSettings.ts), and no
 * in-process signal can detect it.
 */
const LAUNCH_GRACE_MS = 700;

export type ProbeResult = {
  key: string;
  label: string;
  outcome: ProbeOutcome;
  /** Full component or action that was attempted. */
  target: string;
  /** Empty on `launched`. */
  exceptionClass: string;
  /** Empty on `launched`. */
  message: string;
};

function launch(c: ProbeCandidate): Promise<unknown> {
  if (c.via === "app-details") return Linking.openSettings();
  return IntentLauncher.startActivityAsync(c.action, {
    // Both or neither — expo-intent-launcher drops a packageName that has no
    // className beside it. See ProbeCandidate in oemProbeCandidates.ts.
    ...(c.className ? { packageName: c.packageName, className: c.className } : {}),
    ...(c.extra ? { extra: c.extra } : {}),
  });
}

/**
 * Attempt one candidate. Never throws — every outcome, including an
 * unexpected one, comes back as a value so the caller can toast it.
 */
export async function runProbe(candidate: ProbeCandidate): Promise<ProbeResult> {
  const target = describeTarget(candidate);
  const base = { key: candidate.key, label: candidate.label, target };

  if (!IS_DEBUG_BUILD || Platform.OS !== "android") {
    const why = !IS_DEBUG_BUILD ? "not a debug build" : `platform ${Platform.OS}`;
    debugLog("warn", PROBE_TAG, `skip ${candidate.key} — ${why}`);
    return { ...base, outcome: "error", exceptionClass: "Skipped", message: why };
  }

  debugLog(
    "warn",
    PROBE_TAG,
    `attempt ${candidate.key} "${candidate.label}" target=${target} ` +
      `source=${candidate.source} at=${Date.now()}`
  );

  // Settle the rejection path against a timer rather than awaiting: see
  // LAUNCH_GRACE_MS. Both handlers are attached here, so a rejection that
  // arrives after the race has already been decided is still consumed and
  // cannot surface as an unhandled rejection.
  const attempt = launch(candidate).then(
    () => ({ kind: "resolved" as const }),
    (err: unknown) => ({ kind: "rejected" as const, err })
  );
  const raced = await Promise.race([
    attempt,
    new Promise<{ kind: "pending" }>((resolve) =>
      setTimeout(() => resolve({ kind: "pending" }), LAUNCH_GRACE_MS)
    ),
  ]);

  if (raced.kind === "rejected") {
    const failure = classifyProbeError(raced.err);
    debugLog(
      "error",
      PROBE_TAG,
      `result ${candidate.key} -> ${failure.outcome} ` +
        `exception=${failure.exceptionClass} target=${target} ` +
        `msg=${failure.message}`
    );
    return { ...base, ...failure };
  }

  // Still pending, or already returned. Either way the start call did not
  // throw, which is the strongest thing this process can observe.
  debugLog(
    "warn",
    PROBE_TAG,
    `result ${candidate.key} -> launched target=${target} ` +
      `(${raced.kind === "resolved" ? "returned immediately" : "activity in foreground"})`
  );

  if (raced.kind === "pending") {
    // The operator is now on the OEM screen. Record when they come back, and
    // catch a late throw — some OEM activities die after starting, and that
    // arrives well outside the grace window.
    void attempt.then((late) => {
      if (late.kind === "rejected") {
        const failure = classifyProbeError(late.err);
        debugLog(
          "error",
          PROBE_TAG,
          `late-failure ${candidate.key} -> ${failure.exceptionClass} ` +
            `msg=${failure.message}`
        );
      } else {
        debugLog("warn", PROBE_TAG, `returned ${candidate.key} at=${Date.now()}`);
      }
    });
  }

  return { ...base, outcome: "launched", exceptionClass: "", message: "" };
}
