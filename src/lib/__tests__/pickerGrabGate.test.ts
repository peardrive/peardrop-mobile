import { pickerGrabGate, type PickerGrabGateInput } from "../pickerGrabGate";
import { PICKER_LOOKUP_COPY, type PickerLookupState } from "../pickerLookupStatus";

/**
 * Grab must be dead until the manifest has actually arrived.
 *
 * Before this, the one grab initiator ran into `if (!sessionDriveId) return;`
 * and — because a `wait` notice is normally already set by then — an inner
 * `if (!linkError)` swallowed even the apology. The tap was a completely
 * silent no-op, so disabling the button removes nothing functional.
 *
 * The decision lives here rather than inline in `SharePreviewModal.tsx`
 * because `npm test` renders no `.tsx`: a decision left in the component is a
 * decision no test can observe. Same reason `receivedRowRoute.ts` exists.
 */
const GRAB_LABEL = "Grab everything";

const at = (
  lookupState: PickerLookupState,
  downloadAllBusy = false,
): ReturnType<typeof pickerGrabGate> =>
  pickerGrabGate({ lookupState, downloadAllBusy, grabLabel: GRAB_LABEL } as PickerGrabGateInput);

/**
 * Exhaustive by construction.
 *
 * `Record<PickerLookupState, true>` makes `tsc` fail if a state joins the
 * union and is not listed here. The previous form was a hand-written array
 * plus `expect(ALL_STATES.length).toBe(4)` — an assertion that compared a
 * local literal to its own length and so stayed green in exactly the case it
 * claimed to guard.
 */
const EVERY_STATE: Record<PickerLookupState, true> = {
  looking: true,
  found: true,
  notFoundYet: true,
  unreadable: true,
};
const ALL_STATES = Object.keys(EVERY_STATE) as PickerLookupState[];

describe("pickerGrabGate — the six rows of the button state machine", () => {
  it("row 1 — looking: Grab stays in the slot, disabled, and says why", () => {
    expect(at("looking")).toEqual({
      kind: "grab",
      label: PICKER_LOOKUP_COPY.grabLabelWaiting,
      enabled: false,
      busy: false,
      grabAllowed: false,
    });
  });

  it("row 2 — notFoundYet: Look again TAKES Grab's slot, so the layout holds", () => {
    expect(at("notFoundYet")).toEqual({
      kind: "lookAgain",
      label: PICKER_LOOKUP_COPY.grabLabelLookAgain,
      enabled: true,
      busy: false,
      grabAllowed: false,
    });
  });

  it("row 3 — found, nothing ticked: the caller's label, enabled", () => {
    expect(at("found")).toEqual({
      kind: "grab",
      label: GRAB_LABEL,
      enabled: true,
      busy: false,
      grabAllowed: true,
    });
  });

  it("row 4 — found with a selection: the gate does not rewrite the label", () => {
    // Pluralisation and the byte count belong to sharePreviewCopy. This module
    // decides reachability only; passing the label through is the seam.
    const selectionLabel = "Grab 3 (12.4 MB)";
    expect(
      pickerGrabGate({
        lookupState: "found",
        downloadAllBusy: false,
        grabLabel: selectionLabel,
      }).label,
    ).toBe(selectionLabel);
  });

  it("row 5 — found and busy: disabled with a spinner, and no second grab", () => {
    expect(at("found", true)).toEqual({
      kind: "grab",
      label: GRAB_LABEL,
      enabled: false,
      busy: true,
      grabAllowed: false,
    });
  });

  it("row 6 — notFoundYet AND busy: unreachable, and still must not grab", () => {
    // `setDownloadAllBusy(true)` sits strictly after the `!sessionDriveId`
    // return, and sessionDriveId is the sole `found` discriminator, so
    // busy implies found. Pinned anyway: if that ordering is ever changed,
    // this is the assertion that refuses to let the dead button come back.
    const gate = at("notFoundYet", true);
    expect(gate.grabAllowed).toBe(false);
    expect(gate.kind).toBe("lookAgain");
  });
});

describe("pickerGrabGate — invariants across the whole cross product", () => {
  it("grabAllowed is true in exactly one place: found and not busy", () => {
    const allowed: string[] = [];
    for (const s of ALL_STATES) {
      for (const busy of [false, true]) {
        if (at(s, busy).grabAllowed) allowed.push(`${s}/busy=${busy}`);
      }
    }
    expect(allowed).toEqual(["found/busy=false"]);
  });

  it("never offers an enabled Grab that is not allowed to grab", () => {
    // The one shape that re-creates the original defect: a tappable button
    // whose handler returns. Any row with kind grab + enabled must be allowed.
    const liars: string[] = [];
    for (const s of ALL_STATES) {
      for (const busy of [false, true]) {
        const g = at(s, busy);
        if (g.kind === "grab" && g.enabled && !g.grabAllowed) {
          liars.push(`${s}/busy=${busy}`);
        }
      }
    }
    expect(liars).toEqual([]);
  });

  it("always labels the slot with something non-empty", () => {
    for (const s of ALL_STATES) {
      for (const busy of [false, true]) {
        expect(at(s, busy).label.length).toBeGreaterThan(0);
      }
    }
  });

  it("offers Look again in both settled-with-nothing states, and only those", () => {
    const lookAgain = ALL_STATES.filter((s) => at(s).kind === "lookAgain");
    expect(lookAgain).toEqual(["notFoundYet", "unreadable"]);
  });

  it("decides every lookup state explicitly — no default fall-through", () => {
    // ALL_STATES is derived from Record<PickerLookupState, true>, so a widened
    // union is a tsc error in this file rather than a silently unexercised
    // row. The per-state decision is pinned here, not just the count.
    expect(ALL_STATES.map((s) => `${s}:${at(s).kind}`)).toEqual([
      "looking:grab",
      "found:grab",
      "notFoundYet:lookAgain",
      "unreadable:lookAgain",
    ]);
  });

  it("takes its labels from PICKER_LOOKUP_COPY, not from literals in this module", () => {
    expect(at("looking").label).toBe(PICKER_LOOKUP_COPY.grabLabelWaiting);
    expect(at("notFoundYet").label).toBe(PICKER_LOOKUP_COPY.grabLabelLookAgain);
    expect(at("unreadable").label).toBe(PICKER_LOOKUP_COPY.grabLabelLookAgain);
  });
});
