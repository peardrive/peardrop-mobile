// `out.error` from any bridge call is a structured {category, cause, message,
// detail?} object, not a string — rendering it directly yields "[object
// Object]". This extracts a display string; branch on `.cause` for typed
// handling instead.

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
  // Guards against shape changes producing a bare "[object Object]".
  try {
    const s = String(err);
    return s && s !== "[object Object]" ? s : null;
  } catch {
    return null;
  }
}

// Machine-readable cause for typed branching (retry hints, recovery flows).
// Null for raw strings, plain Errors, and nullish input.
export function errorCause(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null;
  const cause = (err as EngineErrorLike).cause;
  return typeof cause === "string" && cause.length > 0 ? cause : null;
}
