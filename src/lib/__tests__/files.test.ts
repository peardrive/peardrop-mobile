import {
  APK_MIME,
  fileExt,
  baseName,
  fileIcon,
  fileIconName,
  previewModeFor,
  mimeFromName,
  truncateMiddle,
} from "../files";

describe("fileExt", () => {
  it("returns lowercase extension", () => {
    expect(fileExt("foo.PDF")).toBe("pdf");
    expect(fileExt("a/b/foo.TAR.GZ")).toBe("gz");
  });

  it("returns empty string when none", () => {
    expect(fileExt("README")).toBe("");
    expect(fileExt("")).toBe("");
    expect(fileExt(".dotfile")).toBe("");
  });
});

describe("baseName", () => {
  it("strips file:// and handles backslashes", () => {
    expect(baseName("file:///tmp/foo.txt")).toBe("foo.txt");
    expect(baseName("C:\\Users\\me\\bar.png")).toBe("bar.png");
    expect(baseName("/var/mobile/baz.mp4")).toBe("baz.mp4");
  });

  it("returns input when no separator", () => {
    expect(baseName("solo.txt")).toBe("solo.txt");
  });
});

describe("fileIcon", () => {
  it("maps by extension class", () => {
    expect(fileIcon("a.png")).toBe("🖼️");
    expect(fileIcon("a.mp4")).toBe("🎬");
    expect(fileIcon("a.mp3")).toBe("🎵");
    expect(fileIcon("a.zip")).toBe("🗜️");
    expect(fileIcon("a.pdf")).toBe("📄");
    expect(fileIcon("unknown.xyz")).toBe("📦");
  });
});

describe("previewModeFor", () => {
  it("returns expected modes", () => {
    expect(previewModeFor("photo.jpg")).toBe("image");
    expect(previewModeFor("notes.md")).toBe("text");
    expect(previewModeFor("clip.mov")).toBe("video");
    expect(previewModeFor("song.flac")).toBe("audio");
    expect(previewModeFor("weird.bin")).toBe("unsupported");
  });
});

describe("truncateMiddle", () => {
  it("returns input unchanged when under the limit", () => {
    expect(truncateMiddle("vacation.jpg", 28)).toBe("vacation.jpg");
    expect(truncateMiddle("", 28)).toBe("");
  });

  it("truncates preserving the extension", () => {
    // 26-char input forced to budget 23 → stem 18 + ellipsis + ".jpg" = 23
    expect(truncateMiddle("PXL_20260426_192739229.jpg", 23)).toBe(
      "PXL_20260426_19273….jpg",
    );
    // 38-char input forced to budget 24 → stem 19 + ellipsis + ".mp4" = 24
    expect(truncateMiddle("really_long_video_name_from_camera.mp4", 24)).toBe(
      "really_long_video_n….mp4",
    );
  });

  it("falls back to end-ellipsis when there is no extension", () => {
    expect(truncateMiddle("no-extension-here-very-long-name", 28)).toBe(
      "no-extension-here-very-long…",
    );
  });

  it("treats implausibly long suffixes as 'no extension'", () => {
    // "this.is.not.really.an.ext" — the part after the last dot is "ext"
    // (length 3) so it IS treated as an extension. Use something longer.
    const out = truncateMiddle("hello.thisistoolongtobeext", 18);
    // ext segment len = 18+ chars → falls through to end-truncate path
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(18);
  });

  it("returns full input when budget too tight to truncate sensibly", () => {
    // maxLen 4, extension ".png" — no room for stem+ellipsis+ext.
    expect(truncateMiddle("alpha.png", 4)).toBe("alpha.png");
  });
});

describe("mimeFromName", () => {
  it("returns sensible mime types", () => {
    expect(mimeFromName("photo.jpg")).toBe("image/jpeg");
    expect(mimeFromName("doc.pdf")).toBe("application/pdf");
    expect(mimeFromName("notes.md")).toBe("text/plain");
    expect(mimeFromName("x.xyz")).toBe("*/*");
  });

  it("names the Android package archive type for .apk", () => {
    // Behavioural, not decorative: an ACTION_VIEW carrying "*/*" resolves to
    // no handler. The package-archive type is what lets the system installer
    // offer itself as a target.
    expect(mimeFromName("app-release.apk")).toBe(APK_MIME);
    expect(mimeFromName("APP-RELEASE.APK")).toBe(APK_MIME);
    expect(APK_MIME).toBe("application/vnd.android.package-archive");
  });

  it("no longer falls through to */* for apk or zip", () => {
    expect(mimeFromName("a.apk")).not.toBe("*/*");
    expect(mimeFromName("a.zip")).toBe("application/zip");
  });

  it("recognizes 3gp/3g2 camera output as video", () => {
    // reachable now that the photos picker returns videos, and
    // `extensionForAsset` can emit 3gp for video/3gpp.
    expect(mimeFromName("clip.3gp")).toBe("video/*");
    expect(mimeFromName("clip.3g2")).toBe("video/*");
  });
});

describe("previewModeFor — video containers", () => {
  it("treats 3gp/3g2 as previewable video, not unsupported", () => {
    expect(previewModeFor("clip.3gp")).toBe("video");
    expect(previewModeFor("clip.3g2")).toBe("video");
  });

  it("leaves an apk unsupported — there is nothing to preview in-app", () => {
    expect(previewModeFor("app.apk")).toBe("unsupported");
  });
});

describe("fileIconName", () => {
  // `.apk` is still in EXEC_EXTS, and must still win the Android
  // glyph — the ordering of the two checks is the whole fix.
  it("gives an apk the Android glyph, not the generic cog", () => {
    expect(fileIconName("app.apk")).toBe("logo-android");
    expect(fileIconName("APP.APK")).toBe("logo-android");
  });

  it("leaves the other executables on the cog", () => {
    expect(fileIconName("setup.exe")).toBe("cog-outline");
    expect(fileIconName("thing.deb")).toBe("cog-outline");
    expect(fileIconName("disk.dmg")).toBe("cog-outline");
  });

  it("still routes the ordinary categories", () => {
    expect(fileIconName("a.jpg")).toBe("image-outline");
    expect(fileIconName("a.mp4")).toBe("videocam-outline");
    expect(fileIconName("a.zip")).toBe("archive-outline");
    expect(fileIconName("a.pdf")).toBe("document-outline");
    expect(fileIconName("noext")).toBe("document-outline");
  });
});
