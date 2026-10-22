import {
  parseIncomingShareLink,
  INTENT_SHARE_LINK_REJECTED,
} from "../src/lib/links";
import { enqueueIntent, INTENT_SHARE_LINK } from "../src/lib/pendingIntents";

/**
 * The single ingress for URLs from outside the app — do not add a second. Only `redirectSystemPath`
 * can suppress the navigation; a share link is otherwise read as a route and lands on not-found.
 */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  // Non-share links pass through untouched, outside the try below so a fault here can never
  // swallow somebody else's URL. `peardrop.mobile://` does not match.
  if (typeof path !== "string" || !/^peardrop:\/\//i.test(path)) {
    return path;
  }

  try {
    const parsed = parseIncomingShareLink(path);
    // The raw `path` is carried, not the rejection reason: the holder dedupes on `(kind, value)`,
    // and keying on the reason would collapse two different malformed links into one complaint.
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
