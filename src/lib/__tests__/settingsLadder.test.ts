// Ordering and manufacturer gating for the two OEM settings ladders.
//
// What is NOT tested here, deliberately: whether any of these intents
// actually resolves on a device. That is undocumented, version-dependent and
// OEM-specific — the only honest verification is launching them on hardware,
// which the device protocol covers. Mocking `startActivityAsync` to return
// success would assert nothing except that the mock was called, and would
// read as coverage the ladder does not have.

import {
  isSamsungManufacturer,
  isXiaomiManufacturer,
  ladderFor,
  type CandidateLabel,
} from "../settingsLadder";

const XIAOMI = ["Xiaomi", "xiaomi", "Redmi", "REDMI", "POCO", "Poco"];
const OTHERS = ["samsung", "Google", "OnePlus", "HUAWEI", "motorola", "vivo"];

describe("isXiaomiManufacturer", () => {
  test.each(XIAOMI)("matches %s", (m) => {
    expect(isXiaomiManufacturer(m)).toBe(true);
  });

  test.each(OTHERS)("does not match %s", (m) => {
    expect(isXiaomiManufacturer(m)).toBe(false);
  });

  test("treats absent manufacturer as not-Xiaomi", () => {
    expect(isXiaomiManufacturer(null)).toBe(false);
    expect(isXiaomiManufacturer(undefined)).toBe(false);
    expect(isXiaomiManufacturer("")).toBe(false);
  });
});

describe("ladderFor — autostart", () => {
  test("the implicit action is tried before the explicit component", () => {
    expect(ladderFor("autostart", "Xiaomi")).toEqual<CandidateLabel[]>([
      "miui-autostart-op",
      "miui-autostart-management",
      "app-details",
    ]);
  });

  test("non-Xiaomi gets only the generic screen", () => {
    // There is no known per-app autostart concept outside MIUI to aim at.
    expect(ladderFor("autostart", "samsung")).toEqual(["app-details"]);
  });

  test("never includes the per-app permissions editor", () => {
    // APP_PERM_EDITOR resolves and wins, but lands on a page that does not
    // carry Autostart, so it would shadow both working rungs below.
    expect(ladderFor("autostart", "Xiaomi")).not.toContain(
      "miui-autostart-perm-editor" as unknown as CandidateLabel
    );
  });
});

describe("ladderFor — battery", () => {
  test("keeps the device-verified order unchanged", () => {
    expect(ladderFor("battery", "Redmi")).toEqual<CandidateLabel[]>([
      "miui-power-detail",
      "miui-power-keeper",
      "app-details",
    ]);
  });

  test("non-Xiaomi gets only the generic screen", () => {
    expect(ladderFor("battery", "Google")).toEqual(["app-details"]);
  });

  test("never includes an autostart rung", () => {
    // The battery ladder must not reach for the autostart screens, and vice
    // versa — each function's copy describes its own destination.
    expect(ladderFor("battery", "Xiaomi")).not.toContain("miui-autostart-op");
    expect(ladderFor("battery", "Xiaomi")).not.toContain(
      "miui-autostart-management"
    );
  });
});

describe("ladderFor — invariants across both kinds", () => {
  const cases: [string, string][] = [
    ["battery", "Xiaomi"],
    ["battery", "samsung"],
    ["autostart", "Xiaomi"],
    ["autostart", "samsung"],
  ];

  test.each(cases)("%s/%s always ends at app-details", (kind, manufacturer) => {
    const ladder = ladderFor(kind as "battery" | "autostart", manufacturer);
    expect(ladder[ladder.length - 1]).toBe("app-details");
  });

  test.each(cases)("%s/%s has no duplicate rungs", (kind, manufacturer) => {
    const ladder = ladderFor(kind as "battery" | "autostart", manufacturer);
    expect(new Set(ladder).size).toBe(ladder.length);
  });

  test("the two Xiaomi ladders share only the generic fallback", () => {
    const battery = new Set(ladderFor("battery", "Xiaomi"));
    const autostart = ladderFor("autostart", "Xiaomi").filter((l) =>
      battery.has(l)
    );
    expect(autostart).toEqual(["app-details"]);
  });
});

// ---------------------------------------------------------------------
// the per-OEM fallback destination.
//
// Reachable only after the foreground service has failed three times on a
// device. One destination per manufacturer, each landing on a specific
// screen — never a generic "miscellaneous" page.
// ---------------------------------------------------------------------

describe("ladderFor('fallback')", () => {
  test.each(XIAOMI)("%s goes to Autostart, NOT the battery screen", (m) => {
    // With the battery restriction removed and no service, the Redmi still
    // stalled and completed late: battery is the weakest lever there.
    expect(ladderFor("fallback", m)).toEqual([
      "miui-autostart-op",
      "miui-autostart-management",
      "app-details",
    ]);
  });

  test("Samsung goes to the two components that launched on real hardware", () => {
    expect(ladderFor("fallback", "samsung")).toEqual([
      "samsung-battery-checkable",
      "samsung-battery-ui",
      "app-details",
    ]);
    expect(ladderFor("fallback", "Samsung")).toEqual(
      ladderFor("fallback", "samsung")
    );
  });

  test("everything else gets the AOSP list, then app details", () => {
    for (const m of ["Google", "OnePlus", "HUAWEI", "", null, undefined]) {
      expect(ladderFor("fallback", m)).toEqual([
        "aosp-battery-optimization",
        "app-details",
      ]);
    }
  });

  test("every fallback ladder ends somewhere that always exists", () => {
    for (const m of ["Xiaomi", "samsung", "Nokia", null]) {
      const rungs = ladderFor("fallback", m);
      expect(rungs[rungs.length - 1]).toBe("app-details");
    }
  });

  test("the battery and autostart ladders are unchanged by the new kind", () => {
    expect(ladderFor("autostart", "Xiaomi")).toEqual([
      "miui-autostart-op",
      "miui-autostart-management",
      "app-details",
    ]);
    expect(ladderFor("battery", "samsung")).toEqual(["app-details"]);
  });
});

describe("isSamsungManufacturer", () => {
  test.each(["samsung", "Samsung", "SAMSUNG"])("matches %s", (m) => {
    expect(isSamsungManufacturer(m)).toBe(true);
  });

  test.each(["Xiaomi", "Google", "OnePlus", ""])("does not match %s", (m) => {
    expect(isSamsungManufacturer(m)).toBe(false);
  });

  test("handles absent values", () => {
    expect(isSamsungManufacturer(null)).toBe(false);
    expect(isSamsungManufacturer(undefined)).toBe(false);
  });
});
