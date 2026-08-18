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
