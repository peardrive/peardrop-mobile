/**
 * The ordering, not the predicate: classify first, persist only on a good
 * resolve. `classifyResolve` decides whether a resolve may be persisted, but a
 * guard that runs after `upsertShare` cannot un-write the `files: []` row it
 * has already put on disk. It lives in a function with injected effects rather
 * than in a `.tsx` jest cannot import, so a test can assert that persist was
 * never called.
 */

import {
  classifyResolve,
  type ResolveOutcomeInput,
  type ResolveVerdict,
} from "./resolveOutcome";

/**
 * The copy shown when a resolve is rejected because its manifest did not
 * replicate.
 *
 * **It lives here, not inline in `ShareLinkFlowContext.tsx`, for one reason:
 * copy in a `.tsx` cannot be checked by a test in this project.** The old
 * string — *"Couldn't find any files at this link. The connection might still
 * be syncing…"* — was a claim about file COUNT, made by a guard that keyed on
 * file count. The guard no longer does, and cannot make that claim: a share
 * rejected here may hold plenty of files we simply could not read yet. So the
 * copy changed with the predicate, and putting it behind an export is what
 * subjects it to the same deny-list `src/lib/resolveHint.ts`'s copy obeys —
 * no "check your …", no expiry claim, no bare "network" or "offline", because
 * the app has measured none of those. Asserted in
 * `src/lib/__tests__/resolveDisposition.test.ts`.
 *
 * It deliberately matches the engine's `receive.no-manifest` message, which
 * reaches the same `setLinkError` field through `runGuardedResolve`'s
 * `onFailure`. Two routes, one sentence.
 */
export const RESOLVE_NO_MANIFEST_MESSAGE =
  "Couldn't read what's in this share yet. Give it another go in a moment.";

/**
 * The three effects, injected. Named for what they do to *persisted* state,
 * because that is the property under test.
 */
export interface ResolveDispositionDeps<TPersisted> {
  /**
   * Reconcile and persist the share record. **Must not run for a result that
   * is not `"usable"`** — that is the entire contract of this module, and
   * `resolveDisposition.test.ts` asserts it directly.
   */
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
