import {
  PREVIEW_PICK_ONE_HINT,
  previewHint,
  previewPrimaryLabel,
  previewSubtitle,
} from "../sharePreviewCopy";

/**
 * The picker's three strings, none of which was a function before.
 *
 * `"{n} {n === 1 ? "file" : "files"} in here"` was an inline JSX ternary — so
 * the pluralisation was real logic that no test could reach, which is also how
 * "Grab everything" came to be the label for a one-file share. The size never
 * appeared at all, though `openResult.totalBytes` was already populated.
 *
 * The unknown-size case is the one that matters: a manifest can carry no
 * sizes, and `formatBytes` answers "0 B" for that, which reads as "this share
 * is empty" rather than "nobody told us how big it is".
 */
describe("previewSubtitle", () => {
  it("reads '1 file · 33.1 MB' for a single file — the owner's example verbatim", () => {
    expect(previewSubtitle(1, 34_712_781)).toBe("1 file · 33.1 MB");
  });

  it("pluralises past one", () => {
    expect(previewSubtitle(2, 2048)).toBe("2 files · 2.0 KB");
    expect(previewSubtitle(47, 1024)).toBe("47 files · 1.0 KB");
  });

  it("says files, not file, for zero", () => {
    expect(previewSubtitle(0, 1024)).toBe("0 files · 1.0 KB");
  });

  it("renders an unknown total as a dash, NEVER as 0 B", () => {
    // formatBytes answers "0 B" for all four of these. "1 file · 0 B" asserts
    // the share is empty; the dash asserts only that we were not told.
    for (const unknown of [undefined, null, 0, NaN]) {
      expect(previewSubtitle(1, unknown)).toBe("1 file · —");
    }
  });

  it("treats a negative total as unknown too", () => {
    expect(previewSubtitle(3, -5)).toBe("3 files · —");
  });

  it("uses the house middot separator", () => {
    expect(previewSubtitle(1, 1024)).toContain(" · ");
  });
});

describe("previewHint", () => {
  it("is shown only for 2+ files, and only when Grab is enabled", () => {
    expect(previewHint(2, true)).toBe(PREVIEW_PICK_ONE_HINT);
    expect(previewHint(47, true)).toBe(PREVIEW_PICK_ONE_HINT);
  });

  it("is null for one file — there is no 'just that one' to pick", () => {
    expect(previewHint(1, true)).toBeNull();
  });

  it("is null while Grab is disabled — it would invite a tap that cannot work", () => {
    expect(previewHint(2, false)).toBeNull();
    expect(previewHint(47, false)).toBeNull();
  });

  it("is null for an empty list", () => {
    expect(previewHint(0, true)).toBeNull();
  });
});

describe("previewPrimaryLabel", () => {
  it("reads just 'Grab' for a single unselected file", () => {
    // "Grab everything" for one file is the defect: the label never branched
    // on fileCount at all.
    expect(
      previewPrimaryLabel({ fileCount: 1, selectedCount: 0, selectedBytes: 0 }),
    ).toBe("Grab");
  });

  it("reads 'Grab everything' for several unselected files", () => {
    expect(
      previewPrimaryLabel({ fileCount: 4, selectedCount: 0, selectedBytes: 0 }),
    ).toBe("Grab everything");
  });

  it("counts and sizes an explicit selection", () => {
    expect(
      previewPrimaryLabel({ fileCount: 4, selectedCount: 2, selectedBytes: 2048 }),
    ).toBe("Grab 2 (2.0 KB)");
  });

  it("a selection wins over the single-file case", () => {
    expect(
      previewPrimaryLabel({ fileCount: 1, selectedCount: 1, selectedBytes: 1024 }),
    ).toBe("Grab 1 (1.0 KB)");
  });

  it("keeps formatBytes for a selection — a picked file's size IS known", () => {
    // Deliberately NOT formatBytesOrUnknown: the user ticked these rows, so a
    // dash here would be hiding a real sum of real sizes.
    expect(
      previewPrimaryLabel({ fileCount: 3, selectedCount: 2, selectedBytes: 0 }),
    ).toBe("Grab 2 (0 B)");
  });
});

describe("the copy clears both deny-lists", () => {
  const all = [
    PREVIEW_PICK_ONE_HINT,
    previewSubtitle(1, 1024),
    previewSubtitle(9, 1024),
    previewPrimaryLabel({ fileCount: 1, selectedCount: 0, selectedBytes: 0 }),
    previewPrimaryLabel({ fileCount: 9, selectedCount: 0, selectedBytes: 0 }),
    previewPrimaryLabel({ fileCount: 9, selectedCount: 2, selectedBytes: 2048 }),
  ];

  it("blames no network and promises no expiry", () => {
    // an empty list would make every ban below vacuous.
    expect(all.length).toBe(6);
    for (const s of all) {
      // "Grab" is exactly 4 — the shortest string this module produces.
      expect(s.length).toBeGreaterThanOrEqual(4);
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

  it("carries no emoji — the rule check-copy.mjs now enforces", () => {
    for (const s of all) {
      expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });
});
