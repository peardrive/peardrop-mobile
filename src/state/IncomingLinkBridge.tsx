import { useEffect, useRef } from "react";
import { useBackend } from "./backend";
import { useShareLinkFlow } from "./ShareLinkFlowContext";
import { useToast } from "../ui/Toast";
import {
  INTENT_SHARE_LINK,
  intentAgeMs,
  setIntentHandler,
} from "../lib/pendingIntents";
import { INTENT_SHARE_LINK_REJECTED } from "../lib/links";

/**
 * how long a rejection stays worth mentioning.
 *
 * Rejections go through the same launch-flow gate as valid links, so one
 * tapped before onboarding is held until onboarding completes. Below this
 * threshold the toast still has context — the user tapped something a
 * moment ago and it didn't work. Above it, a complaint about a link they
 * tapped several minutes and one onboarding flow ago is worse than
 * silence, so it's dropped.
 */
const REJECTION_MAX_AGE_MS = 30_000;

/**
 * the drain side of the incoming-link plumbing.
 *
 * Renders nothing. Its whole job is to connect the React-free intent
 * holder (`lib/pendingIntents`) to the resolve-and-preview flow that the
 * paste and scan affordances already use, and to do so only once that
 * flow can actually succeed.
 *
 * Two things make that work:
 *
 *  - It is mounted *inside* `ShareLinkFlowProvider` and outside the
 *    navigator, so `nav.reset()` never unmounts it and the handler
 *    registration outlives the entire launch flow.
 *
 *  - It registers the handler only once the backend worklet reports
 *    `ready`. A cold-start link is drained a couple of seconds after
 *    launch, which is exactly when the worklet may still be starting;
 *    resolving against it then would fail with a spurious "couldn't
 *    reach the other pear". Because the holder only drains an intent
 *    when the gate is open AND a handler exists, deferring registration
 *    is all that's needed — no extra state in the holder, and the
 *    launch-flow gate stays free of share-link specifics.
 *
 * `resolveFromScan` is the same entry point the QR scanner uses and
 * funnels into the same `runResolve`, so there is no parallel flow here.
 * It opens the share preview and waits for the user; it never downloads.
 * That is a deliberate safety property — the VIEW intent filter carries
 * BROWSABLE, so any web page can fire a `peardrop://` URL at the app, and
 * the user must see what a share contains before anything is fetched.
 *
 * adds the failure surface. `ShareLinkFlowContext` reports a
 * failed resolve by setting `linkError`, which renders only inside
 * `SharePreviewModal`, `ReceiveSheet`, and `ReceiveScreen` — none of
 * which are mounted after a cold-start link that failed. The result was
 * an error haptic and nothing else, indistinguishable from the intent
 * filter never having matched. This component now watches the outcome of
 * the resolve it started and raises a toast when no other surface will.
 * Nothing in `ShareLinkFlowContext` changed to make that possible: the
 * state it needs is already on the context, read-only.
 *
 * adds the second surface: links that never got as far as a
 * resolve because they failed validation. Those now arrive as their own
 * intent kind and get one generic toast. Between the two, every incoming
 * link that reaches the app either visibly works or visibly explains
 * itself — which is what makes the offline device tests decisive rather
 * than ambiguous.
 */
export default function IncomingLinkBridge(): null {
  const { ready } = useBackend();
  const { resolveFromScan, resolving, previewVisible, linkError } =
    useShareLinkFlow();
  const { show: showToast } = useToast();

  /** A resolve this component started is in flight; we owe an outcome. */
  const watchingRef = useRef(false);
  /** That resolve has been observed actually running (see below). */
  const startedRef = useRef(false);

  useEffect(() => {
    if (!ready) return undefined;
    return setIntentHandler(INTENT_SHARE_LINK, (intent) => {
      // Already strictly validated at the boundary (+native-intent.ts),
      // so this is a canonical `peardrop://<64 hex>` or `peardrop://demo`.
      watchingRef.current = true;
      startedRef.current = false;
      void resolveFromScan(intent.value);
    });
  }, [ready, resolveFromScan]);

  // URLs that arrived on the `peardrop` scheme but failed
  // validation. Deliberately not gated on `ready` — showing a toast needs
  // no backend, and a damaged link is never going to reach one anyway.
  // It is still subject to the launch-flow gate, hence the age check.
  useEffect(() => {
    return setIntentHandler(INTENT_SHARE_LINK_REJECTED, (intent) => {
      if (intentAgeMs(intent) > REJECTION_MAX_AGE_MS) return;
      // One message for every rejection class. The user cannot act on
      // "bad key charset" and it leaks parser internals; what they can
      // act on is asking the sender to send it again.
      showToast("Ask whoever sent it to share the link again.", {
        kind: "warning",
        title: "That link looks damaged",
      });
    });
  }, [showToast]);

  useEffect(() => {
    if (!watchingRef.current) return;

    if (resolving) {
      // The resolve is underway. Record that, because "not resolving" on
      // its own is ambiguous: `runResolve` awaits a downloaded-files read
      // before it ever sets `resolving`, so there is a window right after
      // the handler fires where nothing has started yet.
      startedRef.current = true;
      return;
    }

    // Not resolving. If we never saw it start and no outcome is visible
    // yet, we're still in that pre-start window — keep waiting.
    if (!startedRef.current && !previewVisible && !linkError) return;

    watchingRef.current = false;
    startedRef.current = false;

    // The preview opened, which means the resolve succeeded and the user
    // can see the share. Any error from here on is the download's, and
    // `SharePreviewModal` renders `linkError` in its own banner — so this
    // is also the double-reporting guard: if a surface is mounted, it
    // owns the message and we stay quiet.
    if (previewVisible) return;

    // No preview, no surface mounted, and the flow reported a failure.
    // `linkError` is the paste path's own copy, reused verbatim rather
    // than restated — this deliberately adds no new error taxonomy.
    if (linkError) {
      showToast(linkError, { kind: "error", title: "Couldn't open that link" });
    }

    // Remaining case: no preview and no error — the full-dedup path,
    // where every file in the share is already on disk. That already
    // raises its own "You've already got these." toast, so nothing here.
  }, [resolving, previewVisible, linkError, showToast]);

  return null;
}
