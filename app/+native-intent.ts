import {
  parseIncomingShareLink,
  INTENT_SHARE_LINK_REJECTED,
} from "../src/lib/links";
import { enqueueIntent, INTENT_SHARE_LINK } from "../src/lib/pendingIntents";

/**
 * THE single ingress for URLs arriving from outside the app. Do not add a
 * second one.
 *
 * `+native-intent` is expo-router's own hook into its linking layer.
 * `redirectSystemPath` is called with the raw URL on both delivery paths
 * we need, so this one function covers the whole surface:
 *
 *   - cold start, once, with `initial: true`  (the launch URL)
 *   - warm start, per event, `initial: false` (the `url` event; the
 *     activity is `launchMode="singleTask"`, so a second tap is delivered
 *     to the running process rather than relaunching it)
 *
 * Using the router's existing ingress rather than adding our own
 * `Linking.addEventListener` is not just tidiness — it's the only place
 * that can *suppress* the navigation. expo-router's `extractExpoPathFromURL`
 * ignores the configured `prefixes` entirely and strips whatever scheme it
 * is given, so once the manifest accepts `peardrop://`, the router would
 * read `peardrop://<key>` as the route path `<key>`, match nothing, and
 * land on its generated `+not-found`. Returning "/" here is what stops
 * that. A parallel listener would have received the URL but left the
 * bogus navigation in place.
 *
 * Both React Native's `Linking` and `expo-linking` are available in this
 * project (expo-linking 8.0.11 is a direct dependency, and expo-router
 * uses it internally); neither is needed directly given the above.
 *
 * This runs during startup, before the React tree is mounted — which is
 * why the link is parked in the React-free `pendingIntents` holder rather
 * than dispatched anywhere. See `src/lib/pendingIntents.ts`.
 */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  // Everything that isn't a share link passes through untouched, and does
  // so outside the try below so a fault on our side can never swallow
  // somebody else's URL. Note `peardrop.mobile://` does not match this —
  // the character after "peardrop" is "." not ":" — so the dev client's
  // `peardrop.mobile://expo-development-client/?url=...` handshake and
  // expo-router's own root URL are unaffected.
  if (typeof path !== "string" || !/^peardrop:\/\//i.test(path)) {
    return path;
  }

  try {
    const parsed = parseIncomingShareLink(path);
    // rejections are forwarded rather than dropped. 6E argued
    // for silence on the grounds that a visible error would let any web
    // page interrupt the user — but by the time this runs the app has
    // *already* been brought to the foreground, so the interruption has
    // happened either way and silence only withholds the explanation.
    // Messengers mangle links routinely (trailing punctuation, wrapping,
    // truncation) and those land here.
    //
    // The raw `path` is carried, not the rejection reason: the holder
    // dedupes on `(kind, value)`, and keying on the reason would collapse
    // two different malformed links into one complaint. The bridge shows
    // one generic message and never enumerates parser internals.
    //
    // Note this is only reached for URLs already on the `peardrop`
    // scheme — the early return above means genuinely unrelated URLs are
    // never parsed and stay silent.
    enqueueIntent(
      parsed.ok
        ? { kind: INTENT_SHARE_LINK, value: parsed.link }
        : { kind: INTENT_SHARE_LINK_REJECTED, value: path },
    );
  } catch {
    // A throw here happens inside expo-router's linking setup and would
    // take startup with it. Nothing this function does is worth that.
  }

  // Claimed either way. Send the router to the root so it never tries to
  // resolve the key as a route.
  return "/";
}
