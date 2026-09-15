// The fallback row is ONE row everywhere; only its subtitle varies.
//
// Before this, the label changed per manufacturer — "Let PearDrop start on
// its own" on Xiaomi, "Stop your phone pausing PearDrop" elsewhere. The row
// names the same user-facing capability wherever it points, so it should
// read the same. These tests pin that, and pin the reason the label cannot
// drift back: it must name no brand-specific mechanism, because any mechanism
// it named would be wrong on the other two destinations.

import {
  FALLBACK_CANCEL_LABEL,
  FALLBACK_CONFIRM_LABEL,
  FALLBACK_ROW_ICON,
  FALLBACK_ROW_LABEL,
  fallbackCopyFor,
  type FallbackBrand,
} from "../fallbackCopy";

const BRANDS: FallbackBrand[] = ["xiaomi", "samsung", "generic"];

describe("the row is the same everywhere", () => {
  test("the label names no brand-specific mechanism", () => {
    const label = FALLBACK_ROW_LABEL.toLowerCase();
    for (const banned of ["autostart", "battery", "sleep", "sleeping", "unmonitored"]) {
      expect(label).not.toContain(banned);
    }
  });

  test("the label and icon are constants, not per-brand fields", () => {
    for (const brand of BRANDS) {
      const copy = fallbackCopyFor(brand);
      expect(copy).not.toHaveProperty("rowLabel");
      expect(copy).not.toHaveProperty("rowIcon");
    }
    expect(FALLBACK_ROW_LABEL).toBe("Stop your phone pausing PearDrop");
    expect(FALLBACK_ROW_ICON).toBe("pulse-outline");
  });

  test("the icon is not a battery glyph", () => {
    // A battery would be wrong on Xiaomi, where the row opens Autostart —
    // the battery screen was measured to be the weakest lever there.
    expect(FALLBACK_ROW_ICON).not.toContain("battery");
  });
});

describe("only the subtitle varies", () => {
  test("every brand has a distinct subtitle", () => {
    const subtitles = BRANDS.map((b) => fallbackCopyFor(b).rowSubtitle);
    expect(new Set(subtitles).size).toBe(BRANDS.length);
  });

  test("each subtitle names what to look for on the screen that opens", () => {
    // The 7B lesson: every destination is a global list, not PearDrop's own
    // page, so the subtitle has to say what to find once you arrive.
    expect(fallbackCopyFor("xiaomi").rowSubtitle).toContain("Autostart");
    expect(fallbackCopyFor("samsung").rowSubtitle).toContain("battery settings");
    expect(fallbackCopyFor("generic").rowSubtitle).toContain("battery settings");
    for (const brand of BRANDS) {
      expect(fallbackCopyFor(brand).rowSubtitle).toMatch(/^Opens /);
    }
  });
});

describe("the prompt is unchanged by the row consolidation", () => {
  test("the title is shared and the body is per-brand", () => {
    const titles = BRANDS.map((b) => fallbackCopyFor(b).title);
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toBe("Your phone keeps stopping PearDrop");

    const bodies = BRANDS.map((b) => fallbackCopyFor(b).body);
    expect(new Set(bodies).size).toBe(BRANDS.length);
  });

  test("every body opens with the shared paragraph and promises no fix", () => {
    for (const brand of BRANDS) {
      const body = fallbackCopyFor(brand).body;
      expect(body).toContain("this phone stopped it anyway");
      // "usually fixes it" — never a promise. The mechanism meant to fix
      // this has already failed on the device by the time it is shown.
      expect(body).not.toMatch(/will fix|guarantee|ensures/i);
    }
  });

  test("button labels are shared", () => {
    expect(FALLBACK_CONFIRM_LABEL).toBe("Open settings");
    expect(FALLBACK_CANCEL_LABEL).toBe("Not now");
  });
});
