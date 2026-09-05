import React, { useCallback, useEffect, useState } from "react";

import ConfirmModal from "./ConfirmModal";
import { describeDuration } from "../lib/freezeDetect";
import { openBackgroundSettings } from "../lib/openBackgroundSettings";
import {
  markPrompted,
  shouldPrompt,
  subscribeBackgroundHealth,
  type BackgroundHealth,
} from "../state/backgroundHealthStorage";

/**
 * Offers the user the setting that stops the OS freezing this app.
 *
 * Shown only after a freeze has actually been observed. A permission request
 * at onboarding is asking about a problem the user has not had yet and gets
 * dismissed reflexively; a message that refers to something which just
 * happened to them does not.
 *
 * Shown ONCE, ever — on the first detected freeze, whichever
 * button is tapped. It is an offer, not a campaign; if the answer is no,
 * asking again is nagging. The Settings row is permanent, so declining here
 * costs the user nothing: the option stays where they can find it.
 *
 * Mounted app-wide rather than inside a screen, so it can appear on whatever
 * the user returned to. Renders nothing until there is something to say.
 */
export default function BackgroundRestrictionPrompt() {
  const [health, setHealth] = useState<BackgroundHealth | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeBackgroundHealth(setHealth), []);

  useEffect(() => {
    if (!health || !shouldPrompt(health)) return;
    setVisible(true);
    void markPrompted();
  }, [health]);

  const onOpenSettings = useCallback(() => {
    setVisible(false);
    void openBackgroundSettings();
  }, []);

  const onNotNow = useCallback(() => {
    setVisible(false);
    // Nothing to record: `markPrompted` already fired when the prompt was
    // shown, so this is the last time we ask regardless of which button was
    // tapped. No "don't ask again" checkbox either — that would offer the
    // user a decision the app has already made for them. The permanent
    // Settings row is the way back.
  }, []);

  if (!visible || !health) return null;

  const duration = describeDuration(health.lastElapsedMs);

  return (
    <ConfirmModal
      visible={visible}
      title="PearDrop stopped while you were away"
      body={
        `Your phone paused PearDrop for ${duration} while it wasn't on screen, ` +
        `so transfers couldn't continue.\n\n` +
        `You can let it keep running in the background. Open settings, find ` +
        `PearDrop's battery setting, and choose the option that doesn't ` +
        `restrict it.`
      }
      confirmLabel="Open settings"
      cancelLabel="Not now"
      tone="primary"
      onConfirm={onOpenSettings}
      onCancel={onNotNow}
    />
  );
}
