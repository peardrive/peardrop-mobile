// Tripwire for the safePathWithin guard against peer path-traversal on receive.
// backend/path-safe.mjs uses bare-path, which Jest can't load, so the logic is
// mirrored under node:path. Any change to the .mjs must be reflected here or
// these tests stop catching regressions.

import path from "node:path";

// Mirror of backend/path-safe.mjs's PathTraversalError. Kept minimal — an
// instance-of check plus a category field satisfies the tripwire.
class PathTraversalError extends Error {
  category: string;
  override cause: string;
  detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "PathTraversalError";
    this.category = "receive.path-traversal";
    this.cause = "peer-path-traversal";
    this.detail = detail;
  }
}

function safePathWithin(root: string, relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathTraversalError("empty or non-string path", { relPath });
  }
  const cleaned = relPath.replace(/\0/g, "").replace(/^[/\\]+/, "");
  if (cleaned.length === 0) {
    throw new PathTraversalError("empty path after cleaning", { relPath });
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, cleaned);
  if (target !== resolvedRoot && target.startsWith(resolvedRoot + path.sep)) {
    return target;
  }
  throw new PathTraversalError(
    `unsafe path outside download folder: ${relPath as string}`,
    { relPath, root, resolved: target },
  );
}

describe("safePathWithin tripwire", () => {
  const root = process.platform === "win32" ? "C:\\dl" : "/dl";

  test("scenario 1 — plain filename is accepted", () => {
    const out = safePathWithin(root, "file.txt");
    expect(out.startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(out.endsWith("file.txt")).toBe(true);
  });

  test("scenario 2 — subdirectory is accepted", () => {
    const out = safePathWithin(root, "sub/dir/file.txt");
    expect(out.startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(out).toContain("sub");
    expect(out).toContain("dir");
    expect(out.endsWith("file.txt")).toBe(true);
  });

  test("scenario 3 — .. traversal is rejected", () => {
    expect(() => safePathWithin(root, "../evil")).toThrow(PathTraversalError);
    expect(() => safePathWithin(root, "../../../etc/passwd")).toThrow(
      PathTraversalError,
    );
  });

  test("scenario 4 — absolute path is rejected (leading / or \\ stripped, then resolved)", () => {
    // /etc/passwd → after strip → etc/passwd → resolves to root/etc/passwd,
    // which is INSIDE root — legitimate! The leading-slash strip is the
    // defense. This test documents that behavior.
    const out = safePathWithin(root, "/etc/passwd");
    expect(out.startsWith(path.resolve(root) + path.sep)).toBe(true);
    // But a path that after stripping still resolves outside must reject.
    expect(() => safePathWithin(root, "/../escape")).toThrow(
      PathTraversalError,
    );
  });

  test("scenario 5 — legitimate filename starting with .. is allowed", () => {
    // A file literally named `..hidden` (not a `../` traversal) resolves
    // to `<root>/..hidden` which is inside root.
    const out = safePathWithin(root, "..hidden");
    expect(out.startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(out.endsWith("..hidden")).toBe(true);
  });

  test("scenario 6 — single dot resolves to root itself, rejected", () => {
    expect(() => safePathWithin(root, ".")).toThrow(PathTraversalError);
  });

  test("scenario 7 — NUL byte is neutralized", () => {
    // NUL byte gets stripped; the remaining `file` is a legitimate name.
    const out = safePathWithin(root, "file\0.txt");
    expect(out.startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(out).not.toContain("\0");
  });

  test("scenario 8 — empty string is rejected", () => {
    expect(() => safePathWithin(root, "")).toThrow(PathTraversalError);
  });

  test("scenario 9 — non-string is rejected", () => {
    expect(() => safePathWithin(root, null)).toThrow(PathTraversalError);
    expect(() => safePathWithin(root, 42)).toThrow(PathTraversalError);
    expect(() => safePathWithin(root, undefined)).toThrow(PathTraversalError);
  });

  test("scenario 10 — rejection error carries typed cause + category", () => {
    try {
      safePathWithin(root, "../evil");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PathTraversalError);
      expect((err as PathTraversalError).cause).toBe("peer-path-traversal");
      expect((err as PathTraversalError).category).toBe("receive.path-traversal");
    }
  });
});
