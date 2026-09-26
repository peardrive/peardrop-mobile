import {
  classifyPickerResult,
  isPickerCancellation,
  assetKind,
  extensionForAsset,
  hasUsableExtension,
  mapImageAssets,
  pickedAssetName,
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
    // Legacy shapes carry `type: "cancel"` and no assets. With no flag to
    // read, this must not fall through into share creation.
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

/* Videos are reachable from the photos entry point. The extension is the only
 * type information that travels to the other device: previewModeFor,
 * fileIconName and mimeFromName all key off it, and mimeFromName feeds the
 * receiving device's ACTION_VIEW intent. A mislabelled video is a
 * cross-device bug, not a cosmetic one. */

describe("assetKind", () => {
  it("reads the declared type first", () => {
    expect(assetKind({ type: "video" })).toBe("video");
    expect(assetKind({ type: "pairedVideo" })).toBe("video");
    expect(assetKind({ type: "image" })).toBe("image");
    expect(assetKind({ type: "livePhoto" })).toBe("image");
  });

  it("falls back to the mime type when `type` is null", () => {
    // expo documents `type: null` as rare-but-real on some Android
    // ContentProviders, the same path that produces an asset with no
    // fileName.
    expect(assetKind({ type: null, mimeType: "video/mp4" })).toBe("video");
    expect(assetKind({ type: null, mimeType: "image/png" })).toBe("image");
  });

  it("falls back to duration when neither type nor mime is present", () => {
    expect(assetKind({ duration: 5000 })).toBe("video");
    expect(assetKind({ duration: null })).toBe("image");
    expect(assetKind({ duration: 0 })).toBe("image");
  });

  it("defaults to image when nothing at all is known", () => {
    expect(assetKind({})).toBe("image");
  });
});

describe("hasUsableExtension", () => {
  it("accepts ordinary filenames", () => {
    expect(hasUsableExtension("clip.mp4")).toBe(true);
    expect(hasUsableExtension("a.b.jpeg")).toBe(true);
  });

  it("rejects content-URI style basenames with no extension", () => {
    // This is the case that silently won over the synthesized name and
    // produced a file with no type at all.
    expect(hasUsableExtension("1234")).toBe(false);
    expect(hasUsableExtension("media%3A5567")).toBe(false);
    expect(hasUsableExtension("")).toBe(false);
    expect(hasUsableExtension(".hidden.")).toBe(false);
  });

  it("rejects an implausibly long trailing segment", () => {
    expect(hasUsableExtension("not.an.extensionreally")).toBe(false);
  });
});

describe("extensionForAsset", () => {
  it("maps known mime types to their conventional extension", () => {
    expect(extensionForAsset({ mimeType: "image/jpeg" })).toBe("jpg");
    expect(extensionForAsset({ mimeType: "video/quicktime" })).toBe("mov");
    expect(extensionForAsset({ mimeType: "video/3gpp" })).toBe("3gp");
  });

  it("uses the subtype for unmapped but well-formed mime types", () => {
    expect(extensionForAsset({ mimeType: "video/avi" })).toBe("avi");
  });

  it("falls back to the kind's container when the mime is missing", () => {
    expect(extensionForAsset({ type: "video" })).toBe("mp4");
    expect(extensionForAsset({ type: "image" })).toBe("jpg");
    expect(extensionForAsset({})).toBe("jpg");
  });
});

describe("pickedAssetName — video naming", () => {
  it("does NOT name a video .jpg when the picker gives no filename", () => {
    // The regression this whole block exists to prevent: a synthesized name
    // hard-coded to photo_<stamp>.jpg.
    const name = pickedAssetName(
      { uri: "content://media/picked/1234", type: "video", mimeType: "video/mp4" },
      999,
    );
    expect(name).toBe("video_999.mp4");
    expect(name).not.toMatch(/\.jpg$/);
  });

  it("does not let an extensionless content-URI basename win", () => {
    // `1234` is truthy, so a `|| uriBasename ||` ladder takes it and ships a
    // file with no type.
    expect(
      pickedAssetName({ uri: "content://media/external/video/media/1234", type: "video" }, 7),
    ).toBe("video_7.mp4");
  });

  it("keeps a declared filename that lacks an extension, and completes it", () => {
    expect(
      pickedAssetName(
        { uri: "content://x/1", fileName: "Sunset clip", type: "video", mimeType: "video/quicktime" },
        7,
      ),
    ).toBe("Sunset clip.mov");
  });

  it("leaves a well-formed filename completely alone", () => {
    expect(
      pickedAssetName({ uri: "file:///x/y.mp4", fileName: "PXL_0001.mp4", type: "video" }, 7),
    ).toBe("PXL_0001.mp4");
  });

  it("strips query and fragment before reading the uri basename", () => {
    expect(
      pickedAssetName({ uri: "file:///x/clip.mp4?v=2#top", type: "video" }, 7),
    ).toBe("clip.mp4");
  });

  it("still names stills correctly", () => {
    expect(pickedAssetName({ uri: "content://x/9", type: "image" }, 7)).toBe(
      "photo_7.jpg",
    );
    expect(
      pickedAssetName({ uri: "content://x/9", type: "image", mimeType: "image/png" }, 7),
    ).toBe("photo_7.png");
  });
});

describe("mapImageAssets — mixed image/video selection", () => {
  it("names each asset by its own kind", () => {
    expect(
      mapImageAssets(
        [
          { uri: "content://x/1", type: "image", fileSize: 10 },
          { uri: "content://x/2", type: "video", mimeType: "video/mp4", fileSize: 20 },
        ],
        55,
      ),
    ).toEqual([
      { name: "photo_55.jpg", size: 10, uri: "content://x/1" },
      { name: "video_55.mp4", size: 20, uri: "content://x/2" },
    ]);
  });

  it("carries video file sizes through unchanged", () => {
    // Videos are orders of magnitude larger than stills; the size field
    // feeds the manifest and the progress denominator.
    const mapped = mapImageAssets(
      [{ uri: "file:///v.mp4", type: "video", fileSize: 1_400_000_000 }],
      1,
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.size).toBe(1_400_000_000);
  });
});
