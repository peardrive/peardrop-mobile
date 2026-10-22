/**
 * One outlet per window, exactly one drawing: an Android `Modal` is its own dialog window, so a
 * toast in the activity window paints under an open sheet. Last registrant is the innermost modal.
 */
// iOS keeps a Modal's children mounted after hide, so every outlet inside one must be rendered as
// `{visible && <ToastOutlet />}` or it wins forever. `toastOutletWiring.test.ts` pins that gate.

/** Opaque per-outlet identity. The provider mints these; order is what counts. */
export type ToastOutletId = number;

/**
 * The winner among currently-mounted outlets, or `null` if there are none.
 *
 * `null` is not a "nothing is open" signal — it means no outlet has registered
 * at all, which in a correctly-wired tree happens only before the root outlet's
 * first effect runs. Callers render nothing in that case rather than guessing.
 */
export function selectToastOutlet(
  registered: readonly ToastOutletId[],
): ToastOutletId | null {
  if (registered.length === 0) return null;
  return registered[registered.length - 1] ?? null;
}

/**
 * Whether `id` is the one outlet that may draw.
 *
 * The question every outlet asks about itself, phrased so the "exactly one"
 * invariant lives here instead of being re-derived at each call site.
 */
export function isActiveToastOutlet(
  registered: readonly ToastOutletId[],
  id: ToastOutletId,
): boolean {
  return selectToastOutlet(registered) === id;
}

/**
 * Register `id`, returning the new list.
 *
 * Re-registering an id already present **moves it to the end**. That is not
 * defensive coding: React can re-run an effect without an intervening cleanup
 * under StrictMode double-invocation, and a duplicate left in place would let a
 * stale entry win after the real topmost outlet unregistered.
 */
export function registerToastOutlet(
  registered: readonly ToastOutletId[],
  id: ToastOutletId,
): ToastOutletId[] {
  return [...registered.filter((x) => x !== id), id];
}

/** Unregister `id`, returning the new list. Absent ids are a no-op. */
export function unregisterToastOutlet(
  registered: readonly ToastOutletId[],
  id: ToastOutletId,
): ToastOutletId[] {
  return registered.filter((x) => x !== id);
}
