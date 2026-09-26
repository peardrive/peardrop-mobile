/**
 * naming a share before it exists.
 *
 * Pure, and importing nothing, for the reason `transferActivity.ts`,
 * `notificationProgress.ts` and `openFileResult.ts` are: jest runs this suite
 * under `testEnvironment: "node"` and cannot load react-native. Every rule
 * about what a share may be called lives here, so both the dialog and its
 * tests read the same definition.
 *
 * ## This is the SENDER-side boundary only
 *
 * Nothing here protects the receiver. A name arriving over the wire was not
 * necessarily typed into our dialog, and a hostile sender does not use it at
 * all. The receiver's guards are `sanitizeShareTitle` → `sanitizeFolderName`
 * → `safePathWithin` in the engine, hardened separately in 9I-SEC and tested
 * in `shareTitleSafety.test.ts`. The two are different trust boundaries and
 * each needs its own check; treating this file as protecting the receiver is
 * the mistake that would make 9I-SEC pointless.
 *
 * What this file is for is UX: tell the user why a name was refused rather
 * than silently mangling what they typed.
 */

/**
 * Caps, matching the engine's `SHARE_TITLE_MAX_CHARS` / `_MAX_BYTES`.
 *
 * Both measures, because the receiver's filesystem limit is in bytes (~255 on
 * ext4/f2fs) while a text field's limit is in characters — 120 emoji is short
 * by one measure and 480 bytes by the other. Checking only characters lets a
 * name through that the receiver cannot write.
 */
export const SHARE_NAME_MAX_CHARS = 120;
export const SHARE_NAME_MAX_BYTES = 255;

/**
 * UTF-8 byte length without `Buffer` — this module must stay RN-free, and
 * React Native has no `Buffer` global.
 *
 * Counted by code point against the UTF-8 encoding boundaries. Iterating with
 * `for…of` walks code points rather than UTF-16 code units, so an astral
 * character (emoji) is seen once as 4 bytes rather than twice as 3.
 */
export function utf8ByteLength(s: string): number {
  let total = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) total += 1;
    else if (c < 0x800) total += 2;
    else if (c < 0x10000) total += 3;
    else total += 4;
  }
  return total;
}

/**
 * Split a filename into an editable base and a fixed suffix.
 *
 * **Last dot only.** The documented behaviour, including the one case this
 * deliberately gets "wrong":
 *
 * | Input             | Base        | Suffix |
 * |-------------------|-------------|--------|
 * | `alex.jpeg`       | `alex`      | `.jpeg`|
 * | `my.photo.jpeg`   | `my.photo`  | `.jpeg`|
 * | `README`          | `README`    | none   |
 * | `.gitignore`      | `.gitignore`| none   |
 * | `archive.tar.gz`  | `archive.tar`| `.gz` |
 *
 * `.gitignore` has no extension because **a leading dot is not an
 * extension** — it marks a hidden file, and treating it as a suffix would
 * leave an empty editable base.
 *
 * `archive.tar.gz` giving `.gz` is a known imperfection, taken deliberately
 * rather than special-casing a list of double extensions. Such a list is
 * never complete (`.tar.bz2`, `.tar.xz`, `.user.js`, …), and being wrong in a
 * predictable way beats being wrong in an arbitrary one.
 */
export function splitExtension(fileName: string): { base: string; ext: string } {
  const name = String(fileName ?? "");
  const dot = name.lastIndexOf(".");
  // `dot <= 0` covers both "no dot" and "leading dot".
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Recombine an edited base with its fixed extension.
 *
 * **This is the statement of the rule; the ENGINE is what applies it.**
 *
 * That split is deliberate and was learned the hard way. It originally ran
 * here too — RN joined base + extension and sent the complete filename — while
 * the engine, which treats `shareName` as a base, appended the real extension
 * as well. Two components each reasonably believed they owned the job and the
 * extension went on twice; on device, "Hello" became `Hello.jpg.jpeg`.
 *
 * The engine owns it now, because it is the only side holding the
 * authoritative on-disk filename. RN sends the base. This function stays as
 * the tested definition of the rule the engine implements — the same mirror
 * convention `shareTitleSafety.test.ts` uses for Bare-realm code — and its
 * tests are what stop the rule drifting.
 *
 * The rule: if the typed base already ends with the extension — compared
 * case-insensitively — do not add it again. The field renders `.jpeg` as fixed
 * text beside the input and people type it anyway; `holiday.jpeg.jpeg` is the
 * result nobody wants and everybody produces.
 *
 * Case-insensitive because `holiday.JPEG` against a `.jpeg` suffix is the same
 * mistake. The ORIGINAL extension's case is what survives, not the typed one —
 * it came from the real file and the user was not editing it.
 */
export function joinNameAndExt(base: string, ext: string): string {
  const b = String(base ?? "").trim();
  const e = String(ext ?? "");
  if (!e) return b;
  if (b.toLowerCase().endsWith(e.toLowerCase())) {
    // Re-attach the original suffix so its case survives a typed variant.
    return b.slice(0, b.length - e.length) + e;
  }
  return b + e;
}

/**
 * The result of validating a name: the normalised value, or the reason to
 * show the user.
 *
 * A flat optional-field shape rather than a discriminated union: union
 * narrowing needs `strictNullChecks`, and the jest transform sets
 * `strict: false`. A union here compiles under `npx tsc --noEmit` and fails
 * under `npm test` — a shape that passes one gate and not the other.
 */
export type ShareNameCheck = {
  ok: boolean;
  /** Set when `ok` — the normalised name to store. */
  value?: string;
  /** Set when not `ok` — the reason, phrased for the person typing. */
  message?: string;
};

/**
 * Strip control characters by code point rather than by regex.
 *
 * Writing that character class as literal control bytes in source makes the
 * whole file register as binary to `grep` and `diff`, which is how a
 * security-relevant line becomes invisible to review. A code-point loop has
 * no such failure mode.
 */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Validate a name the user typed.
 *
 * Whitespace and edge dots are trimmed **silently** — that is normalisation
 * every text field does and no one is surprised by it. Everything else is
 * *refused with a reason*, because silently rewriting `a/b` to `a_b` gives
 * the user a share called something they did not choose.
 *
 * Returns the normalised value on success, so the caller stores what was
 * validated rather than re-deriving it.
 */
export function checkShareName(raw: string): ShareNameCheck {
  const input = String(raw ?? "");

  if (input !== stripControlChars(input)) {
    return { ok: false, message: "That name has characters we can't use." };
  }

  if (input.includes("/") || input.includes("\\")) {
    return { ok: false, message: "A name can't contain / or \\." };
  }

  // Trim whitespace first, then edge dots, then whitespace again — ". x ."
  // should settle rather than leave a stray space behind the dot strip.
  const trimmed = input.trim().replace(/^\.+/, "").replace(/\.+$/, "").trim();

  if (trimmed.length === 0) {
    return { ok: false, message: "Give it a name." };
  }

  // Checked AFTER the edge trim, deliberately. `..` is dangerous as an
  // interior segment; leading and trailing dots are cosmetic and the brief
  // lists them as things to strip. So "...notes..." normalises to "notes"
  // and is accepted, while "my..file" is refused — checking the raw input
  // would have rejected the first one too, for a reason the user could not
  // act on beyond deleting dots they probably did not mean to type.
  if (trimmed.includes("..")) {
    return { ok: false, message: "A name can't contain “..”." };
  }

  if (trimmed.length > SHARE_NAME_MAX_CHARS) {
    return {
      ok: false,
      message: `That name is too long (max ${SHARE_NAME_MAX_CHARS} characters).`,
    };
  }

  if (utf8ByteLength(trimmed) > SHARE_NAME_MAX_BYTES) {
    // Reached before the character cap only by emoji or CJK. The message
    // avoids "bytes", which means nothing to the person typing.
    return { ok: false, message: "That name is too long — try a shorter one." };
  }

  return { ok: true, value: trimmed };
}

/**
 * Whether the confirm button is enabled.
 *
 * Separate from `checkShareName` because the button must not flash an error
 * at someone who has merely cleared the field to retype it. **An empty field
 * disables the button and shows nothing** — the sprint is explicit that no
 * default is silently substituted, so the button simply waits.
 */
export function canConfirmShareName(raw: string): boolean {
  return String(raw ?? "").trim().length > 0 && checkShareName(raw).ok;
}

/**
 * The name to prefill for a single file.
 *
 * `isUuidLike` is injected rather than imported so this module stays free of
 * `MainScreen`'s helpers and testable on its own.
 *
 * The UUID branch is the whole point of this sprint. "Shared photo" exists
 * because the photo picker hands over UUID cache filenames, and those files
 * now reach a naming box — so prefilling the raw filename would put the UUID
 * in front of the user as their suggested name. Prefilling the human label
 * instead turns the fallback that caused this sprint into the prefill that
 * fixes it. The real extension is kept either way.
 */
export function prefillForSingleFile(
  fileName: string,
  typeLabel: string,
  isUuidLike: (name: string) => boolean
): { base: string; ext: string } {
  const { base, ext } = splitExtension(fileName);
  if (!base || isUuidLike(base) || isUuidLike(fileName)) {
    return { base: typeLabel, ext };
  }
  return { base, ext };
}

/**
 * Default name for a multi-file bundle.
 *
 * Prefers a common base shared by every file — three files named
 * `IMG_20260919_101.jpg`, `…_102.jpg`, `…_103.jpg` suggest `IMG_20260919`.
 *
 * Two guards on that heuristic, both of which exist because a bad common
 * prefix is worse than no heuristic:
 *
 *  - **It must break on a separator.** `IMG_2026091` — a prefix cut
 *    mid-number — is a worse share name than "Photos". Only `_`, `-`, `.` or
 *    a space count as a boundary.
 *  - **It must be long enough to mean something.** A two-character prefix is
 *    a coincidence, not a name.
 *
 * Falls back to the caller's generic default when either guard fails.
 */
export const MIN_COMMON_BASE_CHARS = 4;

export function defaultBundleName(fileNames: readonly string[], fallback: string): string {
  const bases = fileNames
    .map((n) => splitExtension(String(n ?? "")).base.trim())
    .filter((b) => b.length > 0);
  if (bases.length < 2) return fallback;

  // Held in a local so the index accesses below are provably defined —
  // `bases[0]` re-read each time is `string | undefined` under the strict
  // index checks this project compiles with.
  const first = bases[0] ?? "";
  let prefixLen = first.length;
  for (const b of bases.slice(1)) {
    let i = 0;
    while (i < prefixLen && i < b.length && first[i] === b[i]) i++;
    prefixLen = i;
    if (prefixLen === 0) break;
  }
  if (prefixLen === 0) return fallback;

  // Walk back to the last separator boundary inside the shared prefix.
  let cut = -1;
  for (let i = 0; i < prefixLen; i++) {
    const ch = first[i];
    if (ch === "_" || ch === "-" || ch === "." || ch === " ") cut = i;
  }
  if (cut < 0) return fallback;

  const candidate = first.slice(0, cut).trim();
  if (candidate.length < MIN_COMMON_BASE_CHARS) return fallback;
  return checkShareName(candidate).ok ? candidate : fallback;
}
