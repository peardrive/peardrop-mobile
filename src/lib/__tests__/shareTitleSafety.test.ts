/**
 * Tripwire — the peer-supplied share title, which arrives in a peer's
 * manifest blob unbounded and untyped and, for a folder share, becomes a
 * directory name on the receiver's disk. A hostile sender does not use the
 * dialog, so sender-side validation is irrelevant. Jest cannot load
 * `backend/hyperdrive-engine.mjs`, so `sanitizeShareTitle`,
 * `sanitizeFolderName` and `safePathWithin` are mirrored here.
 */

import path from "node:path";

// --- Mirror of sanitizeShareTitle (backend/hyperdrive-engine.mjs) --- //

const SHARE_TITLE_MAX_CHARS = 120;
const SHARE_TITLE_MAX_BYTES = 255;

function sanitizeShareTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let out = raw.replace(/[\u0000-\u001F\u007F]/g, "");
  out = out.slice(0, SHARE_TITLE_MAX_CHARS);
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > SHARE_TITLE_MAX_BYTES) {
    out = out.slice(0, -1);
  }
  out = out.trim();
  return out.length > 0 ? out : null;
}

// --- Mirror of sanitizeFolderName (backend/hyperdrive-engine.mjs) --- //
// Ordering: `..` removed before separator replacement. Reversing it reopens
// traversal.

function sanitizeFolderName(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\\/g, "/")
    .replace(/\.\./g, "")
    .replace(/[/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

// --- Mirror of safePathWithin (backend/path-safe.mjs) --- //

function safePathWithin(root: string, relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("empty or non-string path");
  }
  const cleaned = relPath.replace(/\0/g, "").replace(/^[/\\]+/, "");
  if (cleaned.length === 0) throw new Error("empty path after cleaning");
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, cleaned);
  if (target !== resolvedRoot && target.startsWith(resolvedRoot + path.sep)) {
    return target;
  }
  throw new Error(`unsafe path outside download folder: ${relPath}`);
}

/** What `engineDownload` now does with a title, end to end. */
function folderRootForTitle(outDir: string, rawTitle: unknown): string {
  const title = sanitizeShareTitle(rawTitle);
  const folder = sanitizeFolderName(title);
  if (!folder) return outDir;
  try {
    return safePathWithin(outDir, folder);
  } catch {
    // The download continues flat rather than failing — same philosophy as
    // the per-file traversal guard, which skips the entry and carries on.
    return outDir;
  }
}

const OUT = path.resolve("/tmp/peardrop-downloads");

describe("sanitizeShareTitle — validation at the boundary", () => {
  // Fix 4 of 4. Before this, `shareName = manifestData.name` took the value
  // raw, and the first thing to touch it was sanitizeFolderName's
  // `String(raw)` — which turns an object into "[object Object]" rather than
  // rejecting it.
  it("rejects a non-string title rather than coercing it", () => {
    for (const bad of [42, null, undefined, {}, [], true, { name: "x" }]) {
      expect(sanitizeShareTitle(bad)).toBeNull();
    }
    // The coercion that used to happen, asserted as the thing NOT to do.
    expect(sanitizeShareTitle({} as unknown)).not.toBe("[object Object]");
  });

  // Fix 1 of 4. safePathWithin strips NUL and says why — "some syscalls
  // truncate at NUL". The title path did not, so a NUL reached fs.mkdir.
  it("strips NUL and control characters", () => {
    expect(sanitizeShareTitle("hol\u0000iday")).toBe("holiday");
    expect(sanitizeShareTitle("a\u0007b\u001Fc\u007Fd")).toBe("abcd");
    expect(sanitizeShareTitle("\u0000\u0000\u0000")).toBeNull();
  });

  // Fix 2 of 4. Unbounded below the 64 kB manifest cap.
  it("caps length by characters and by UTF-8 bytes", () => {
    const long = "a".repeat(5000);
    expect(sanitizeShareTitle(long)!.length).toBe(SHARE_TITLE_MAX_CHARS);

    // 120 four-byte characters is 480 bytes — inside the character cap and
    // well outside the byte cap. The filesystem limit is the byte one.
    const emoji = "😀".repeat(200);
    const out = sanitizeShareTitle(emoji)!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SHARE_TITLE_MAX_BYTES);
    // Trimmed on a character boundary — a half-written surrogate pair would
    // be a different kind of bad input, not a fix.
    expect(out).toBe("😀".repeat(out.length / 2));
  });

  // The no-regression control. Without this the tests above are satisfied by
  // a function that rejects everything.
  it("leaves an ordinary title untouched", () => {
    expect(sanitizeShareTitle("Holiday photos")).toBe("Holiday photos");
    expect(sanitizeShareTitle("  Trip 2026  ")).toBe("Trip 2026");
    expect(sanitizeShareTitle("Rapport financier — Q3")).toBe("Rapport financier — Q3");
  });
});

describe("the title as a folder name", () => {
  // Fix 3 of 4: safePathWithin, not path.join. No traversal was constructible
  // through sanitizeFolderName alone — these assert that the belt holds AND
  // that the braces are now on.
  it("never escapes the download root", () => {
    const hostile = [
      "../../../etc",
      "..\\..\\windows\\system32",
      "/etc/passwd",
      "....//....//etc",
      "a/../../../b",
      "\u0000/../../etc",
      ".",
      "..",
      "...",
    ];
    for (const t of hostile) {
      const root = folderRootForTitle(OUT, t);
      // Either it fell back to the flat directory, or it is strictly inside.
      const ok = root === OUT || root.startsWith(OUT + path.sep);
      expect(ok).toBe(true);
      expect(root.includes("..")).toBe(false);
    }
  });

  it("still produces the expected folder for a benign title", () => {
    expect(folderRootForTitle(OUT, "Trip photos")).toBe(
      path.join(OUT, "Trip photos"),
    );
  });

  // The control that catches a fix aimed at hostile names breaking benign
  // ones. `Trip 2026/summer` is not an attack — it is a name someone might
  // reasonably type — and `sanitizeFolderName` folds the separator to `_`
  // rather than rejecting it.
  //
  // If `sanitizeFolderName` were ever dropped from the chain, leaving
  // `safePathWithin` alone, every one of these would be REJECTED and the
  // files would land flat. That is a regression for a legitimate name, and
  // the "Trip photos" control above cannot see it because it contains no
  // separator. Order matters: sanitize, then guard.
  it("folds separators in a benign title instead of rejecting it", () => {
    expect(folderRootForTitle(OUT, "Trip 2026/summer")).toBe(
      path.join(OUT, "Trip 2026_summer"),
    );
    expect(folderRootForTitle(OUT, "Trip 2026\\summer")).toBe(
      path.join(OUT, "Trip 2026_summer"),
    );
    expect(folderRootForTitle(OUT, "Q3: results")).toBe(
      path.join(OUT, "Q3_ results"),
    );
  });

  // A title that sanitizes to nothing must not become a write to the root
  // directory itself — safePathWithin rejects `target === resolvedRoot`, and
  // the fallback is the flat download rather than an exception that would
  // sink a legitimate grab.
  it("falls back to a flat download when the title is unusable", () => {
    expect(folderRootForTitle(OUT, "")).toBe(OUT);
    expect(folderRootForTitle(OUT, 42)).toBe(OUT);
    expect(folderRootForTitle(OUT, "   ")).toBe(OUT);
  });
});
