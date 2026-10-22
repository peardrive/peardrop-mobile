// `out.error` is `{category, cause, message, detail?}`, so rendering it directly gives
// "[object Object]". Branch on `.cause` for typed handling.

import { MANIFEST_UNAVAILABLE_MESSAGE } from "./shareListEmptyState";

export type EngineErrorLike = {
  category?: string;
  cause?: string;
  message?: string;
  detail?: unknown;
};

export function errorMessage(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const message = (err as EngineErrorLike).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  // Fallback: stringify. Guards against future shape changes producing
  // "[object Object]" without a fallback path.
  try {
    const s = String(err);
    return s && s !== "[object Object]" ? s : null;
  } catch {
    return null;
  }
}

/** Curated lines keyed by an error's `cause`. Raw engine or native text is never returned, and
 *  the caller's own fallback wins unless there is a true thing to say. */
export const CURATED_BY_CAUSE: Record<string, string> = {
  "manifest-unavailable": MANIFEST_UNAVAILABLE_MESSAGE,
};

/** A line that is safe to show a user for `err`. Never returns engine or
 *  native text; the fallback the caller already had is what renders. */
export function userFacingError(err: unknown, fallback: string): string {
  const cause = errorCause(err);
  if (cause) {
    const curated = CURATED_BY_CAUSE[cause];
    if (curated) return curated;
  }
  return fallback;
}

// The machine-readable cause of an error result, for typed branching. Null
// when there is none: raw strings, plain Error instances, nullish input.
export function errorCause(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null;
  const cause = (err as EngineErrorLike).cause;
  return typeof cause === "string" && cause.length > 0 ? cause : null;
}
