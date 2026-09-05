/**
 * Normalization + validation helpers for peardrop share links.
 *
 * A peardrop share link looks like `peardrop://<64 hex chars>`. In practice
 * users paste or scan three shapes:
 *   1. Already-normalized:  peardrop://ab...                → return as-is
 *   2. Prefixed noise:      "Here: peardrop://ab..."        → strip the prefix
 *   3. Bare key:            "ab..." (64 hex chars)          → prepend scheme
 *
 * Anything else is returned untouched so the caller can present a friendly
 * error; treat the return value as "best-effort normalized".
 */

const HEX_KEY_64 = /^[a-fA-F0-9]{64}$/;
const PEARDROP_URL = /peardrop:\/\/[^\s]+/i;

export function normalizeShareLink(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const match = trimmed.match(PEARDROP_URL);
  if (match) return match[0];
  if (HEX_KEY_64.test(trimmed)) return `peardrop://${trimmed}`;
  return trimmed;
}

export function shouldAttemptResolve(text: string): boolean {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (/peardrop:\/\//i.test(trimmed)) return true;
  if (HEX_KEY_64.test(trimmed)) return true;
  return false;
}

export function isValidShareLink(link: string): boolean {
  const trimmed = String(link || "").trim();
  const match = trimmed.match(/^peardrop:\/\/([a-fA-F0-9]+)$/);
  if (!match || !match[1]) return false;
  return match[1].length === 64;
}

export function extractKey(link: string): string | null {
  const normalized = normalizeShareLink(link);
  const match = normalized.match(/^peardrop:\/\/([a-fA-F0-9]{64})$/i);
  return match && match[1] ? match[1].toLowerCase() : null;
}

/* ------------------------------------------------------------------ *
 * Strict validation for externally-supplied links.
 *
 * The functions above are deliberately forgiving: they serve the paste
 * and scan affordances, where the input came from a human who is looking
 * at the screen and can be shown a friendly error. `normalizeShareLink`
 * in particular performs no validation at all — it will happily hand
 * back `peardrop://<arbitrary-garbage>` scraped out of the middle of a
 * sentence.
 *
 * An intent-filter link is a different trust class. The VIEW filter
 * carries BROWSABLE, so any web page can fire a `peardrop://` URL at the
 * app without the user ever having seen the string. Those links get
 * parsed here instead, against the shape the engine actually mints:
 * `createShareLink(keyHex)` in backend/hyperdrive-engine.mjs returns
 * exactly `peardrop://${keyHex}`, where keyHex is a Hyperdrive public
 * key rendered as 64 lowercase hex characters.
 *
 * Returns a typed result rather than throwing — the caller is a linking
 * callback that must never take the app down.
 * ------------------------------------------------------------------ */

/** Engine keys are 32 bytes rendered as hex. */
const SHARE_KEY_HEX_LENGTH = 64;

/**
 * Hard ceiling on anything we'll even look at. A launch URL is attacker-
 * controlled in length; bail before doing regex work on it. The longest
 * legitimate link is `peardrop://` + 64 + an optional trailing slash.
 */
export const MAX_INCOMING_LINK_LENGTH = 2048;

export type ShareLinkRejection =
  /** Null, non-string, or nothing but whitespace. */
  | "empty"
  /** Longer than MAX_INCOMING_LINK_LENGTH before any parsing. */
  | "too-long"
  /** Doesn't begin with the `peardrop://` scheme. */
  | "not-a-peardrop-link"
  /** Right scheme, but the remainder isn't a bare key (empty, query, path, fragment). */
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
 * Intent kind for a URL that arrived on the `peardrop`
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
 * Strictly parse a link that arrived from outside the app (an Android
 * VIEW intent today; a notification payload once that lands).
 *
 * Accepts only `peardrop://<64 hex>`, case-insensitively on both the
 * scheme and the key, with at most one trailing slash — browsers and
 * launchers routinely normalize `scheme://host` to `scheme://host/`, and
 * dropping an otherwise-valid share over that would be a bad trade.
 * Everything else — surrounding text, bare keys, query strings, paths,
 * fragments — is rejected. Those shapes remain reachable through the
 * paste path, which is where a human is present to read an error message.
 *
 * There is exactly one allowlist entry: `peardrop://demo`. It is a
 * literal match, not a loosening of key validation — `peardrop://demo2`
 * and every other near-miss still fail the same charset check they
 * always did. The demo share resolves offline against six bundled files,
 * which makes it the only end-to-end proof of the whole incoming-link
 * chain that needs no network or second device. The threat model doesn't
 * argue against it: a web page firing `peardrop://demo` opens a preview
 * of six local files and nothing else happens.
 */
export function parseIncomingShareLink(raw: unknown): ParsedShareLink {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  // Length-check the raw string, before trim allocates a copy of it.
  if (raw.length > MAX_INCOMING_LINK_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // Anchored: the scheme must start the string. `normalizeShareLink`
  // scrapes a link out of surrounding prose, which is right for a paste
  // and wrong here — an intent URL is the whole payload or it's junk.
  const schemeMatch = trimmed.match(/^peardrop:\/\/(.*)$/i);
  if (!schemeMatch) return { ok: false, reason: "not-a-peardrop-link" };

  // Tolerate exactly one trailing slash, nothing else after the key.
  const remainder = (schemeMatch[1] ?? "").replace(/\/$/, "");
  if (!remainder) return { ok: false, reason: "malformed" };
  // A second slash, a query, or a fragment means this isn't a bare key.
  if (/[/?#]/.test(remainder)) return { ok: false, reason: "malformed" };

  // The one allowlist entry, checked after the structural rules so
  // `peardrop://demo?x=1` is still malformed. Exact literal match only.
  if (remainder.toLowerCase() === "demo") {
    return { ok: true, kind: "demo", link: DEMO_SHARE_LINK };
  }

  if (!/^[a-fA-F0-9]+$/.test(remainder)) {
    return { ok: false, reason: "bad-key-charset" };
  }
  if (remainder.length !== SHARE_KEY_HEX_LENGTH) {
    return { ok: false, reason: "bad-key-length" };
  }

  const key = remainder.toLowerCase();
  return { ok: true, kind: "share", link: `peardrop://${key}`, key };
}
