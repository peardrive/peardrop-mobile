import {
  RESOLVE_HINT_FIRST_MS,
  RESOLVE_HINT_SECOND_MS,
  resolveHintFor,
  RESOLVE_HINTS,
  RESOLVE_LOOKING_LABEL,
} from "../resolveHint";

/**
 * The progressive hint. The engine waits on data rather than on a socket, so a
 * resolve can legitimately take tens of seconds and a bare
 * `<ActivityIndicator>` tells the user nothing.
 *
 * The hint copy lives in a `.ts` rather than in the `.tsx` because a `.tsx`
 * cannot be imported by jest here — `testEnvironment: "node"` with no
 * react-native transform. Extracting it is what makes the copy rules below
 * testable at all.
 */
describe("resolveHintFor", () => {
  it("shows nothing for the first few seconds — the spinner is enough", () => {
    expect(resolveHintFor(0)).toBeNull();
    expect(resolveHintFor(1)).toBeNull();
    expect(resolveHintFor(RESOLVE_HINT_FIRST_MS - 1)).toBeNull();
  });

  it("shows the first hint from the first threshold", () => {
    expect(resolveHintFor(RESOLVE_HINT_FIRST_MS)).toBe(RESOLVE_HINTS.first);
    expect(resolveHintFor(RESOLVE_HINT_SECOND_MS - 1)).toBe(RESOLVE_HINTS.first);
  });

  it("escalates to the second hint from the second threshold", () => {
    expect(resolveHintFor(RESOLVE_HINT_SECOND_MS)).toBe(RESOLVE_HINTS.second);
    expect(resolveHintFor(RESOLVE_HINT_SECOND_MS + 60_000)).toBe(
      RESOLVE_HINTS.second,
    );
  });

  it("is progressive — the thresholds are ordered and non-zero", () => {
    expect(RESOLVE_HINT_FIRST_MS).toBeGreaterThan(0);
    expect(RESOLVE_HINT_SECOND_MS).toBeGreaterThan(RESOLVE_HINT_FIRST_MS);
  });

  it("rejects a malformed elapsed value at the boundary rather than interpreting it", () => {
    // A threshold comparison used as a validity check admits NaN:
    // `NaN >= 5000` is false, which reads as "not long enough yet" — right
    // answer, wrong reason. Validate at the boundary instead.
    expect(resolveHintFor(Number.NaN)).toBeNull();
    expect(resolveHintFor(Number.POSITIVE_INFINITY)).toBeNull();
    expect(resolveHintFor(-1)).toBeNull();
    expect(resolveHintFor("9999" as unknown as number)).toBeNull();
  });
});

describe("the looking panel's own copy", () => {
  it("has a caption for t=0, because the panel replaced the camera", () => {
    // resolveHintFor stays null below 5 s — the spinner was enough when there
    // was a camera behind it. An empty panel is not.
    expect(resolveHintFor(0)).toBeNull();
    expect(RESOLVE_HINTS.initial.length).toBeGreaterThan(5);
    expect(RESOLVE_HINTS.initial).not.toBe(RESOLVE_HINTS.first);
  });

  it("has a label that reads as a label, not as a sentence", () => {
    expect(RESOLVE_LOOKING_LABEL.length).toBeGreaterThan(5);
    // A screen reader says the ellipsis out loud; the visible caption may have
    // one, the label must not.
    expect(RESOLVE_LOOKING_LABEL).not.toMatch(/[.…]$/);
  });
});

describe("the hint copy obeys the §B prohibitions", () => {
  const every = [...Object.values(RESOLVE_HINTS), RESOLVE_LOOKING_LABEL];

  it("has copy to check", () => {
    // Positive control: an empty set would make both assertions below vacuous.
    expect(every.length).toBeGreaterThan(3);
    for (const s of every) expect(typeof s === "string" && s.length > 0).toBe(true);
  });

  it("never tells the user to check a network the app has never looked at", () => {
    // No connectivity detection exists anywhere in PearDrop, so any copy that
    // points at Wi-Fi, mobile data or the internet is advice about something
    // unmeasured.
    for (const s of every) {
      expect(s).not.toMatch(/check your/i);
      expect(s).not.toMatch(/wi-?fi/i);
      expect(s).not.toMatch(/internet/i);
      expect(s).not.toMatch(/mobile data/i);
      expect(s).not.toMatch(/\bnetwork\b/i);
      expect(s).not.toMatch(/\boffline\b/i);
    }
  });

  it("never says or implies a link expires", () => {
    // Links do not expire.
    for (const s of every) {
      expect(s).not.toMatch(/expir/i);
      expect(s).not.toMatch(/no longer valid/i);
      expect(s).not.toMatch(/timed? out/i);
    }
  });
});
