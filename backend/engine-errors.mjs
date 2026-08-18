// Structured engine errors. Every engine failure — thrown, or returned as
// {ok:false, error} — is an EngineError:
//
//   category  dot-namespaced bucket, e.g. "receive.stall". Stable across releases.
//   cause     machine-readable id within the category. RN pattern-matches on this.
//   message   human-readable. Never used for control flow.
//   detail?   optional JSON-serializable payload (error code, offending key, …).
//
// toJSON() is what makes an instance survive the RPC boundary — JSON.stringify
// calls it automatically, so RN receives an identically shaped plain object.
// toString() returns the message so defensive String(err) in RN degrades cleanly.

import { blog, describeError } from "./debug-log.mjs";

export class EngineError extends Error {
  constructor({ category, cause, message, detail }) {
    super(message ?? cause ?? String(category ?? "unknown"));
    this.name = "EngineError";
    this.category = String(category ?? "internal.unexpected");
    this.cause = String(cause ?? "unknown");
    if (detail !== undefined) this.detail = detail;
    // Self-record, so every construction site is instrumented without
    // per-site logging. `blog` is a no-op when debugging is off.
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

// Wrap an arbitrary caught value (bare-fs, hyperdrive, hyperswarm) into an
// EngineError, preserving the underlying message and code.
export function wrapError(err, { category, cause, message, detail } = {}) {
  // Idempotent: an already-typed error passes through unchanged rather than
  // being re-wrapped, so nesting wrapError calls can't bury the original
  // category/cause. Logged so the propagation path stays visible.
  if (err instanceof EngineError) {
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

// Produces the {ok:false, error: EngineError} shape.
export function failure(category, cause, message, detail) {
  return {
    ok: false,
    error: new EngineError({ category, cause, message, detail }),
  };
}
