import { contrastRatio, indicatorColor, relativeLuminance } from "../indicatorColor";
import { THEME_ORDER, themes } from "../../ui/themes";

/**
 * The looking indicator draws on `surfaceSubtle` composited
 * over `bg`, and `theme.primary` is a lime that all but vanishes on the light
 * themes: 1.53:1 on `pear`, 1.63:1 on `paper`. `paper` is the default theme.
 *
 * So the colour is chosen, not fixed: `primary` where it clears WCAG 1.4.11's
 * 3:1 floor for non-text graphics, `primaryMuted` where it does not. Never
 * `text` — a black pear is legible and wrong.
 */
describe("relativeLuminance / contrastRatio", () => {
  it("anchors on the two ends of the sRGB range", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("gives black-on-white the canonical 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("applies the sRGB gamma curve, not a linear ramp", () => {
    // The endpoints are 0 and 1 under either curve, so they cannot tell the
    // two apart. Mid-grey can: 0.2159 gamma-corrected vs 0.5020 linear.
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 3);
    expect(relativeLuminance("#808080")).not.toBeCloseTo(0.502, 2);
  });

  it("is symmetric — order of the pair does not change the ratio", () => {
    expect(contrastRatio("#a8cf3a", "#08080d")).toBeCloseTo(
      contrastRatio("#08080d", "#a8cf3a"),
      6,
    );
  });

  it("composites an rgba layer over its backdrop before measuring", () => {
    // A fully transparent overlay must leave the backdrop's luminance alone.
    expect(contrastRatio("#000000", "rgba(255,255,255,0)", "#ffffff")).toBeCloseTo(
      21,
      1,
    );
  });
});

describe("indicatorColor across every theme", () => {
  it("covers all 11 themes — a shrunken list would make this vacuous", () => {
    expect(THEME_ORDER.length).toBe(11);
    expect(Object.keys(themes).length).toBe(11);
  });

  it("picks primaryMuted on pear and paper, where primary fails the 3:1 floor", () => {
    expect(indicatorColor(themes.pear)).toBe(themes.pear.primaryMuted);
    expect(indicatorColor(themes.paper)).toBe(themes.paper.primaryMuted);
  });

  it("picks primary on void, where the lime is plainly readable", () => {
    expect(indicatorColor(themes.void)).toBe(themes.void.primary);
  });

  it("never falls back to text — the indicator is always a brand colour", () => {
    const textFallbacks = THEME_ORDER.filter(
      (id) => indicatorColor(themes[id]) === themes[id].text,
    );
    expect(textFallbacks).toEqual([]);
  });

  it("never returns a colour under 3:1 against the surface it draws on", () => {
    const failures = THEME_ORDER.map((id) => {
      const t = themes[id];
      const ratio = contrastRatio(indicatorColor(t), t.surfaceSubtle, t.bg);
      return { id, ratio: Math.round(ratio * 100) / 100, ok: ratio >= 3 };
    }).filter((r) => !r.ok);
    expect(failures).toEqual([]);
  });

  it("returns a colour the theme actually defines, never an invented hex", () => {
    for (const id of THEME_ORDER) {
      const t = themes[id];
      expect([t.primary, t.primaryMuted]).toContain(indicatorColor(t));
    }
  });
});
