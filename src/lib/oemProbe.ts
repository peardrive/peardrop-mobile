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
 * Fires ONE candidate and reports what happened — deliberately not a ladder, because which rung
 * worked is the question. Gated inside the module too: Metro does not tree-shake.
 */

/** Distinct tag so a probe session can be grepped out of a mixed log. */
export const PROBE_TAG = "rn.probe.oem";

/**
 * How long to wait for a rejection before calling it a launch. `startActivityForResult` holds its
 * promise until the activity returns, so only the failure path settles promptly; 700 ms is the window.
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
