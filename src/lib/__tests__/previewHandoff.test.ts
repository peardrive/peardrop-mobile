import { previewHandoffFor, type ResolveHandoffKind } from "../previewHandoff";

/**
 * A successful resolve hands off from the Receive sheet to the
 * picker, and the sheet must not be left mounted underneath it.
 *
 * The `full` branch is included deliberately: it opens no preview at all, but
 * it does raise a toast, and a toast behind an open sheet is the defect.
 */
describe("previewHandoffFor", () => {
  const KINDS: ResolveHandoffKind[] = ["full", "partial", "none"];

  it("closes the Receive sheet on every successful verdict, full included", () => {
    expect(KINDS.map((k) => [k, previewHandoffFor(k).closesReceiveSheet])).toEqual([
      ["full", true],
      ["partial", true],
      ["none", true],
    ]);
  });

  it("opens the preview for partial and none, and not for full", () => {
    expect(KINDS.map((k) => [k, previewHandoffFor(k).opensPreview])).toEqual([
      ["full", false],
      ["partial", true],
      ["none", true],
    ]);
  });

  it("closes the sheet even when it opens no preview — the toast needs a clear screen", () => {
    expect(previewHandoffFor("full")).toEqual({
      closesReceiveSheet: true,
      opensPreview: false,
    });
  });
});
