// Helper for extracting a display-safe string from an engine
// error result. `out.error` from any bridge call is a
// structured object of shape `{category, cause, message, detail?}` —
// not a raw string. Rendering `out.error` directly produces
// "[object Object]". This helper pulls
// the `.message` field out, falls back to stringifying the value if it
// isn't shaped as expected, and returns null if the input is nullish.
//
// Usage:
//   showToast(errorMessage(out.error) ?? "Couldn't do the thing", "error");
//
// Callers can also branch on `.cause` for typed handling — this helper
// is only for the "I want a display string" path.

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

// Returns the machine-readable cause of an error result if present.
// Callers use this for typed branching (retry hints, specific recovery
// flows). Returns null when the error has no cause (raw strings, plain
// Error instances, or nullish input).
export function errorCause(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null;
  const cause = (err as EngineErrorLike).cause;
  return typeof cause === "string" && cause.length > 0 ? cause : null;
}
