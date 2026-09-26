import {
  INSTANT_CANCEL_MS,
  RESULT_CANCELED,
  describeOpenFailure,
} from "../openFileResult";

describe("describeOpenFailure", () => {
  it("says nothing when the activity reported success", () => {
    expect(
      describeOpenFailure({ resultCode: -1, elapsedMs: 5, ext: "apk" })
    ).toBeNull();
  });

  it("flags an instant cancel, which is a target that never drew UI", () => {
    const msg = describeOpenFailure({
      resultCode: RESULT_CANCELED,
      elapsedMs: 20,
      ext: "pdf",
    });
    expect(msg).toBe("Nothing on this phone opened that file.");
  });

  // The regression this sprint exists to prevent: a refused APK resolved with
  // resultCode 0 and the caller discarded it, so the user saw nothing at all.
  it("gives the APK its own message rather than the generic one", () => {
    const msg = describeOpenFailure({
      resultCode: RESULT_CANCELED,
      elapsedMs: 15,
      ext: "apk",
    });
    expect(msg).toContain("Save to Downloads");
    expect(msg).not.toBe("Nothing on this phone opened that file.");
  });

  // A message that names a menu item is a cross-file contract, and nothing
  // else checks it: the label lives in a `.tsx` and no `.tsx` is rendered in
  // this suite. A positive assertion on one label goes stale silently the
  // moment the item is renamed, so the check is negative instead — the
  // message must not name any label this project has retired. Both entries
  // below were live once and neither may reappear in user-facing copy
  // without someone deliberately deleting a line here.
  it("does not direct the user to a menu item that no longer exists", () => {
    const msg = describeOpenFailure({
      resultCode: RESULT_CANCELED,
      elapsedMs: 15,
      ext: "apk",
    });
    for (const retired of ["Save a copy", "Send to another app"]) {
      expect(msg).not.toContain(retired);
    }
  });

  // The false positive that would be worse than the silence: a user opens a
  // PDF, reads it, presses back. That is RESULT_CANCELED and a success.
  it("stays silent when the user viewed the file and came back", () => {
    expect(
      describeOpenFailure({
        resultCode: RESULT_CANCELED,
        elapsedMs: INSTANT_CANCEL_MS,
        ext: "pdf",
      })
    ).toBeNull();
    expect(
      describeOpenFailure({
        resultCode: RESULT_CANCELED,
        elapsedMs: 45_000,
        ext: "apk",
      })
    ).toBeNull();
  });

  it("stays silent when elapsed time is unusable rather than guessing", () => {
    expect(
      describeOpenFailure({ resultCode: RESULT_CANCELED, elapsedMs: NaN, ext: "apk" })
    ).toBeNull();
    expect(
      describeOpenFailure({ resultCode: RESULT_CANCELED, elapsedMs: -5, ext: "apk" })
    ).toBeNull();
  });
});
