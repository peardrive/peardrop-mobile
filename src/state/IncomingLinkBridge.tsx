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
// Queue an incoming link rather than swapping what the user is looking at.
// The decision and the copy both live in that module.
import { decideIncomingLink, shouldDrain } from "../lib/incomingLinkQueue";

/**
 * How long a rejection stays worth mentioning. Rejections pass the same
 * launch-flow gate as valid links, so one tapped before onboarding waits.
 * Below this the toast still has context; above it, complaining about a
 * link tapped several minutes ago is worse than silence.
 */
const REJECTION_MAX_AGE_MS = 30_000;

/**
 * Drains the incoming-link holder into the resolve-and-preview flow, outside the
 * navigator so a navigation reset never unmounts it, and only once the worklet is
 * ready. `resolveFromScan` opens the preview and never downloads: the intent filter
 * is browsable, so the user sees a share first. It toasts failures nothing else shows.
 */
export default function IncomingLinkBridge(): null {
  const { ready } = useBackend();
  const { resolveFromScan, resolving, previewVisible, downloadAllBusy, linkError } =
    useShareLinkFlow();
  const { show: showToast } = useToast();

  /** A resolve this component started is in flight, so an outcome is owed. */
  const watchingRef = useRef(false);
  /** That resolve has been observed actually running (see below). */
  const startedRef = useRef(false);
  /**
   * A link that arrived while the user was busy, waiting to be applied. A
   * ref rather than state, because it must not trigger a render: the drain
   * effect already re-runs on the busy flags, which is exactly when the
   * user becomes free.
   */
  const heldLinkRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return undefined;
    return setIntentHandler(INTENT_SHARE_LINK, (intent) => {
      // Already strictly validated at the boundary, so this is a canonical
      // link. Resolving unconditionally would swap a preview's contents
      // underneath the user, and during a grab the running grab's error
      // would render under the new share's name. The decision and the copy
      // live in `src/lib/incomingLinkQueue.ts`, which the suite can reach
      // and this file cannot.
      const decision = decideIncomingLink(intent.value, {
        previewVisible,
        downloadBusy: downloadAllBusy,
        resolving,
        heldLink: heldLinkRef.current,
      });
      if (decision.action === "already-held") return;
      if (decision.action === "hold") {
        heldLinkRef.current = decision.link;
        showToast(decision.notice, { kind: "info", title: "Link saved" });
        return;
      }
      watchingRef.current = true;
      startedRef.current = false;
      void resolveFromScan(decision.link);
    });
  }, [ready, resolveFromScan, previewVisible, downloadAllBusy, resolving, showToast]);

  /**
   * Apply the held link once the user is free. The link is never dropped:
   * it is announced when held and resolved here. It does not survive
   * process death.
   */
  useEffect(() => {
    const state = {
      previewVisible,
      downloadBusy: downloadAllBusy,
      resolving,
      heldLink: heldLinkRef.current,
    };
    if (!shouldDrain(state)) return;
    const link = heldLinkRef.current as string;
    heldLinkRef.current = null;
    watchingRef.current = true;
    startedRef.current = false;
    void resolveFromScan(link);
  }, [previewVisible, downloadAllBusy, resolving, resolveFromScan]);

  // URLs that arrived on the app's scheme but failed validation. Not gated
  // on `ready`: a toast needs no backend and a damaged link never reaches
  // one. The launch-flow gate still applies, hence the age check.
  useEffect(() => {
    return setIntentHandler(INTENT_SHARE_LINK_REJECTED, (intent) => {
      if (intentAgeMs(intent) > REJECTION_MAX_AGE_MS) return;
      // One message for every rejection class: a parser reason leaks
      // internals and cannot be acted on. Asking the sender again can be.
      showToast("Ask whoever sent it to share the link again.", {
        kind: "warning",
        title: "That link looks damaged",
      });
    });
  }, [showToast]);

  useEffect(() => {
    if (!watchingRef.current) return;

    if (resolving) {
      // Record that the resolve is underway: "not resolving" alone is
      // ambiguous, because there is a window after the handler fires in
      // which nothing has started yet.
      startedRef.current = true;
      return;
    }

    // Not resolving, never seen starting, and no outcome visible: this is
    // still the pre-start window, so keep waiting.
    if (!startedRef.current && !previewVisible && !linkError) return;

    watchingRef.current = false;
    startedRef.current = false;

    // The preview opened, so the resolve succeeded and any later error is
    // the download's, rendered in the preview's own banner. This is the
    // double-reporting guard: a mounted surface owns the message.
    if (previewVisible) return;

    // No preview, no surface mounted, and the flow reported a failure.
    // `linkError` is the paste path's copy, reused rather than restated.
    if (linkError) {
      showToast(linkError, { kind: "error", title: "Couldn't open that link" });
    }

    // Remaining case: no preview and no error, meaning every file in the
    // share is already on disk. That path raises its own toast.
  }, [resolving, previewVisible, linkError, showToast]);

  return null;
}
