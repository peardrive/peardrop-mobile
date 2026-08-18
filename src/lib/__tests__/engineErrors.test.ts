// Tripwire for the EngineError base class + wrap/failure helpers. The module
// is vanilla JS and Jest could load it directly, but mirroring it keeps the
// test hermetic and the module boundary intact.

import { errorMessage, errorCause } from "../errorMessage";

// Mirror of backend/engine-errors.mjs. If the .mjs shape changes, this
// mirror must be updated too.
class EngineError extends Error {
  category: string;
  override cause: string;
  detail?: unknown;

  constructor({
    category,
    cause,
    message,
    detail,
  }: {
    category: string;
    cause: string;
    message?: string;
    detail?: unknown;
  }) {
    super(message ?? cause ?? String(category ?? "unknown"));
    this.name = "EngineError";
    this.category = String(category ?? "internal.unexpected");
    this.cause = String(cause ?? "unknown");
    if (detail !== undefined) this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      category: this.category,
      cause: this.cause,
      message: this.message,
    };
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }

  override toString(): string {
    return this.message || `${this.category}:${this.cause}`;
  }
}

function wrapError(
  err: unknown,
  opts: { category?: string; cause?: string; message?: string } = {},
): EngineError {
  if (err instanceof EngineError) return err;
  const anyErr = err as { message?: string; code?: string; name?: string };
  return new EngineError({
    category: opts.category || "internal.unexpected",
    cause: opts.cause || anyErr?.code || "unknown",
    message: opts.message || String(anyErr?.message || err),
  });
}

function failure(
  category: string,
  cause: string,
  message?: string,
  detail?: unknown,
) {
  return {
    ok: false as const,
    error: new EngineError({ category, cause, message, detail }),
  };
}

// --- Tests --- //

describe("EngineError tripwire", () => {
  test("scenario 1 — construct with category/cause/message/detail", () => {
    const err = new EngineError({
      category: "receive.stall",
      cause: "file-stall",
      message: "stalled: no data for 60s",
      detail: { destPath: "/x/y" },
    });
    expect(err.category).toBe("receive.stall");
    expect(err.cause).toBe("file-stall");
    expect(err.message).toBe("stalled: no data for 60s");
    expect(err.detail).toEqual({ destPath: "/x/y" });
  });

  test("scenario 2 — is throwable and catchable as Error", () => {
    let caught: unknown;
    try {
      throw new EngineError({ category: "engine.not-initialized", cause: "not-initialized" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as EngineError).category).toBe("engine.not-initialized");
  });

  test("scenario 3 — toJSON produces the wire shape (no name/stack leak)", () => {
    const err = new EngineError({
      category: "share.file-read-fail",
      cause: "share-file-unreadable",
      message: "Cannot read file (/tmp/x): ENOENT",
    });
    const j = err.toJSON();
    expect(j).toEqual({
      category: "share.file-read-fail",
      cause: "share-file-unreadable",
      message: "Cannot read file (/tmp/x): ENOENT",
    });
    // Stack and name must not leak — JSON.stringify's default includes
    // enumerable own properties only.
    expect(Object.keys(j)).not.toContain("stack");
    expect(Object.keys(j)).not.toContain("name");
  });

  test("scenario 4 — toJSON omits detail when undefined", () => {
    const err = new EngineError({ category: "x", cause: "y", message: "z" });
    expect(err.toJSON()).toEqual({ category: "x", cause: "y", message: "z" });
  });

  test("scenario 5 — JSON.stringify calls toJSON automatically (RPC wire shape)", () => {
    const err = new EngineError({
      category: "receive.invalid-link",
      cause: "invalid-link",
      message: "expect peardrop:// + 64 hex chars",
    });
    const wire = JSON.parse(JSON.stringify({ ok: false, error: err }));
    // Round-trip preserves category / cause / message.
    expect(wire).toEqual({
      ok: false,
      error: {
        category: "receive.invalid-link",
        cause: "invalid-link",
        message: "expect peardrop:// + 64 hex chars",
      },
    });
  });

  test("scenario 6 — toString returns the message", () => {
    const err = new EngineError({
      category: "receive.stall",
      cause: "file-stall",
      message: "stalled: no data for 60s",
    });
    expect(String(err)).toBe("stalled: no data for 60s");
  });

  test("scenario 7 — toString falls back to category:cause when message is falsy", () => {
    // `??` treats "" as a valid string, so an explicit empty message
    // stays empty; toString then falls back to "category:cause".
    const explicit = new EngineError({ category: "x", cause: "y", message: "" });
    expect(explicit.message).toBe("");
    expect(String(explicit)).toBe("x:y");

    // Undefined message uses `??` chain → cause becomes the message.
    const noMessage = new EngineError({ category: "x", cause: "y" });
    expect(noMessage.message).toBe("y");
    expect(String(noMessage)).toBe("y");
  });

  test("scenario 8 — wrapError is idempotent on an EngineError", () => {
    const inner = new EngineError({ category: "x.y", cause: "z" });
    const outer = wrapError(inner, { category: "wrong", cause: "wrong" });
    expect(outer).toBe(inner);
    expect(outer.category).toBe("x.y");
  });

  test("scenario 9 — wrapError promotes a raw fs error", () => {
    const raw = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const wrapped = wrapError(raw, {
      category: "manifest.write-fail",
      cause: "manifest-write-fail",
    });
    expect(wrapped).toBeInstanceOf(EngineError);
    expect(wrapped.category).toBe("manifest.write-fail");
    expect(wrapped.cause).toBe("manifest-write-fail");
    expect(wrapped.message).toBe("EACCES: permission denied");
  });

  test("scenario 10 — failure() helper produces the {ok:false, error} shape", () => {
    const res = failure(
      "receive.no-session",
      "session-not-found",
      "Session not found — open the link first.",
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(EngineError);
    expect(res.error.cause).toBe("session-not-found");
  });
});

// The RN-side helper for extracting a display string from a wire-shaped
// error must handle both raw strings (legacy paths) and structured
// objects (new default).
describe("errorMessage helper (RN-side)", () => {
  test("null / undefined return null", () => {
    expect(errorMessage(null)).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
  });

  test("plain string passes through", () => {
    expect(errorMessage("boom")).toBe("boom");
  });

  test("EngineError-shaped object returns the message", () => {
    expect(
      errorMessage({
        category: "receive.stall",
        cause: "file-stall",
        message: "stalled: no data for 60s",
      }),
    ).toBe("stalled: no data for 60s");
  });

  test("object without message falls back to null", () => {
    expect(errorMessage({ category: "x", cause: "y" })).toBeNull();
  });

  test("errorCause returns the cause when present", () => {
    expect(
      errorCause({ category: "receive.stall", cause: "file-stall", message: "..." }),
    ).toBe("file-stall");
    expect(errorCause({ category: "x" })).toBeNull();
    expect(errorCause(null)).toBeNull();
    expect(errorCause("string")).toBeNull();
  });
});
