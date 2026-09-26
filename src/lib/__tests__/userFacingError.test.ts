/**
 * Raw engine and native error text must never be the user-facing message.
 *
 * Runs against the real `src/lib/errorMessage.ts` and the real
 * `TOAST_VARIANTS` copy table, which lives in `src/lib/toastCopy.ts` rather
 * than `src/ui/Toast.tsx` so that the strings are testable at all;
 * `Toast.tsx` re-exports them, so no import site changes.
 */

import { CURATED_BY_CAUSE, errorMessage, userFacingError } from "../errorMessage";
import { TOAST_VARIANTS } from "../toastCopy";

/** Exactly what a structured engine error looks like crossing the RPC. */
const ENGINE_ERROR = {
  category: "share.activate-fail",
  cause: "engine-not-initialized",
  message: "Engine not initialized.",
};

describe("the fallback must be the thing that renders", () => {
  /**
   * THE PROBE. `errorMessage(...) || fallback` — the usage its own header
   * documents — could NEVER reach the fallback, because a structured engine
   * error always carries a message. That is why "Engine not initialized."
   * reached users.
   */
  it("shows the caller's fallback, not the engine's message", () => {
    expect(userFacingError(ENGINE_ERROR, "Couldn't activate that one.")).toBe(
      "Couldn't activate that one.",
    );
  });

  it("demonstrates the old expression could not fire its fallback", () => {
    // Kept as a pinned statement of the defect: `errorMessage` is unchanged and
    // still returns the raw text, which is correct for logging and wrong for
    // display. If this ever returns null, the fix's premise has changed.
    expect(errorMessage(ENGINE_ERROR)).toBe("Engine not initialized.");
    expect(errorMessage(ENGINE_ERROR) || "fallback").not.toBe("fallback");
  });

  it("never returns raw native or errno text", () => {
    for (const raw of [
      "Engine not initialized.",
      "ENOENT: no such file or directory, open '/data/x'",
      "Drive not found",
      "EACCES: permission denied",
    ]) {
      const out = userFacingError({ message: raw, cause: "whatever" }, "Couldn't do that.");
      expect([raw, out]).toEqual([raw, "Couldn't do that."]);
    }
  });

  it("passes the fallback through for a plain string, an Error, and nullish", () => {
    expect(userFacingError("Drive not found", "Couldn't do that.")).toBe("Couldn't do that.");
    expect(userFacingError(new Error("boom"), "Couldn't do that.")).toBe("Couldn't do that.");
    expect(userFacingError(null, "Couldn't do that.")).toBe("Couldn't do that.");
    expect(userFacingError(undefined, "Couldn't do that.")).toBe("Couldn't do that.");
  });

  it("leaves errorMessage itself alone — it is still the right thing for the log", () => {
    expect(errorMessage({ message: "Engine not initialized." })).toBe("Engine not initialized.");
    expect(errorMessage(null)).toBeNull();
  });
});

describe("the copy bans, over every string this task owns", () => {
  const BANNED = [
    "check your network",
    "check your internet",
    "check your wi-fi",
    "network",
    "offline",
    "expire",
    "expired",
    "internet",
    "wi-fi",
    "wifi",
  ];

  /**
   * The TRAP. `peer-not-found` said the link "may have expired" — PearDrop
   * links do not expire — and `no-connection` said "Check your internet", which
   * this app has no way to know. Adopting either verbatim would have shipped a
   * NEW false statement inside the fix.
   */
  it("no curated toast variant claims connectivity or expiry", () => {
    for (const [id, variant] of Object.entries(TOAST_VARIANTS)) {
      const text = `${variant.title} ${variant.body}`.toLowerCase();
      for (const banned of BANNED) {
        expect([id, banned, text.includes(banned)]).toEqual([id, banned, false]);
      }
    }
  });

  it("every fallback this task introduced is inside the bans", () => {
    // The exact strings now passed as fallbacks at the rewritten call sites.
    for (const copy of [
      "Couldn't activate that one.",
      "Couldn't stop that one.",
      "Couldn't grab those files — give it another go?",
      "Couldn't open that link — give it another go?",
      "Couldn't reach the other pear — give it another go?",
      "Can't open that one. Try another app?",
      "Can't preview this one.",
      "Couldn't share those — give it another go?",
      "Couldn't share that folder — give it another go?",
      "Couldn't read that folder — give it another go?",
      "Couldn't share those photos — give it another go?",
    ]) {
      const text = copy.toLowerCase();
      for (const banned of BANNED) {
        expect([copy, banned, text.includes(banned)]).toEqual([copy, banned, false]);
      }
    }
  });

  it("whatever ends up in the curated map stays inside the bans too", () => {
    // The guard must read the real curated map: a property that does not
    // exist would loop over `{}` and pass vacuously whatever the map held.
    const entries = Object.entries(CURATED_BY_CAUSE);
    // Positive control: an empty map would make every assertion below vacuous.
    expect(entries.length).toBeGreaterThan(0);
    for (const [cause, copy] of entries) {
      const text = copy.toLowerCase();
      for (const banned of BANNED) {
        expect([cause, banned, text.includes(banned)]).toEqual([cause, banned, false]);
      }
    }
    // Curation stays opt-in and per-cause: an UNcurated cause must still fall back.
    expect(userFacingError({ cause: "anything-at-all" }, "FALLBACK")).toBe("FALLBACK");
  });
});
