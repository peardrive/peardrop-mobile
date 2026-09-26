/**
 *
 * The one discriminator that decides whether a resolve result may be persisted.
 *
 * ## Why this is a module and not an inline expression
 *
 * The guard it replaces lived inline in `src/state/ShareLinkFlowContext.tsx` and
 * keyed on `manifest.files.length`. A `.tsx` file cannot be imported by jest in
 * this project (`jest.config.js` is `testEnvironment: "node"` with no
 * react-native transform), so an inline guard is untestable by construction.
 * Extracting it is what makes the two rules below assertable at all.
 *
 * ## The two rules, and what each one is for
 *
 * 1. **The verdict keys on `hasManifest`, never on `files.length`.** The engine's
 *    `drive.list("/")` fallback can populate `files` with whatever happens to
 *    have replicated locally **while the manifest never arrived at all**, and
 *    `files` can be legitimately empty for a share that really holds nothing. So
 *    `files.length` conflates the two cases this guard exists to separate, and it
 *    gets both wrong in the destructive direction: it calls a manifest-less
 *    resolve a success, and it calls a genuinely-empty share a failure.
 *
 * 2. **`=== true`, not truthiness.** `OpenLinkResult.hasManifest` was declared
 *    optional (`src/state/types.ts`), so `!hasManifest` could not tell *"the
 *    engine reported no manifest"* from *"this reply predates the field"*.
 *    `jest.config.js` runs ts-jest with `strict: false` while `tsconfig.json` is
 *    `strict: true`, so **a truthiness bug here passes the entire jest suite and
 *    surfaces only under `tsc`.** The field is now required in the type, and this
 *    module additionally pins the behaviour at runtime rather than relying on
 *    that — a wire value of `1` or `"true"` is a malformed reply, not a manifest.
 *
 * **It fails closed.** Every input this module cannot positively read as
 * "the manifest replicated" is `no-manifest`, including `null` and `undefined`.
 * A resolve that cannot be shown good is not good.
 */

/** `"usable"` — the manifest replicated, so the result may be persisted. */
export type ResolveVerdict = "usable" | "no-manifest";

/**
 * The shape this module reads. Deliberately a **structural subset** of
 * `OpenLinkResult` rather than an import of it: keeping this module import-free
 * is what lets jest reach it, and narrowing the input to the two fields the
 * verdict depends on makes it impossible for a future field to change the
 * answer by accident.
 */
export interface ResolveOutcomeInput {
  hasManifest?: boolean | undefined;
  /** Read for nothing. Present so a caller can pass the reply through unchanged. */
  files?: readonly unknown[] | undefined;
}

/**
 * Classify a resolve reply. **`files` is never consulted** — that is the point of
 * the module, and it is asserted directly by
 * `src/lib/__tests__/resolveOutcome.test.ts`.
 */
export function classifyResolve(
  result: ResolveOutcomeInput | null | undefined,
): ResolveVerdict {
  if (result === null || result === undefined) return "no-manifest";
  return result.hasManifest === true ? "usable" : "no-manifest";
}

/** `classifyResolve(...) === "usable"`, for call sites that want a boolean. */
export function isResolveUsable(
  result: ResolveOutcomeInput | null | undefined,
): boolean {
  return classifyResolve(result) === "usable";
}
