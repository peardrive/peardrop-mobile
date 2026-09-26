import { cancelledRowLabel } from "../receiveProgress";
import { hostedRowStatus } from "../hostedRowStatus";

/**
 * The hosted half of the cancelled-row defect. The received half has a pure
 * deriver behind it; the hosted half was an inline chain in `MainScreen.tsx`,
 * which the suite cannot reach — `testMatch` collects only `*.test.ts` and
 * there are zero `*.test.tsx` files. This file exists because the chain moved
 * out.
 *
 * Everything below drives the real module: no engine, no React, no mocks.
 * That `MainScreen` renders this status onto the row is not covered and
 * cannot be from here.
 */

const hosted = (over: Partial<Parameters<typeof hostedRowStatus>[0] & object> = {}) => ({
  percent: null as number | null,
  completed: false,
  cancelled: false,
  ...over,
});

describe("hostedRowStatus", () => {
  // `markCancelled` is shared by both origins and sets `completed: true`
  // alongside `cancelled: true`, so without this module a hosted share the
  // user stopped falls past `transferring` to `else if (t?.completed)` and
  // reads "Completed". Fixing only the received row leaves this one.
  it("does NOT read as Completed when the user stopped the share", () => {
    const s = hostedRowStatus(hosted({ completed: true, cancelled: true }), {
      isActive: false,
    });
    expect(s.state).toBe("cancelled");
    expect(s.state).not.toBe("completed");
    expect(s.label).not.toBe("Completed");
    expect(s.label).toBe("Stopped");
    expect(s.tone).toBe("muted");
  });

  // The ordering probe, stated as its own assertion so it fails loudly if
  // the branch is ever moved below `completed`.
  it("puts the cancelled branch ABOVE completed, where it is reachable", () => {
    const cancelled = hostedRowStatus(hosted({ completed: true, cancelled: true }), {
      isActive: false,
    });
    const finished = hostedRowStatus(hosted({ completed: true, cancelled: false }), {
      isActive: false,
    });
    expect(cancelled.label).not.toBe(finished.label);
    expect(finished.label).toBe("Completed");
  });

  // Cancelling does not stop the drive being listed as active, and the
  // "Active" arm sits below both, so a cancelled share still reads "Stopped".
  it("outranks a still-active drive", () => {
    expect(
      hostedRowStatus(hosted({ completed: true, cancelled: true }), { isActive: true })
        .state,
    ).toBe("cancelled");
  });

  // No file count on a hosted row. Nothing was saved to THIS device, so
  // "Stopped — 3 files saved" would be a claim about the other end.
  it("names no file count, and shares its wording with the received row", () => {
    const label = hostedRowStatus(hosted({ completed: true, cancelled: true }), {
      isActive: false,
    }).label;
    expect(label).toBe(cancelledRowLabel(null));
    expect(label).not.toMatch(/saved/i);
  });

  it("claims nothing the app did not observe", () => {
    const label = hostedRowStatus(hosted({ completed: true, cancelled: true }), {
      isActive: false,
    }).label;
    expect(label).not.toMatch(/network|offline|Wi-?Fi|internet|expire/i);
    expect(label).not.toMatch(/check your/i);
  });

  // The three arms this module inherited unchanged from `MainScreen`, here so
  // the extraction is pinned as behaviour-preserving rather than claimed.
  describe("the chain it replaced, unchanged", () => {
    it("reports sharing with a percent while bytes move", () => {
      const s = hostedRowStatus(hosted({ percent: 42 }), { isActive: true });
      expect(s.state).toBe("sharing");
      expect(s.label).toBe("Sharing (42%)");
      expect(s.tone).toBe("warning");
    });

    it("excludes 0 and 100 from the in-flight window, exactly as before", () => {
      // A hosted drive's byte counter is unreliable — UDX sockets expose no
      // `bytesWritten` — so a pinned 100 is not evidence of completion and
      // must not be rendered as progress.
      expect(hostedRowStatus(hosted({ percent: 0 }), { isActive: true }).state).toBe(
        "active",
      );
      expect(hostedRowStatus(hosted({ percent: 100 }), { isActive: true }).state).toBe(
        "active",
      );
    });

    it("reports a completed share as Completed", () => {
      const s = hostedRowStatus(hosted({ completed: true, percent: 100 }), {
        isActive: false,
      });
      expect(s.state).toBe("completed");
      expect(s.label).toBe("Completed");
      expect(s.tone).toBe("primary");
    });

    it("reports an activated drive with no transfer as Active", () => {
      const s = hostedRowStatus(null, { isActive: true });
      expect(s.state).toBe("active");
      expect(s.label).toBe("Active");
    });

    it("reports idle with an empty label when there is nothing to say", () => {
      const s = hostedRowStatus(null, { isActive: false });
      expect(s.state).toBe("idle");
      expect(s.label).toBe("");
    });

    it("does not render a NaN percent as progress", () => {
      // NaN is a number and slips past every comparison; `NaN > 0` and
      // `NaN < 100` are both false, so it falls out of the in-flight window.
      const s = hostedRowStatus(hosted({ percent: Number.NaN }), { isActive: true });
      expect(s.label).toBe("Active");
      expect(s.label).not.toContain("NaN");
    });
  });
});
