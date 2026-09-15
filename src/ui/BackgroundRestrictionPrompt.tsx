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
 *
 * Mounted app-wide rather than inside a screen, so it can appear on whatever
 * the user returned to. Renders nothing until there is something to say.
 *
 * ## Sprint 8A: this is now a LAST resort, not a first one
 *
 * 7A/7B showed this on the first detected freeze, because nothing else was
 * trying to solve the problem. The foreground service now does, and on every
 * device measured on 2026-09-13 it solved it without asking the user for
 * anything. A lone freeze is therefore no longer grounds to send someone
 * into system settings.
 *
 * `shouldPrompt` is gated on the fallback having triggered — three weighted
 * service-attributed bad windows, meaning the service ran and this specific
 * device stopped the app anyway. That is a real problem on a real device,
 * and the copy says so plainly without promising the setting will fix it,
 * because the mechanism that was supposed to fix it has already failed here.
 *
 * Still shown ONCE per prompt version, whichever button is tapped. It is an
 * offer, not a campaign. Declining costs nothing: the Settings row appears
 * at the same moment and stays.
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
    // One destination per manufacturer, each landing on a specific screen.
    // The ladder and the copy read the same brand predicate, so the setting
    // named in the body is the one on the screen that opens.
    void openFallbackSettings();
  }, []);

  const onNotNow = useCallback(() => {
    setVisible(false);
    // Nothing to record: `markPrompted` already fired when the prompt was
    // shown, so this is the last time we ask regardless of which button was
    // tapped. No "don't ask again" checkbox either — that would offer the
    // user a decision the app has already made for them. The Settings row,
    // which appears once the fallback triggers, is the way back.
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
