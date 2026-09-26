// Structured engine errors. Every engine failure — thrown or returned via
// {ok:false, error} — is an EngineError carrying a dot-namespaced `category`
// stable across releases, a short machine-readable `cause` that RN
// pattern-matches on, a human-readable `message` never used for control flow,
// and an optional JSON-serializable `detail`.
//
// `JSON.stringify` calls `toJSON()` automatically, so an instance survives the
// RPC boundary and RN receives a plain object of the same shape; `toString()`
// returns the message so a defensive `String(err)` in RN degrades cleanly.
//
// Construction logs the error, so no call site needs its own logging.

import { blog, describeError } from "./debug-log.mjs";

export class EngineError extends Error {
  constructor({ category, cause, message, detail }) {
    super(message ?? cause ?? String(category ?? "unknown"));
    this.name = "EngineError";
    this.category = String(category ?? "internal.unexpected");
    this.cause = String(cause ?? "unknown");
    if (detail !== undefined) this.detail = detail;
    // self-record. `blog` is a no-op when debugging is off, so
    // this costs one boolean test on the error path when the flag is down.
    blog("error", "engine.error", describeError(this));
  }

  toJSON() {
    const out = {
      category: this.category,
      cause: this.cause,
      message: this.message,
    };
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }

  toString() {
    return this.message || `${this.category}:${this.cause}`;
  }
}

// Wrap an arbitrary caught value into an EngineError, preserving the
// underlying message and code and falling back to a generic category / cause.
// An already-typed error passes through, so wrapping is idempotent.
export function wrapError(err, { category, cause, message, detail } = {}) {
  if (err instanceof EngineError) {
    // Already typed (and already logged at construction) — record the
    // pass-through so the propagation path is visible in the trace.
    blog("debug", "engine.error", `passthrough at ${category || "?"} — cause=${err.cause}`);
    return err;
  }
  return new EngineError({
    category: category || "internal.unexpected",
    cause: cause || err?.code || "unknown",
    message: message || String(err?.message || err),
    detail: {
      ...(detail || {}),
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.name && err.name !== "Error" ? { originalName: err.name } : {}),
    },
  });
}

// Produces the {ok:false, error: EngineError} failure-return shape.
export function failure(category, cause, message, detail) {
  return {
    ok: false,
    error: new EngineError({ category, cause, message, detail }),
  };
}
