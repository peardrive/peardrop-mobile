import { classifyResolve, isResolveUsable } from "../resolveOutcome";

/**
 * The discriminator that decides whether a resolve may be persisted. Two
 * things it has to get right.
 *
 * The verdict keys on `hasManifest`, never on `files.length`: `files` can be
 * populated with no manifest at all, because the engine's `drive.list("/")`
 * fallback enumerates whatever happens to have replicated locally, and it can
 * be legitimately empty for a share that really holds nothing.
 *
 * And `undefined` is not `false`, so truthiness is not `=== true`.
 * `OpenLinkResult.hasManifest` is optional, so `!hasManifest` conflates "the
 * engine said no manifest" with "this reply predates the field". ts-jest runs
 * with `strict: false` while `tsconfig.json` is `strict: true`, so a
 * truthiness bug here is invisible to the suite and surfaces only under `tsc`.
 */
describe("classifyResolve", () => {
  it("is usable when the manifest replicated, even with zero files", () => {
    // A share that genuinely holds nothing still RESOLVED. This is the case a
    // files.length guard gets wrong in the destructive direction.
    expect(classifyResolve({ hasManifest: true, files: [] })).toBe("usable");
  });

  it("is usable when the manifest replicated and carries files", () => {
    expect(
      classifyResolve({ hasManifest: true, files: [{ name: "/a.bin" }] }),
    ).toBe("usable");
  });

  it("is NOT usable when files came from the drive.list() fallback with no manifest", () => {
    // The inverse case: files are present and the manifest never arrived. A
    // files.length guard calls this a success; it is not one.
    expect(
      classifyResolve({ hasManifest: false, files: [{ name: "/a.bin" }] }),
    ).toBe("no-manifest");
  });

  it("is NOT usable when the manifest never replicated", () => {
    expect(classifyResolve({ hasManifest: false, files: [] })).toBe("no-manifest");
  });

  it("treats an ABSENT hasManifest as no-manifest, not as usable", () => {
    // The optional-field trap: `!undefined` and `!false` are both true, so the
    // old guard could not tell these apart. Both must fail closed.
    expect(classifyResolve({ files: [] })).toBe("no-manifest");
    expect(classifyResolve({ hasManifest: undefined, files: [] })).toBe(
      "no-manifest",
    );
  });

  it("does not accept a merely-truthy hasManifest", () => {
    // Guards on `=== true`. A wire value of 1 or "true" is a malformed reply,
    // not a manifest, and must not open the persist path.
    expect(classifyResolve({ hasManifest: 1 as unknown as boolean })).toBe(
      "no-manifest",
    );
    expect(classifyResolve({ hasManifest: "true" as unknown as boolean })).toBe(
      "no-manifest",
    );
  });

  it("fails closed on a missing result object", () => {
    expect(classifyResolve(null)).toBe("no-manifest");
    expect(classifyResolve(undefined)).toBe("no-manifest");
  });
});

describe("isResolveUsable", () => {
  it("agrees with classifyResolve", () => {
    expect(isResolveUsable({ hasManifest: true })).toBe(true);
    expect(isResolveUsable({ hasManifest: false })).toBe(false);
    expect(isResolveUsable({})).toBe(false);
    expect(isResolveUsable(null)).toBe(false);
  });
});
