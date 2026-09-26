/**
 * An incoming link must not swap the open preview or a running grab, and must
 * not be lost. Runs against the real `src/lib/incomingLinkQueue.ts`, the
 * module `IncomingLinkBridge.tsx`'s handler and drain effect both delegate
 * to; nothing is mocked and the module has no imports.
 *
 * The suite collects only `*.test.ts`, so that the handler consults this, and
 * that the drain effect fires when the busy flags clear, are not asserted
 * here. The queue semantics they depend on are asserted in full.
 */

import {
  decideIncomingLink,
  isBusy,
  shouldDrain,
  type IncomingLinkState,
} from "../incomingLinkQueue";

const A = `peardrop://${"a".repeat(64)}`;
const B = `peardrop://${"b".repeat(64)}`;

const idle: IncomingLinkState = {
  previewVisible: false,
  downloadBusy: false,
  resolving: false,
  heldLink: null,
};

describe("a link arriving while the user is busy", () => {
  /**
   * The probe. An intent handler that calls `resolveFromScan` with no check
   * overwrites `openResult` while a preview is open, and the modal's contents
   * change underneath the user.
   */
  it("does not resolve while a preview is open", () => {
    expect(decideIncomingLink(A, { ...idle, previewVisible: true }).action).toBe("hold");
  });

  /**
   * The worse of the two: the running grab's failure is reported through
   * `linkError`, which the preview renders — so the first share's error
   * appears under the second share's name.
   */
  it("does not resolve while a grab is running", () => {
    expect(decideIncomingLink(A, { ...idle, downloadBusy: true }).action).toBe("hold");
  });

  it("does not resolve while a resolve is already in flight", () => {
    expect(decideIncomingLink(A, { ...idle, resolving: true }).action).toBe("hold");
  });

  it("resolves immediately when nothing is in the way", () => {
    expect(decideIncomingLink(A, idle)).toEqual({ action: "resolve", link: A });
  });

  it("agrees with isBusy on every combination", () => {
    for (const previewVisible of [true, false]) {
      for (const downloadBusy of [true, false]) {
        for (const resolving of [true, false]) {
          const state = { ...idle, previewVisible, downloadBusy, resolving };
          const busy = isBusy(state);
          expect([state, decideIncomingLink(A, state).action]).toEqual([
            state,
            busy ? "hold" : "resolve",
          ]);
        }
      }
    }
  });
});

describe("the held link is never silently lost", () => {
  it("always tells the user it held something", () => {
    const d = decideIncomingLink(A, { ...idle, previewVisible: true });
    expect(d.action).toBe("hold");
    if (d.action !== "hold") throw new Error("unreachable");
    expect(d.notice.length).toBeGreaterThan(0);
  });

  it("replaces an older held link with the newer one, and says so", () => {
    const d = decideIncomingLink(B, { ...idle, previewVisible: true, heldLink: A });
    expect(d.action).toBe("hold");
    if (d.action !== "hold") throw new Error("unreachable");
    expect(d.link).toBe(B);
    // The notice must be different from the first-hold one — replacing
    // silently would be the same drop in a different place.
    const first = decideIncomingLink(A, { ...idle, previewVisible: true });
    if (first.action !== "hold") throw new Error("unreachable");
    expect(d.notice).not.toBe(first.notice);
  });

  it("absorbs the same link arriving twice, so a resume re-delivery is quiet", () => {
    expect(decideIncomingLink(A, { ...idle, previewVisible: true, heldLink: A })).toEqual({
      action: "already-held",
      link: A,
    });
  });

  it("drains exactly when a link is held and the user is free", () => {
    expect(shouldDrain({ ...idle, heldLink: A })).toBe(true);
    expect(shouldDrain({ ...idle, heldLink: null })).toBe(false);
    expect(shouldDrain({ ...idle, heldLink: A, previewVisible: true })).toBe(false);
    expect(shouldDrain({ ...idle, heldLink: A, downloadBusy: true })).toBe(false);
    expect(shouldDrain({ ...idle, heldLink: A, resolving: true })).toBe(false);
  });

  it("holds the trimmed link, so the drain resolves exactly what arrived", () => {
    const d = decideIncomingLink(`  ${A}  `, { ...idle, previewVisible: true });
    if (d.action !== "hold") throw new Error("unreachable");
    expect(d.link).toBe(A);
  });

  it("has no branch that acts on an empty payload", () => {
    for (const empty of ["", "   "]) {
      expect(decideIncomingLink(empty, idle).action).toBe("already-held");
      expect(decideIncomingLink(empty, { ...idle, previewVisible: true }).action).toBe(
        "already-held",
      );
    }
  });

  it("says nothing about connectivity or expiry when it holds a link", () => {
    const d = decideIncomingLink(A, { ...idle, downloadBusy: true });
    if (d.action !== "hold") throw new Error("unreachable");
    const text = d.notice.toLowerCase();
    for (const banned of ["network", "offline", "internet", "wi-fi", "wifi", "expire"]) {
      expect([banned, text.includes(banned)]).toEqual([banned, false]);
    }
  });
});
