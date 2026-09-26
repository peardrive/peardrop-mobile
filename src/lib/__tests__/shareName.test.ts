/**
 * the sender-side naming rules.
 *
 * This suite covers the UX boundary only. The receiver's guards are a
 * different trust boundary with their own suite (`shareTitleSafety.test.ts`);
 * nothing here is evidence that a hostile name is safe, and the separation is
 * the point — see `shareName.ts`'s header.
 */

import {
  canConfirmShareName,
  checkShareName,
  defaultBundleName,
  joinNameAndExt,
  prefillForSingleFile,
  splitExtension,
  utf8ByteLength,
  MIN_COMMON_BASE_CHARS,
  SHARE_NAME_MAX_CHARS,
} from "../shareName";

describe("splitExtension", () => {
  // The exact table from the sprint brief, including the row it knowingly
  // gets "wrong".
  it.each([
    ["alex.jpeg", "alex", ".jpeg"],
    ["my.photo.jpeg", "my.photo", ".jpeg"],
    ["README", "README", ""],
    [".gitignore", ".gitignore", ""],
    ["archive.tar.gz", "archive.tar", ".gz"],
  ])("%s → base %s, ext %s", (input, base, ext) => {
    expect(splitExtension(input)).toEqual({ base, ext });
  });

  it("treats a leading dot as part of the name, never as an extension", () => {
    // Splitting here would leave an empty editable base, which is the
    // failure this rule exists to prevent.
    expect(splitExtension(".env").base).toBe(".env");
    expect(splitExtension(".env").ext).toBe("");
  });

  it("handles a trailing dot without producing a lone-dot extension", () => {
    expect(splitExtension("name.")).toEqual({ base: "name", ext: "." });
  });
});

describe("joinNameAndExt", () => {
  it("adds the extension when the base lacks it", () => {
    expect(joinNameAndExt("holiday", ".jpeg")).toBe("holiday.jpeg");
  });

  // The rule that exists because the field shows `.jpeg` as fixed text and
  // people type it anyway.
  it("does not double the extension when the user typed it", () => {
    expect(joinNameAndExt("holiday.jpeg", ".jpeg")).toBe("holiday.jpeg");
    expect(joinNameAndExt("holiday.jpeg", ".jpeg")).not.toBe("holiday.jpeg.jpeg");
  });

  it("matches case-insensitively but keeps the original extension's case", () => {
    // The suffix came from the real file; the user was not editing it.
    expect(joinNameAndExt("holiday.JPEG", ".jpeg")).toBe("holiday.jpeg");
    expect(joinNameAndExt("holiday.jpeg", ".JPEG")).toBe("holiday.JPEG");
  });

  it("leaves a name alone when there is no extension", () => {
    expect(joinNameAndExt("README", "")).toBe("README");
  });

  // A base that merely CONTAINS the extension mid-string is not a duplicate.
  it("only strips a trailing match", () => {
    expect(joinNameAndExt("jpeg-notes", ".jpeg")).toBe("jpeg-notes.jpeg");
    expect(joinNameAndExt("my.jpeg.photo", ".jpeg")).toBe("my.jpeg.photo.jpeg");
  });

  it("round-trips with splitExtension", () => {
    for (const name of ["alex.jpeg", "my.photo.jpeg", "README", "archive.tar.gz"]) {
      const { base, ext } = splitExtension(name);
      expect(joinNameAndExt(base, ext)).toBe(name);
    }
  });
});

/**
 * RN sends the base name and the engine owns the extension; the suffix shown
 * in the field is read from the same URI the engine reads. Two sources
 * disagreeing gives `Hello.jpg.jpeg`. `applyChosenName` below mirrors the
 * engine's rename block; if it diverges these tests catch nothing.
 */
function applyChosenName(originalOnDisk: string, chosenBase: string): string {
  const dot = originalOnDisk.lastIndexOf(".");
  const ext = dot > 0 ? originalOnDisk.slice(dot) : "";
  const safeBase = chosenBase;
  const lowerBase = safeBase.toLowerCase();
  const lowerExt = ext.toLowerCase();
  return ext && lowerBase.endsWith(lowerExt)
    ? `${safeBase.slice(0, safeBase.length - ext.length)}${ext}`
    : `${safeBase}${ext}`;
}

describe("the chosen name reaching the receiver", () => {
  it("does not double the extension when RN sends a base", () => {
    expect(applyChosenName("a1b2c3.jpeg", "Hello")).toBe("Hello.jpeg");
  });

  // The exact device failure, asserted as the thing that must not recur.
  it("never reproduces the Hello.jpg.jpeg bug", () => {
    // What the OLD code sent: a recombined name built from the picker's
    // `.jpg` while the file on disk was `.jpeg`.
    const whatTheOldCodeSent = "Hello.jpg";
    expect(applyChosenName("a1b2c3.jpeg", whatTheOldCodeSent)).toBe("Hello.jpg.jpeg");
    // What the new contract sends, against the same file.
    expect(applyChosenName("a1b2c3.jpeg", "Hello")).toBe("Hello.jpeg");
  });

  it("still strips an extension the user typed into the base", () => {
    expect(applyChosenName("a1b2c3.jpeg", "Hello.jpeg")).toBe("Hello.jpeg");
    expect(applyChosenName("a1b2c3.jpeg", "Hello.JPEG")).toBe("Hello.jpeg");
  });

  it("leaves an extensionless file extensionless", () => {
    expect(applyChosenName("README", "Notes")).toBe("Notes");
  });

  // The suffix the field shows must come from the URI, because that is what
  // the engine reads. Reading the picker's `name` instead is the second half
  // of the bug.
  it("reads the displayed suffix from the URI, not the picker name", () => {
    const pickerReportedName = "IMG_0042.jpg";
    const actualCacheUri = "file:///data/user/0/app/cache/peardrop-pick-x_a1b2c3.jpeg";
    expect(splitExtension(pickerReportedName).ext).toBe(".jpg");
    expect(splitExtension(actualCacheUri.split("/").pop()!).ext).toBe(".jpeg");
    // The engine will use .jpeg, so .jpeg is what the field must show.
    expect(applyChosenName("a1b2c3.jpeg", "Hello")).toContain(".jpeg");
  });
});

describe("utf8ByteLength", () => {
  it("counts ASCII, multi-byte and astral characters correctly", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  // The reason the byte cap exists separately from the character cap.
  it("sees an astral character once, not twice", () => {
    expect("😀".length).toBe(2); // UTF-16 code units
    expect(utf8ByteLength("😀")).toBe(4); // not 6
  });
});

describe("checkShareName", () => {
  it("accepts an ordinary name and returns the normalised value", () => {
    expect(checkShareName("Holiday photos")).toEqual({
      ok: true,
      value: "Holiday photos",
    });
  });

  it("trims whitespace and edge dots silently", () => {
    expect(checkShareName("  Trip 2026  ")).toEqual({ ok: true, value: "Trip 2026" });
    expect(checkShareName("...notes...")).toEqual({ ok: true, value: "notes" });
    expect(checkShareName(" . x . ")).toEqual({ ok: true, value: "x" });
  });

  // Refused WITH A REASON rather than silently rewritten. Turning `a/b` into
  // `a_b` behind the user's back gives them a share called something they
  // did not choose.
  it("refuses path separators and says why", () => {
    for (const bad of ["a/b", "a\\b", "/etc/passwd", "C:\\temp"]) {
      const r = checkShareName(bad);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("/");
    }
  });

  it("refuses dot-dot and says why", () => {
    const r = checkShareName("my..file");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("..");
  });

  it("refuses control characters", () => {
    const r = checkShareName(`a${String.fromCharCode(0)}b`);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("can't use");
  });

  it("refuses an empty or whitespace-only name", () => {
    for (const bad of ["", "   ", "..."]) {
      expect(checkShareName(bad).ok).toBe(false);
    }
  });

  it("caps by characters", () => {
    expect(checkShareName("a".repeat(SHARE_NAME_MAX_CHARS)).ok).toBe(true);
    expect(checkShareName("a".repeat(SHARE_NAME_MAX_CHARS + 1)).ok).toBe(false);
  });

  // 100 emoji is 100 code points — inside the character cap — and 400 bytes,
  // outside the byte cap. The receiver's filesystem limit is the byte one.
  it("caps by UTF-8 bytes even when the character count is fine", () => {
    const emoji = "😀".repeat(100);
    expect([...emoji].length).toBeLessThanOrEqual(SHARE_NAME_MAX_CHARS);
    expect(checkShareName(emoji).ok).toBe(false);
  });
});

describe("canConfirmShareName", () => {
  // The sprint is explicit: an empty field disables the button and does NOT
  // silently substitute a default. The user cleared it on purpose.
  it("is false for an empty or whitespace-only field", () => {
    expect(canConfirmShareName("")).toBe(false);
    expect(canConfirmShareName("   ")).toBe(false);
  });

  it("is false for an invalid name", () => {
    expect(canConfirmShareName("a/b")).toBe(false);
  });

  it("is true for a valid name", () => {
    expect(canConfirmShareName("Trip")).toBe(true);
  });
});

describe("prefillForSingleFile", () => {
  const isUuid = (n: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n.trim());

  it("prefills the real base name and keeps the extension fixed", () => {
    expect(prefillForSingleFile("alex.jpeg", "Photo", isUuid)).toEqual({
      base: "alex",
      ext: ".jpeg",
    });
  });

  // The case that caused this sprint. The photo picker hands over UUID cache
  // filenames — that is why "Shared photo" exists at all — so those files now
  // reach a naming box and would otherwise suggest the UUID as the name.
  it("prefills the human label for a UUID-named photo, keeping the real extension", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301.jpg";
    expect(prefillForSingleFile(uuid, "Photo", isUuid)).toEqual({
      base: "Photo",
      ext: ".jpg",
    });
  });

  it("falls back to the label when the name is only an extension", () => {
    expect(prefillForSingleFile(".jpg", "Photo", isUuid).base).toBe(".jpg");
  });
});

describe("defaultBundleName", () => {
  it("uses a common base that breaks on a separator", () => {
    expect(
      defaultBundleName(
        ["IMG_20260919_101.jpg", "IMG_20260919_102.jpg", "IMG_20260919_103.jpg"],
        "Photos",
      ),
    ).toBe("IMG_20260919");
  });

  // The guard that matters. Without the separator-boundary rule this returns
  // "IMG_2026091" — a prefix cut mid-number, and a worse share name than the
  // generic fallback.
  it("does NOT cut a common prefix mid-token", () => {
    const out = defaultBundleName(
      ["IMG_20260919.jpg", "IMG_20260918.jpg"],
      "Photos",
    );
    expect(out).toBe("Photos");
    expect(out).not.toBe("IMG_2026091");
  });

  it("rejects a common base that is too short to mean anything", () => {
    const out = defaultBundleName(["a_1.jpg", "a_2.jpg"], "Photos");
    expect(out).toBe("Photos");
    expect("a".length).toBeLessThan(MIN_COMMON_BASE_CHARS);
  });

  it("falls back when the files share nothing", () => {
    expect(defaultBundleName(["cat.jpg", "dog.png"], "Photos")).toBe("Photos");
  });

  it("falls back for a single file", () => {
    expect(defaultBundleName(["only.jpg"], "Files")).toBe("Files");
  });

  it("never returns a name its own validator would refuse", () => {
    const out = defaultBundleName(["a/b_1.jpg", "a/b_2.jpg"], "Files");
    expect(checkShareName(out).ok).toBe(true);
  });
});
