/**
 * Which toast outlet is allowed to draw.
 *
 * Each RN `Modal` on Android is a separate `Dialog` with its own window
 * (`ReactModalHostView.kt:66-71`), and a dialog window sits above the activity
 * window. So a toast rendered in the activity window is painted *under* an open
 * sheet — including under its backdrop — and its ✕ cannot receive the touch.
 * Restoring the scrim made that occlusion opaque rather than
 * faint.
 *
 * The fix is one outlet per window and exactly one of them drawing: the root
 * outlet when nothing is open, and the innermost open modal's outlet otherwise.
 *
 * **Why "last registered" is the innermost open modal.** A `Modal` with
 * `visible={false}` renders `null` on Android (`Modal.js:278-288`), so its
 * children — and therefore its outlet — mount only when it opens and unmount
 * when it closes. Registration order is therefore open order, and dialog
 * windows also stack in creation order, so the last registrant is the topmost
 * window. That is the whole rule.
 *
 * **That reasoning is Android-specific, and iOS breaks it.**
 * `_shouldShowModal()` returns `visible === true || isRendered === true` on
 * iOS, and `isRendered` is set on the first show and reset only at unmount
 * (`Modal.js:277-284`, `:258-260`). So a sheet opened once keeps its children
 * mounted after it hides, its outlet never unregisters, and — being later than
 * the root — it would win forever: **zero toasts after closing any sheet.**
 * The mitigation is at the call sites, not here: every outlet inside a `Modal`
 * is rendered as `{visible && <ToastOutlet />}`, so hiding the host unmounts
 * the outlet on either platform. `toastOutletWiring.test.ts` pins that gate.
 *
 * **One residual ordering hazard, by construction.** React flushes a child's
 * effects before a later sibling's, so if two nested modals ever mounted in
 * ONE commit, the inner one would register first and the outer would win
 * while the inner dialog sat on top. Reachable only by opening a sheet with a
 * nested sheet already flagged visible, which is why `FilePickerSheet` and
 * `ShareQrModal` both clear their nested modal's flag when they close.
 *
 * Pure and here rather than in `Toast.tsx` because the RN suite renders no
 * `.tsx` — a decision left inline is a decision no test can observe.
 */

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
