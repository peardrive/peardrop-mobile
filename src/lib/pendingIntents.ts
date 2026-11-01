/**
 * a generic holder for intents that arrive from outside the
 * React tree at a moment when the app cannot act on them yet.
 *
 * The problem it solves is timing, not URLs. An Android VIEW intent is
 * delivered into expo-router's linking layer during startup — before the
 * navigator has mounted, before the backend worklet is ready, and before
 * `SplashScreenRoute.onFinish` has run its `nav.reset()`. Anything acted
 * on in that window is either lost to the reset or fired at a backend
 * that isn't listening. So the intent is parked here and drained later.
 *
 * Deliberately *not* shaped around links: an intent is an opaque
 * `{ kind, value }` pair. A new consumer registers a handler for its own
 * `kind` and gets the same hold-until-safe semantics for free. Nothing here
 * imports React or
 * React Native, which also keeps it reachable by Jest.
 *
 * An intent drains only when BOTH conditions hold:
 *
 *   1. the gate is open   — the launch flow has settled (splash reset has
 *                           landed, and onboarding, if it ran, is done);
 *   2. a handler is registered for its `kind` — the consumer is mounted
 *                           and its own preconditions are met.
 *
 * Until then it just sits in the queue. Those two conditions compose:
 * neither side needs to know about the other's readiness, which is what
 * keeps the launch-flow gate free of any share-link specifics.
 */

export type PendingIntent = {
  /** Coarse routing discriminator. Consumers register per-kind. */
  kind: string;
  /** Opaque payload, interpreted by that kind's handler. */
  value: string;
  /**
   * when the intent was offered, in epoch ms. Optional on
   * the way in (`enqueueIntent` stamps it) and always present on the way
   * out, so handlers can age-check without the holder needing an opinion
   * about what "too old" means.
   *
   * This matters because the gate can hold an intent for an unbounded
   * stretch: a link tapped before onboarding surfaces only when
   * onboarding completes, possibly minutes later. Some consumers want
   * that (a share is still worth opening); others don't (a complaint
   * about a damaged link, arriving with no context, is worse than
   * silence). The policy belongs to the consumer; the timestamp is all
   * this module provides.
   */
  at?: number;
};

/** A `PendingIntent` as handed to a handler — `at` is guaranteed. */
export type DeliveredIntent = PendingIntent & { at: number };

export type IntentHandler = (intent: DeliveredIntent) => void;

/** How long an intent sat between being offered and being handled. */
export function intentAgeMs(intent: DeliveredIntent, now = Date.now()): number {
  return Math.max(0, now - intent.at);
}

/** A validated `peardrop://<key>` link that arrived from outside the app. */
export const INTENT_SHARE_LINK = "share-link";

/** Bring the list of shares forward, for an alert that names several. */
export const INTENT_SHOW_SHARES = "show-shares";

/**
 * Backstop against the same intent being delivered twice in quick
 * succession *after* the gate is already open.
 *
 * The primary dedupe is the queue check in `enqueueIntent`, and it is the
 * one that covers the real case: on a cold start the gate is still closed,
 * so both the initial-URL read and the `url` event land in the queue and
 * the second is dropped as a duplicate of the first. That path involves no
 * timing assumption at all. This window only guards the residual case
 * where a duplicate arrives just after a drain — kept short so a user
 * deliberately re-tapping a link after a failed resolve isn't ignored.
 */
const DEDUPE_WINDOW_MS = 2000;

let queue: DeliveredIntent[] = [];
const handlers = new Map<string, IntentHandler>();
let gateOpen = false;
let draining = false;
let lastDrained: { id: string; at: number } | null = null;

/**
 * Separator for `idOf`: ASCII 31 UNIT SEPARATOR, written as the escape
 * sequence `\u001f` rather than as a literal byte. Both halves of that
 * sentence are load-bearing, for different reasons.
 *
 * WHY A CONTROL CHARACTER AT ALL. The id must be injective over
 * (kind, value), and one kind is a strict PREFIX of another:
 * "share-link" (`INTENT_SHARE_LINK`, just above) and
 * "share-link-rejected" (`INTENT_SHARE_LINK_REJECTED`,
 * `src/lib/links.ts`). With no separator, kind "share-link" + value
 * "-rejectedX" and kind "share-link-rejected" + value "X" collapse to
 * the same id, and one intent silently dedupes the other away. A
 * separator that cannot occur in either field restores injectivity,
 * and US qualifies on both counts for every kind in the tree. The
 * kinds are [a-z-]+ literals. The values are a 64-hex share link from
 * `parseShareLink`, the raw URL of a rejected one, a 16-hex share id
 * from `PeardropShareIntentModule` (`INTENT_SHARE_FILES`), and a
 * fixed notice string (`INTENT_SHARE_NOTICE`) - and `npm run
 * check:encoding` fails the build on a control byte in any of their
 * sources, which is what keeps the last two true as they change.
 *
 * WHY AN ESCAPE SEQUENCE. A literal NUL byte on this line makes the file
 * binary to ripgrep, which then skips its contents SILENTLY WHILE
 * TRAVERSING A DIRECTORY - so every `rg ... src/` sweep has a
 * hole in it exactly this file's size, and none of them say so.
 * (On an explicit path rg is not silent: it prints "binary file
 * matches". Only traversal hides it, and traversal is how sweeps run.)
 * Writing the separator as an escape keeps this file free of control
 * bytes. (It is not pure ASCII and does not need to be - the prose above
 * holds 12 em dashes, 36 bytes of perfectly valid UTF-8. NUL is the byte
 * rg's binary heuristic keys on, not "non-ASCII".) `npm run
 * check:encoding` now fails the build if a control byte or invalid UTF-8
 * ever appears here or in any other file under `src/` or `backend/`.
 */
const ID_SEP = "\u001f";

function idOf(intent: PendingIntent): string {
  return `${intent.kind}${ID_SEP}${intent.value}`;
}

/**
 * Drain everything currently drainable. Re-entrancy safe: a handler that
 * enqueues another intent (or opens/closes the gate) is picked up by the
 * outer loop rather than starting a nested drain.
 */
function flush(): void {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      if (!gateOpen) break;
      let picked: { intent: DeliveredIntent; handler: IntentHandler } | null = null;
      for (let i = 0; i < queue.length; i++) {
        const candidate = queue[i];
        if (!candidate) continue;
        const handler = handlers.get(candidate.kind);
        if (handler) {
          picked = { intent: candidate, handler };
          queue.splice(i, 1);
          break;
        }
      }
      // Nothing drainable — anything left has no handler yet and stays
      // queued, in arrival order, for whenever one registers.
      if (!picked) break;
      lastDrained = { id: idOf(picked.intent), at: Date.now() };
      try {
        picked.handler(picked.intent);
      } catch {
        // A throwing handler must not strand the rest of the queue, and
        // must never propagate — the original caller is a linking
        // callback where an exception would take startup down.
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Offer an intent. Drains immediately if the gate is open and a handler
 * is registered for its kind; otherwise it's held until both are true.
 * Duplicates are dropped (see `DEDUPE_WINDOW_MS`).
 */
export function enqueueIntent(intent: PendingIntent): void {
  const id = idOf(intent);
  if (queue.some((queued) => idOf(queued) === id)) return;
  // `at` is deliberately outside `idOf` — two deliveries of the same
  // (kind, value) are still duplicates however far apart they are stamped.
  if (
    lastDrained &&
    lastDrained.id === id &&
    Date.now() - lastDrained.at < DEDUPE_WINDOW_MS
  ) {
    return;
  }
  // Stamp on the way in, honouring a caller-supplied `at` so a consumer
  // that already knows when the event happened (a notification's own
  // timestamp, say) isn't forced to lie about it.
  queue.push({ ...intent, at: intent.at ?? Date.now() });
  flush();
}

/**
 * Register the handler for a kind, replacing any previous one. Returns an
 * unsubscribe suitable for returning straight from a `useEffect`.
 *
 * Registering drains anything already waiting on this kind, so a consumer
 * that mounts late (or becomes ready late) still receives intents that
 * arrived before it existed.
 */
export function setIntentHandler(kind: string, handler: IntentHandler): () => void {
  handlers.set(kind, handler);
  flush();
  return () => {
    // Only clear if we're still the current handler — guards against a
    // stale effect cleanup landing after a newer effect has registered.
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

/**
 * The launch flow has settled; held intents may now be acted on. Called
 * once the splash's `nav.reset()` has landed, or once onboarding
 * completes for a first-run user. Idempotent.
 */
export function openIntentGate(): void {
  if (gateOpen) return;
  gateOpen = true;
  flush();
}

/** Hold everything again. Not used in the launch flow; present for symmetry and tests. */
export function closeIntentGate(): void {
  gateOpen = false;
}

export function isIntentGateOpen(): boolean {
  return gateOpen;
}

/** Number of intents currently held. Diagnostics and tests. */
export function pendingIntentCount(): number {
  return queue.length;
}

/** Restore module state. Test-only. */
export function resetPendingIntents(): void {
  queue = [];
  handlers.clear();
  gateOpen = false;
  draining = false;
  lastDrained = null;
}
