/**
 * the progressive hint.
 *
 * ## Why this exists
 *
 * Before this sprint the resolve gave up after ~3.3 s because it waited on a
 * **connection** condition (`swarm.flush()`, which resolves with zero peers)
 * rather than on data. With the wait keyed on the manifest actually arriving, an
 * honest resolve can legitimately take tens of seconds on a mobile network — so
 * the spinner needs words, or the fix ships thirty seconds of unexplained
 * spinner and reads as a worse bug than the one it closed.
 *
 * The live resolve UI (`src/ui/ReceiveSheet.tsx`) rendered an
 * `<ActivityIndicator>` and nothing else, and **nothing in the live path tracked
 * elapsed time at all** — `resolveGuard`'s timer is a *rejection* timer, not
 * observable state. A 5 s "Still looking…" affordance existed only in
 * `src/screens/ReceiveScreen.tsx`, which is **dead**: no import anywhere in `src`
 * or `app`, no route file, no test (verified with a positive control). So this is
 * **rebuilt, not revived** — do not import that file.
 *
 * The copy and the thresholds live here rather than in the `.tsx` because a
 * `.tsx` cannot be imported by jest in this project (`jest.config.js` is
 * `testEnvironment: "node"` with no react-native transform). Extracting them
 * is what makes the copy rules below enforceable by a test instead of by
 * review.
 *
 * ## The copy rules are enforced by test, not by good intentions
 *
 * `src/lib/__tests__/resolveHint.test.ts` asserts every string in
 * `RESOLVE_HINTS` against a deny-list, with a positive control so an empty set
 * cannot make the assertions vacuous. The reason is the same in all four
 * cases — **the app must not advise the user about something it never
 * measured:**
 *
 * - **No "check your network" / Wi-Fi / internet / mobile data.** **No
 *   connectivity detection exists anywhere in PearDrop.** Copy pointing at the
 *   network is advice about a thing the app never looked at.
 * - **No claim that a link expires.** Links do not expire. Ever.
 * - **No bare "network"** — same reason as the first ban, and
 *   it closes the loophole of describing a network condition without using the
 *   word "check".
 * - **No "offline"**. The app **cannot distinguish** "the host
 *   is offline" from "DHT discovery is still in progress". Asserting the former
 *   is as unmeasured as asserting the latter, and it is the more damaging error:
 *   it tells the sender's friend to give up on a share that is about to work.
 *
 * **Consequence worth stating plainly: the dead copy at `ReceiveScreen.tsx:1047`
 * — *"the other pear might be offline or on a slow network"* — fails two of these
 * bans and cannot be reused.** That is why the hint is rebuilt rather than moved.
 *
 * ## The thresholds
 *
 * Both are measured against RN's resolve ceiling, which is **30 s**
 * (`src/state/resolveGuard.ts`). The progression is: spinner alone → first hint
 * → escalation → the guard gives up. Moving one of these without looking at the
 * other two produces either a hint nobody sees or an escalation after the
 * failure. **They are constants, and they are named, for exactly that reason.**
 */

/** First hint at 5 s — inherited from the dead screen's threshold, which was sound. */
export const RESOLVE_HINT_FIRST_MS = 5_000;

/** Escalation at 15 s — halfway to RN's 30 s ceiling, so it is seen well before the end. */
export const RESOLVE_HINT_SECOND_MS = 15_000;

/**
 * Every string the hint can render. **Exported as a whole so the copy test can
 * iterate it** — a hint added here is automatically subject to the deny-list,
 * which is the property that keeps the rules from rotting.
 */
export const RESOLVE_HINTS = {
  first: "Still looking for the other pear…",
  second:
    "Still looking. Keep this open — the first connection can take a little longer.",
} as const;

/**
 * The hint for a given elapsed time, or `null` for "show the spinner alone".
 *
 * **Malformed input is rejected at the boundary, not at the comparison.**
 * `NaN >= 5_000` is `false`, which would silently read as *"not long enough
 * yet"* — the right answer for the wrong reason, and the exact failure mode that
 * once produced a `ran-normally` verdict out of a `NaN` tick counter in this
 * project. A threshold comparison used as a validity check admits `NaN`, so the
 * validity check is done separately and first.
 */
export function resolveHintFor(elapsedMs: number): string | null {
  // `typeof` rather than a type annotation alone: this value originates in a
  // timer and has crossed a `.tsx` boundary, where `strict: false` under ts-jest
  // would not have caught a string.
  if (typeof elapsedMs !== "number") return null;
  if (!Number.isFinite(elapsedMs)) return null;
  if (elapsedMs < 0) return null;

  if (elapsedMs >= RESOLVE_HINT_SECOND_MS) return RESOLVE_HINTS.second;
  if (elapsedMs >= RESOLVE_HINT_FIRST_MS) return RESOLVE_HINTS.first;
  return null;
}
