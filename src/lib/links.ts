/**
 * The one parser for peardrop share links. A link is
 * `peardrop://<64 hex chars>`, but what arrives is rarely that clean:
 * messaging apps append tracking parameters, launchers a trailing slash,
 * prose a full stop. One parser for every entry path strips those and yields
 * the canonical `peardrop://<key>`; everything downstream is keyed by that
 * form, because a record keyed on a mangled link is never written at all.
 */

const HEX_KEY_64 = /^[a-fA-F0-9]{64}$/;

/**
 * How much the caller is trusted, which is a fact about where the string
 * came from — not about how it is normalised.
 */
export type LinkTrust =
  /** Deep link, QR scan: the whole payload is the link or it is junk. */
  | "external"
  /** Paste / typed draft: a human is present and prose is expected. */
  | "pasted";

export function normalizeShareLink(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const parsed = canonicalizeShareLink(trimmed, "pasted");
  // Unparseable input is returned untouched so the caller can show it back
  // to the user in a friendly error. Treat this as "best-effort".
  return parsed.ok ? parsed.link : trimmed;
}

/**
 * Should the debounce fire a resolve at this draft yet? Deliberately looser
 * than the parser: `runResolve` is what shows the error for a damaged link,
 * so tightening this to the parser would mean a user typing
 * `peardrop://abc` gets no resolve and therefore no message at all.
 */
export function shouldAttemptResolve(text: string): boolean {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (/peardrop:\/\//i.test(trimmed)) return true;
  if (HEX_KEY_64.test(trimmed)) return true;
  return false;
}

export function isValidShareLink(link: string): boolean {
  const parsed = canonicalizeShareLink(link, "external");
  return parsed.ok && parsed.kind === "share";
}

/**
 * THE record key: the 64-char lowercase hex key, or null.
 *
 * `reconcileShareRecord`, `reconcileReceivedRunner` and
 * `buildShareKeyDriveIndex` all key on this, so it has to answer the same
 * for every shape of the same link — which is what `canonicalizeShareLink`
 * guarantees. Accepts prose and bare keys (`pasted`) because its callers
 * are handed values that already came through `normalizeShareLink`.
 */
export function extractKey(link: string): string | null {
  const parsed = canonicalizeShareLink(link, "pasted");
  return parsed.ok && parsed.kind === "share" ? parsed.key : null;
}

/* ------------------------------------------------------------------ *
 * the canonical parser.
 *
 * Every function above delegates here. The shape it validates against is
 * the one the engine actually mints: `createShareLink(keyHex)` in
 * backend/hyperdrive-engine.mjs returns exactly `peardrop://${keyHex}`,
 * where keyHex is a Hyperdrive public key rendered as 64 lowercase hex
 * characters.
 *
 * Returns a typed result rather than throwing — one caller is a linking
 * callback that must never take the app down.
 * ------------------------------------------------------------------ */

/** Engine keys are 32 bytes rendered as hex. */
const SHARE_KEY_HEX_LENGTH = 64;

/**
 * Hard ceiling on an EXTERNAL link. A launch URL is attacker-controlled in
 * length; bail before doing regex work on it.
 *
 * note: the floor is no longer `peardrop://` + 64 + a slash — a
 * legitimate link now arrives with a messenger's tracking parameters on
 * it, which is why 2048 rather than something tight. The paste path is not
 * capped at all: a good link buried in a long forwarded message is a shape
 * exists to accept, and a human typing is not a threat model.
 */
export const MAX_INCOMING_LINK_LENGTH = 2048;

export type ShareLinkRejection =
  /** Null, non-string, or nothing but whitespace. */
  | "empty"
  /** Longer than MAX_INCOMING_LINK_LENGTH before any parsing. */
  | "too-long"
  /** Doesn't begin with the `peardrop://` scheme. */
  | "not-a-peardrop-link"
  /**
   * Right scheme, but nothing survives the strip as a bare key — the
   * remainder was empty, or it carries a path segment. A query string and a
   * fragment do not land here; they are stripped.
   */
  | "malformed"
  /** Right scheme, key is hex, but not 64 characters. */
  | "bad-key-length"
  /** Right scheme, but the key contains non-hex characters. */
  | "bad-key-charset";

/**
 * The offline demo share. Duplicated from `DEMO_LINK` in `lib/demo.ts`
 * rather than imported: demo.ts pulls in expo-asset and react-native-fs,
 * and this module has to stay RN-free to remain reachable by Jest. The
 * two must stay in sync; `links.test.ts` pins the literal.
 */
export const DEMO_SHARE_LINK = "peardrop://demo";

/**
 * intent kind for a URL that arrived on the `peardrop`
 * scheme but failed `parseIncomingShareLink`.
 *
 * The value carried alongside this kind is the **raw path**, not the
 * rejection reason. `pendingIntents` dedupes on `(kind, value)`, so
 * keying on the reason would collapse two different malformed links
 * arriving in the same window into a single toast.
 *
 * Declared here rather than in `pendingIntents.ts` because it is
 * share-link vocabulary, and that module is deliberately generic. (Its
 * sibling `INTENT_SHARE_LINK` predates this and still lives there; worth
 * consolidating one day, not worth the import churn today.)
 */
export const INTENT_SHARE_LINK_REJECTED = "share-link-rejected";

export type ParsedShareLink =
  | {
      ok: true;
      /** An engine-minted share. */
      kind: "share";
      /** Canonical lowercase `peardrop://<key>`, safe to hand to the resolve path. */
      link: string;
      /** The 64-char lowercase hex key on its own. */
      key: string;
    }
  | {
      ok: true;
      /** The bundled offline demo share — no key, no peer, no network. */
      kind: "demo";
      /** Always `DEMO_SHARE_LINK`; `runResolve` routes it via `isDemoLink`. */
      link: string;
    }
  | { ok: false; reason: ShareLinkRejection };

/**
 * The canonical parser. Every entry path — paste, QR scan, deep link, and
 * every downstream key derivation — reaches this function, and nothing else
 * normalises a link anywhere in `src/`.
 *
 * The strip, in order: whitespace; the `peardrop://` scheme, anchored for
 * `external` and scraped out of prose for `pasted`; query string and fragment
 * discarded, never read; trailing `/` and `.` discarded in any number, since
 * neither is hex and no key can be shortened by it; a surviving `/` means a
 * path segment and is `malformed`, so `peardrop://host/<key>` must not
 * resolve as `<key>`; then `demo`, else 64 hex, lowercased.
 *
 * Nothing narrows: no shape the parser accepts may become rejected. The
 * paste-path scrape takes the first candidate with a non-empty body, because
 * `[^\s]*` matches zero characters and a bare `peardrop://` token earlier in
 * the same paste would otherwise shadow the real link.
 *
 * The scheme match uses `.` rather than `[\s\S]`, so an embedded newline
 * still fails to match and `peardrop://\n<key>` stays rejected: `.*` not
 * crossing a line break is what keeps a multi-line payload from being read
 * as one link.
 */
export function canonicalizeShareLink(
  raw: unknown,
  trust: LinkTrust
): ParsedShareLink {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  // Length-check the raw string, before trim allocates a copy of it. Only
  // on the external side: that is where length is attacker-controlled. A
  // paste is bounded by what a human is willing to paste, and capping it
  // would drop a good link buried in a long forwarded message.
  if (trust === "external" && raw.length > MAX_INCOMING_LINK_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // ---- Step 3: get to the part after the scheme. The ONLY place the two
  // trust classes differ in how they read the string. ----
  let body: string;
  /**
   * Did the `peardrop://` scheme actually appear? False only on the paste
   * path's bare-token fallback. Read once, by the demo allowlist below.
   */
  let sawScheme: boolean;
  if (trust === "external") {
    // Anchored: an intent URL is the whole payload or it's junk. A web
    // page can fire this without the user ever seeing the string, so
    // "there is a link somewhere in here" is not good enough.
    const schemeMatch = trimmed.match(/^peardrop:\/\/(.*)$/i);
    if (!schemeMatch) return { ok: false, reason: "not-a-peardrop-link" };
    body = schemeMatch[1] ?? "";
    sawScheme = true;
  } else {
    // A human pasted this, possibly with the message it arrived in.
    //
    // `[^\s]*` rather than `[^\s]+` so that a bare `peardrop://` is reachable
    // at all — but `*` matches zero characters, so with a single non-global
    // match a bare scheme token earlier in the same paste wins and shadows
    // the real link behind it:
    //
    //   "see peardrop:// then peardrop://<64 hex>"
    //      with a single `*` match: null
    //
    // That is a narrowing, and this module's contract is that nothing
    // narrows. Scrape every candidate and take the first one with anything
    // after the scheme; the
    // all-empty case then still falls through to the `*` behaviour.
    const scraped = trimmed.match(/peardrop:\/\/[^\s]*/gi);
    if (scraped) {
      const bodies = scraped.map((m) => m.replace(/^peardrop:\/\//i, ""));
      body = bodies.find((candidate) => candidate !== "") ?? "";
      sawScheme = true;
    } else {
      // No scheme: a bare key is the third shape people paste.
      body = trimmed;
      sawScheme = false;
    }
  }

  // ---- Steps 4-6: THE STRIP. One copy, reached by every entry path. ----
  // Query string and fragment, whichever comes first.
  body = body.split(/[?#]/)[0] ?? "";
  // Trailing slashes and full stops, in any combination: launchers append
  // `/`, prose appends `.`, and a link at the end of a sentence in a
  // message gets both.
  //
  // Written as a scan rather than `replace(/[./]+$/, "")`: the
  // anchored quantifier backtracks quadratically over a long interior run of
  // `.`/`/` that is not at end-of-string — measured 237 ms at n=20,000 and
  // 3,883 ms at n=80,000. Only a human paste can reach it (an external
  // payload hits `too-long` first), but it is a three-line rewrite.
  let end = body.length;
  while (end > 0) {
    const code = body.charCodeAt(end - 1);
    // 46 = '.', 47 = '/'
    if (code !== 46 && code !== 47) break;
    end -= 1;
  }
  if (end !== body.length) body = body.slice(0, end);
  if (!body) return { ok: false, reason: "malformed" };
  // A surviving slash is a path segment, not a key.
  if (body.includes("/")) return { ok: false, reason: "malformed" };

  // ---- Step 7 ----
  // The single allowlist entry, reached through the same strip as a real
  // key. It is still a literal match, not a loosening of key
  // validation — `peardrop://demo2` and every other near-miss fail the
  // charset check exactly as before. The demo share resolves offline
  // against six bundled files, which makes it the only end-to-end proof of
  // the incoming-link chain that needs no network or second device.
  //
  // `sawScheme` is required. Without it the bare-token
  // fallback makes `normalizeShareLink("demo")` return `peardrop://demo`,
  // and typing `demo` and pressing submit
  // opens the bundled demo share: `shouldAttemptResolve("demo")` is false
  // so the debounce never fires, but the submit path calls
  // `runResolve(linkDraft)` directly and ungated. The
  // bare-token fallback exists for a bare 64-hex key — an unambiguous
  // engine-minted value — and
  // an English word is not that.
  if (sawScheme && body.toLowerCase() === "demo") {
    return { ok: true, kind: "demo", link: DEMO_SHARE_LINK };
  }

  if (!/^[a-fA-F0-9]+$/.test(body)) {
    return { ok: false, reason: "bad-key-charset" };
  }
  if (body.length !== SHARE_KEY_HEX_LENGTH) {
    return { ok: false, reason: "bad-key-length" };
  }

  const key = body.toLowerCase();
  return { ok: true, kind: "share", link: `peardrop://${key}`, key };
}

/**
 * The external-trust entry point: an Android VIEW intent
 * (`app/+native-intent.ts:55`) and a QR scan (`src/lib/scanOutcome.ts:58`).
 *
 * Kept as its own exported name because both call sites and their tests
 * use it, and because the name states the trust class at the call site.
 * It adds nothing — it is `canonicalizeShareLink(raw, "external")`.
 */
export function parseIncomingShareLink(raw: unknown): ParsedShareLink {
  return canonicalizeShareLink(raw, "external");
}
