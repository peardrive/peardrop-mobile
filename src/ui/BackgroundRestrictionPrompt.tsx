import React, { useCallback, useEffect, useState } from "react";

import ConfirmModal from "./ConfirmModal";
import {
  FALLBACK_CANCEL_LABEL,
  FALLBACK_CONFIRM_LABEL,
  fallbackCopyFor,
} from "../lib/fallbackCopy";
import { fallbackBrand, openFallbackSettings } from "../lib/openBackgroundSettings";
import {
  markPrompted,
  shouldPrompt,
  subscribeBackgroundHealth,
  type BackgroundHealth,
} from "../state/backgroundHealthStorage";

/**
 * Offers the per-OEM setting that stops this device freezing the app.
 * Mounted app-wide rather than inside a screen, so it can appear on whatever
 * the user returned to, and renders nothing until there is something to say.
 * A last resort: `shouldPrompt` is gated on the foreground service having run
 * and this device having stopped the app anyway. Shown once per prompt
 * version whichever button is tapped; the Settings row stays as the way back.
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
    // The ladder and the copy read the same brand predicate, so the setting
    // named in the body is the one on the screen that opens.
    void openFallbackSettings();
  }, []);

  const onNotNow = useCallback(() => {
    setVisible(false);
    // Nothing to record: `markPrompted` already fired when the prompt was
    // shown, so this is the last ask whichever button was tapped.
  }, []);

  if (!visible || !health) return null;

  const copy = fallbackCopyFor(fallbackBrand());

  return (
    <ConfirmModal
      visible={visible}
      title={copy.title}
      body={copy.body}
      confirmLabel={FALLBACK_CONFIRM_LABEL}
      cancelLabel={FALLBACK_CANCEL_LABEL}
      tone="primary"
      onConfirm={onOpenSettings}
      onCancel={onNotNow}
    />
  );
}
