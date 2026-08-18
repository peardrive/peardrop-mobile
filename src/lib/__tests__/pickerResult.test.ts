import {
  classifyPickerResult,
  isPickerCancellation,
  mapImageAssets,
  pickerExitPlan,
  type PickerOutcome,
} from "../pickerResult";

const file = (uri: string, name = "a.txt") => ({ name, uri, size: 1 });

describe("classifyPickerResult", () => {
  it("reports a cancel even when the picker also returned assets", () => {
    // expo sets `assets: null` on cancel, but OEM shims have been seen
    // returning stale assets alongside canceled: true. The flag wins.
    expect(classifyPickerResult(true, [file("file:///a.txt")])).toEqual({
      kind: "cancelled",
    });
    expect(classifyPickerResult(true, [])).toEqual({ kind: "cancelled" });
    expect(classifyPickerResult(true, null)).toEqual({ kind: "cancelled" });
  });

  it("reports empty when the picker returned without a cancel and without assets", () => {
    expect(classifyPickerResult(false, [])).toEqual({ kind: "empty" });
    expect(classifyPickerResult(false, null)).toEqual({ kind: "empty" });
    expect(classifyPickerResult(undefined, undefined)).toEqual({ kind: "empty" });
  });

  it("treats a legacy result with no `canceled` field as empty, not selected", () => {
    // Legacy shapes carry `type: "cancel"` and no assets. Without a flag to
    // read we must not fall through into share creation.
    expect(classifyPickerResult(undefined, [])).toEqual({ kind: "empty" });
  });

  it("drops assets with no uri and reports empty if that leaves nothing", () => {
    expect(classifyPickerResult(false, [{ name: "ghost", uri: "" }])).toEqual({
      kind: "empty",
    });
  });

  it("reports a selection and keeps only the usable assets", () => {
    const outcome = classifyPickerResult(false, [
      file("file:///a.txt", "a.txt"),
      { name: "ghost", uri: "" },
      file("file:///b.txt", "b.txt"),
    ]);
    expect(outcome.kind).toBe("selected");
    expect(outcome.kind === "selected" && outcome.files.map((f) => f.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });
});

describe("pickerExitPlan", () => {
  const labels = { empty: "Nothing picked." };

  it("cancel returns cleanly: no toast, sheet restored, never proceeds", () => {
    expect(pickerExitPlan({ kind: "cancelled" }, labels)).toEqual({
      reopenSendSheet: true,
      toast: null,
      showBackHint: true,
      proceed: false,
    });
  });

  it("empty returns cleanly with a plain toast and never proceeds", () => {
    expect(pickerExitPlan({ kind: "empty" }, labels)).toEqual({
      reopenSendSheet: true,
      toast: "Nothing picked.",
      showBackHint: false,
      proceed: false,
    });
  });

  it("a selection proceeds and leaves the sheet closed", () => {
    const outcome: PickerOutcome = {
      kind: "selected",
      files: [file("file:///a.txt")],
    };
    expect(pickerExitPlan(outcome, labels)).toEqual({
      reopenSendSheet: false,
      toast: null,
      showBackHint: false,
      proceed: true,
    });
  });

  it("only a selection ever proceeds, and every other outcome restores the launch surface", () => {
    const outcomes: PickerOutcome[] = [
      { kind: "cancelled" },
      { kind: "empty" },
      { kind: "selected", files: [file("file:///a.txt")] },
    ];
    for (const o of outcomes) {
      const plan = pickerExitPlan(o, labels);
      expect(plan.proceed).toBe(o.kind === "selected");
      expect(plan.reopenSendSheet).toBe(o.kind !== "selected");
    }
  });

  it("never surfaces an error-shaped message on a back-out", () => {
    expect(pickerExitPlan({ kind: "cancelled" }, labels).toast).toBeNull();
  });
});

describe("isPickerCancellation", () => {
  it("matches documented cancel codes regardless of case", () => {
    expect(isPickerCancellation({ code: "ERR_CANCELED" })).toBe(true);
    expect(isPickerCancellation({ code: "E_PICKER_CANCELLED" })).toBe(true);
    expect(isPickerCancellation({ code: "user_canceled" })).toBe(true);
  });

  it("matches both spellings in a thrown message", () => {
    expect(isPickerCancellation(new Error("User canceled the picker"))).toBe(true);
    expect(isPickerCancellation(new Error("Operation cancelled"))).toBe(true);
  });

  it("does not swallow real failures", () => {
    expect(isPickerCancellation(new Error("Permission denied"))).toBe(false);
    expect(isPickerCancellation({ code: "ERR_NO_ACTIVITY" })).toBe(false);
    expect(isPickerCancellation(null)).toBe(false);
    expect(isPickerCancellation(undefined)).toBe(false);
  });
});

describe("mapImageAssets", () => {
  it("prefers fileName, falls back to the uri tail, then to a stamped name", () => {
    expect(
      mapImageAssets(
        [
          { uri: "file:///x/IMG_1.jpg", fileName: "holiday.jpg", fileSize: 10 },
          { uri: "file:///x/IMG_2.jpg" },
          { uri: "file:///" },
        ],
        1234,
      ),
    ).toEqual([
      { name: "holiday.jpg", size: 10, uri: "file:///x/IMG_1.jpg" },
      { name: "IMG_2.jpg", size: undefined, uri: "file:///x/IMG_2.jpg" },
      { name: "photo_1234.jpg", size: undefined, uri: "file:///" },
    ]);
  });

  it("drops uri-less assets and tolerates a null asset list", () => {
    expect(mapImageAssets([{ fileName: "no-uri.jpg" }], 1)).toEqual([]);
    expect(mapImageAssets(null, 1)).toEqual([]);
    expect(mapImageAssets(undefined, 1)).toEqual([]);
  });

  it("feeds classifyPickerResult an empty outcome when every asset is unusable", () => {
    const files = mapImageAssets([{ fileName: "no-uri.jpg" }], 1);
    expect(classifyPickerResult(false, files)).toEqual({ kind: "empty" });
  });
});
