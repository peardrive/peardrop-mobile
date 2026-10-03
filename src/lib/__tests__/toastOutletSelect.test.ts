import {
  isActiveToastOutlet,
  registerToastOutlet,
  selectToastOutlet,
  unregisterToastOutlet,
  type ToastOutletId,
} from "../toastOutletSelect";

/**
 * T1's whole decision: of N mounted toast outlets, which one draws.
 *
 * The scenarios below are named for the real sequences that produce them,
 * because the rule is only correct if "last registered" really does track
 * "innermost open modal" — see the module header for why it does on Android.
 */
describe("selectToastOutlet", () => {
  it("returns null when nothing has registered", () => {
    expect(selectToastOutlet([])).toBeNull();
  });

  it("returns the only outlet when just the root is mounted", () => {
    expect(selectToastOutlet([1])).toBe(1);
  });

  it("prefers the later registrant — the modal outlet over the root", () => {
    expect(selectToastOutlet([1, 2])).toBe(2);
  });

  it("prefers the innermost of two stacked modals", () => {
    // The handoff frame: Receive is still visible in the commit where the
    // picker opens, so both dialog windows are up at once.
    expect(selectToastOutlet([1, 2, 3])).toBe(3);
  });

  it("does not assume ids are sorted — registration ORDER decides, not value", () => {
    // Ids are minted by a counter, but a remount can retire a low id and leave
    // a higher one earlier in the list. Taking the max would be wrong.
    expect(selectToastOutlet([9, 4])).toBe(4);
    expect(selectToastOutlet([2, 7, 3])).toBe(3);
  });
});

describe("isActiveToastOutlet — the exactly-one invariant", () => {
  it("is true for the last registrant and false for every other", () => {
    const list: ToastOutletId[] = [1, 2, 3];
    expect(list.map((id) => isActiveToastOutlet(list, id))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("elects exactly one outlet for every list shape it can be asked about", () => {
    // The invariant the whole feature rests on: never two toasts, never zero
    // while an outlet exists. Asserted across shapes rather than one example.
    const shapes: ToastOutletId[][] = [
      [1],
      [1, 2],
      [1, 2, 3],
      [5, 1],
      [4, 9, 2, 7],
    ];
    const counts = shapes.map(
      (s) => s.filter((id) => isActiveToastOutlet(s, id)).length,
    );
    expect(counts).toEqual([1, 1, 1, 1, 1]);
  });

  it("elects nobody when the list is empty", () => {
    expect(isActiveToastOutlet([], 1)).toBe(false);
  });
});

describe("register / unregister", () => {
  it("appends a new outlet, so it takes over", () => {
    expect(registerToastOutlet([1], 2)).toEqual([1, 2]);
    expect(selectToastOutlet(registerToastOutlet([1], 2))).toBe(2);
  });

  it("hands control back to the root when the modal outlet unregisters", () => {
    const open = registerToastOutlet([1], 2);
    const closed = unregisterToastOutlet(open, 2);
    expect(closed).toEqual([1]);
    expect(selectToastOutlet(closed)).toBe(1);
  });

  it("moves a re-registered id to the end instead of duplicating it", () => {
    // StrictMode can re-run an effect with no intervening cleanup. A duplicate
    // left in place would let the stale entry win once the real topmost
    // outlet unregistered.
    const twice = registerToastOutlet(registerToastOutlet([1, 2], 3), 3);
    expect(twice).toEqual([1, 2, 3]);
    expect(twice.filter((x) => x === 3)).toHaveLength(1);
  });

  it("moves a re-registered id to the END — which is why registration must be mount-only", () => {
    //
    // So this is a HAZARD being pinned, not a guarantee: if an outlet ever
    // re-registered mid-mount (a theme change re-running its effect, say) the
    // root would capture the toast while a sheet still covered it.
    const list = registerToastOutlet([1, 2], 1);
    expect(list).toEqual([2, 1]);
    expect(selectToastOutlet(list)).toBe(1);
    // The mitigation lives in `Toast.tsx`: each outlet mints one id per mount
    // and registers with deps `[id]`, so the effect cannot re-run while
    // mounted. `toastOutletWiring.test.ts` pins that dep array on the
    // registration effect specifically.
  });

  it("unregistering an id that is not there changes nothing", () => {
    expect(unregisterToastOutlet([1, 2], 7)).toEqual([1, 2]);
  });

  it("survives the full open-then-close round trip back to the root", () => {
    let list: ToastOutletId[] = [];
    list = registerToastOutlet(list, 1); // root mounts
    expect(selectToastOutlet(list)).toBe(1);
    list = registerToastOutlet(list, 2); // Receive opens
    expect(selectToastOutlet(list)).toBe(2);
    list = registerToastOutlet(list, 3); // picker opens over it
    expect(selectToastOutlet(list)).toBe(3);
    list = unregisterToastOutlet(list, 2); // Receive hides (handoff)
    expect(selectToastOutlet(list)).toBe(3);
    list = unregisterToastOutlet(list, 3); // picker closes
    expect(selectToastOutlet(list)).toBe(1);
  });
});
