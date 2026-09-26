import {
  parseIncomingShareLink,
  INTENT_SHARE_LINK_REJECTED,
} from "../src/lib/links";
import { enqueueIntent, INTENT_SHARE_LINK } from "../src/lib/pendingIntents";

/**
 * The single ingress for URLs arriving from outside the app. Do not add a
 * second one. `redirectSystemPath` takes cold-start and warm-start URLs alike
 * and is the only place that can suppress the navigation: a share link is
 * otherwise read as a route path and lands on a not-found route; returning "/" stops that.
 * A parallel listener would have received the URL but left the bogus navigation in place.
 * It runs before the React tree mounts, so the link parks in `pendingIntents`.
 */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  // Everything that isn't a share link passes through untouched, outside the
  // try below so a fault here can never swallow somebody else's URL.
  // `peardrop.mobile://` does not match, so the dev client handshake and
  // expo-router's own root URL are unaffected.
  if (typeof path !== "string" || !/^peardrop:\/\//i.test(path)) {
    return path;
  }

  try {
    const parsed = parseIncomingShareLink(path);
    // Rejections are forwarded rather than dropped: the app has already been
    // brought to the foreground by the time this runs, so silence only
    // withholds the explanation for a link a messenger mangled.
    //
    // The raw `path` is carried, not the rejection reason: the holder dedupes
    // on `(kind, value)`, and keying on the reason would collapse two
    // different malformed links into one complaint.
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
