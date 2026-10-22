/**
 * The ordering, not the predicate: classify first, persist only on a good resolve. A guard that
 * runs after `upsertShare` cannot un-write the `files: []` row it has already put on disk.
 */

import {
  classifyResolve,
  type ResolveOutcomeInput,
  type ResolveVerdict,
} from "./resolveOutcome";

/**
 * Copy for a resolve rejected because its manifest did not replicate. It claims nothing about file
 * count, and matches the engine's `receive.no-manifest` message — two routes, one sentence.
 */
export const RESOLVE_NO_MANIFEST_MESSAGE =
  "Couldn't read what's in this share yet. Give it another go in a moment.";

/**
 * The three effects, injected. Named for what they do to *persisted* state,
 * because that is the property under test.
 */
export interface ResolveDispositionDeps<TPersisted> {
  /** Must not run for a result that is not `"usable"` — that is the whole contract of this module. */
  persist: () => Promise<TPersisted>;
  /** Open the preview / apply the dedup classification. Runs after `persist`. */
  accept: (persisted: TPersisted) => void | Promise<void>;
  /** The failure route: breadcrumb, haptic, purge, error copy. */
  reject: (verdict: Exclude<ResolveVerdict, "usable">) => void | Promise<void>;
}

/**
 * Classify, then act. Returns the verdict so the caller can log it.
 *
 * On `"no-manifest"`: **`persist` is never called** and `accept` is never
 * called. On `"usable"`: `persist` runs, then `accept` with its result.
 *
 * A throw from `persist` propagates and `accept` does not run — a half-written
 * record must not open a preview that claims the write succeeded.
 */
export async function disposeResolve<TPersisted>(
  result: ResolveOutcomeInput | null | undefined,
  deps: ResolveDispositionDeps<TPersisted>,
): Promise<ResolveVerdict> {
  const verdict = classifyResolve(result);
  if (verdict !== "usable") {
    await deps.reject(verdict);
    return verdict;
  }
  const persisted = await deps.persist();
  await deps.accept(persisted);
  return verdict;
}
