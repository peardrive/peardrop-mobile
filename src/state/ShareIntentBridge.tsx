import { useCallback, useEffect, useRef, useState } from "react";

import { useBackend } from "./backend";
import { useShareLinkFlow } from "./ShareLinkFlowContext";
import { useToast } from "../ui/Toast";
import { log as debugLog } from "../lib/debugLog";
import { setIntentHandler } from "../lib/pendingIntents";
import { INTENT_SHARE_FILES, INTENT_SHARE_NOTICE } from "../lib/shareIntakePayload";
import {
  isShareIntentAvailable,
  startShareIntake,
  sweepShareCopies,
  takeShareIntake,
} from "../lib/shareIntent";
import {
  decideShareIntake,
  isShareScreenBusy,
  publishShareHandoff,
  shouldDrainShareIntake,
  subscribeShareScreenBusy,
} from "../lib/shareIntakeQueue";

/** How long a share waits for the engine before the user is told it did not come up. The cold
 *  path is splash, onboarding check, nav reset and worklet boot, and this clears all four. */
const ENGINE_WAIT_MS = 60_000;

/** The drain side of the share target. Mounted inside ShareLinkFlowProvider and outside the
 *  navigator, like IncomingLinkBridge, so the handler outlives the splash's nav.reset(). */
export default function ShareIntentBridge(): null {
  const { ready } = useBackend();
  const { previewVisible, downloadAllBusy, resolving } = useShareLinkFlow();
  const { show: showToast } = useToast();

  /** A share that arrived while the user was busy, waiting to be applied. */
  const heldRef = useRef<string | null>(null);

  /** Bumped when the screen's busy flag moves, because that flag lives in a module and so
   *  re-runs no effect on its own. Becoming free is exactly when a held share must drain. */
  const [screenBusyTick, setScreenBusyTick] = useState(0);
  useEffect(() => subscribeShareScreenBusy(() => setScreenBusyTick((n) => n + 1)), []);

  useEffect(() => {
    if (!isShareIntentAvailable()) return undefined;
    return startShareIntake();
  }, []);

  const apply = useCallback((shareId: string) => {
    const held = takeShareIntake(shareId);
    if (!held) {
      debugLog("warn", "rn.shareintent", `nothing parked under ${shareId}`);
      return;
    }
    publishShareHandoff({ shareId, files: held.files, dropped: held.dropped });
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    return setIntentHandler(INTENT_SHARE_FILES, (intent) => {
      const decision = decideShareIntake(intent.value, {
        screenBusy: isShareScreenBusy(),
        previewVisible,
        downloadBusy: downloadAllBusy,
        resolving,
        heldShareId: heldRef.current,
      });
      if (decision.action === "already-held") return;
      if (decision.action === "hold") {
        heldRef.current = decision.shareId;
        showToast(decision.notice, { kind: "info", title: "Files saved" });
        return;
      }
      apply(decision.shareId);
    });
  }, [ready, previewVisible, downloadAllBusy, resolving, showToast, apply]);

  // Apply the held share once the user is free. The busy flags are the schedule.
  useEffect(() => {
    const state = {
      screenBusy: isShareScreenBusy(),
      previewVisible,
      downloadBusy: downloadAllBusy,
      resolving,
      heldShareId: heldRef.current,
    };
    if (!shouldDrainShareIntake(state)) return;
    const shareId = heldRef.current as string;
    heldRef.current = null;
    apply(shareId);
  }, [previewVisible, downloadAllBusy, resolving, screenBusyTick, apply]);

  // Notices need no engine and no surface of their own, so this is not gated on `ready` — the
  // same arrangement the rejected-link handler uses next door.
  useEffect(() => {
    return setIntentHandler(INTENT_SHARE_NOTICE, (intent) => {
      showToast(intent.value, { kind: "info", title: "Nothing to share" });
    });
  }, [showToast]);

  // The engine never came up. A share held with no handler waits forever, and the user handed
  // over files, so: one plain notice, and the copies go rather than leaking gigabytes.
  useEffect(() => {
    if (ready || !isShareIntentAvailable()) return undefined;
    const timer = setTimeout(() => {
      void sweepShareCopies([]).then((removed) => {
        debugLog(
          "warn",
          "rn.shareintent",
          `engine did not come up within ${ENGINE_WAIT_MS}ms — swept ${removed} copy(ies)`,
        );
      });
      showToast("PearDrop couldn't start up. Try sharing again.", {
        kind: "info",
        title: "Not ready yet",
      });
    }, ENGINE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [ready, showToast]);

  return null;
}
