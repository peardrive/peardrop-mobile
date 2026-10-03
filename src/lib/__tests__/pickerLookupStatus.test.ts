import {
  PICKER_LOOKUP_COPY,
  pickerLookupStatus,
  type PickerLookupInput,
} from "../pickerLookupStatus";

/**
 * The offline picker resolves again in the background every time
 * it opens (`openStoredSharePicker` ends in `void runResolve(...)`), and until
 * now nothing rendered for it: the modal was a static list for up to 25 s.
 *
 * This maps the signals that already exist onto the four states the user can
 * be told about honestly. It must never claim the sender is absent — the app
 * has no connectivity detection and cannot tell "not online" from "still
 * looking".
 */
const base: PickerLookupInput = {
  resolving: false,
  sessionDriveId: null,
  noticeTone: null,
  elapsedMs: 0,
};

describe("pickerLookupStatus", () => {
  it("is looking while a resolve is in flight and no manifest has landed", () => {
    expect(pickerLookupStatus({ ...base, resolving: true }).state).toBe("looking");
  });

  it("is found the moment a session drive id exists — a peer served the manifest", () => {
    expect(
      pickerLookupStatus({ ...base, resolving: true, sessionDriveId: "d1" }).state,
    ).toBe("found");
  });

  it("stays found after the resolve settles", () => {
    expect(pickerLookupStatus({ ...base, sessionDriveId: "d1" }).state).toBe("found");
  });

  it("is unreadable when a settled wait notice says something came back unparseable", () => {
    // Consuming it is what removes
    // the second banner that said the same thing as the status line.
    expect(pickerLookupStatus({ ...base, noticeTone: "wait" }).state).toBe(
      "unreadable",
    );
  });

  it("distinguishes unreadable from not-found-yet — the whole point of reading the tone", () => {
    const withNotice = pickerLookupStatus({ ...base, noticeTone: "wait" });
    const without = pickerLookupStatus({ ...base, noticeTone: null });
    expect(withNotice.state).not.toBe(without.state);
    expect(withNotice.text).not.toBe(without.text);
  });

  it("an error-tone notice is NOT unreadable — that banner keeps its own red surface", () => {
    expect(pickerLookupStatus({ ...base, noticeTone: "error" }).state).toBe(
      "notFoundYet",
    );
  });

  it("a resolve in flight outranks a stale wait notice from the previous attempt", () => {
    expect(
      pickerLookupStatus({ ...base, resolving: true, noticeTone: "wait" }).state,
    ).toBe("looking");
  });

  it("is not-found-yet when the resolve ended with no manifest and no notice", () => {
    expect(pickerLookupStatus({ ...base, resolving: false }).state).toBe(
      "notFoundYet",
    );
  });

  it("prefers found over a stale wait notice — the manifest is the stronger fact", () => {
    expect(
      pickerLookupStatus({ ...base, sessionDriveId: "d1", noticeTone: "wait" }).state,
    ).toBe("found");
  });

  it("escalates the looking copy on the resolveHint thresholds", () => {
    const at = (elapsedMs: number) =>
      pickerLookupStatus({ ...base, resolving: true, elapsedMs }).text;
    expect(at(0)).toBe(PICKER_LOOKUP_COPY.looking);
    expect(at(4_999)).toBe(PICKER_LOOKUP_COPY.looking);
    expect(at(5_000)).not.toBe(PICKER_LOOKUP_COPY.looking);
    expect(at(15_000)).not.toBe(at(5_000));
  });

  it("rejects a malformed elapsed value at the boundary rather than interpreting it", () => {
    // NaN >= 5_000 is false, which would silently read as "not long enough
    // yet" — the same defect the frozenFraction NaN verdict was.
    for (const bad of [NaN, -1, Infinity]) {
      expect(pickerLookupStatus({ ...base, resolving: true, elapsedMs: bad }).text).toBe(
        PICKER_LOOKUP_COPY.looking,
      );
    }
  });

  it("has copy for every state, and none of it blames a network", () => {
    const texts = Object.values(PICKER_LOOKUP_COPY);
    // an empty set would make the bans vacuous. Covers the
    // two button labels too, which is why they live in this record.
    expect(texts.length).toBeGreaterThanOrEqual(8);
    for (const s of texts) {
      expect(s.length).toBeGreaterThan(5);
      expect(s.length).toBeLessThanOrEqual(100);
      expect(s).not.toMatch(/check your/i);
      expect(s).not.toMatch(/wi-?fi/i);
      expect(s).not.toMatch(/internet/i);
      expect(s).not.toMatch(/mobile data/i);
      expect(s).not.toMatch(/\bnetwork\b/i);
      expect(s).not.toMatch(/\boffline\b/i);
      expect(s).not.toMatch(/expir/i);
    }
  });

  it("never states the sender is absent — only that it has not been found yet", () => {
    expect(PICKER_LOOKUP_COPY.notFoundYet).not.toMatch(/is not online/i);
    expect(PICKER_LOOKUP_COPY.notFoundYet).not.toMatch(/isn't online/i);
    expect(PICKER_LOOKUP_COPY.notFoundYet).toMatch(/yet/i);
    expect(PICKER_LOOKUP_COPY.unreadable).toMatch(/yet/i);
  });

  it("no longer points the user at Grab, which is disabled in both settled states", () => {
    // The copy instructed a tap on the button this round disables. It was
    // already false: that tap hit the `!sessionDriveId` return and was
    // swallowed by an inner `if (!linkError)`.
    expect(PICKER_LOOKUP_COPY.notFoundYet).not.toMatch(/tap grab/i);
    expect(PICKER_LOOKUP_COPY.unreadable).not.toMatch(/tap grab/i);
    expect(PICKER_LOOKUP_COPY.notFoundYet).toMatch(/look again/i);
    expect(PICKER_LOOKUP_COPY.unreadable).toMatch(/look again/i);
  });

  it("names the Look again control with the same words the status line uses", () => {
    // Two strings that must agree: a status line saying "tap Look again" beside
    // a button reading anything else is a dead end.
    expect(PICKER_LOOKUP_COPY.notFoundYet.toLowerCase()).toContain(
      PICKER_LOOKUP_COPY.grabLabelLookAgain.toLowerCase(),
    );
  });
});
