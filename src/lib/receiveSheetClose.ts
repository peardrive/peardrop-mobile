/**
 * closing the Receive sheet must also abort the resolve.
 *
 * `onClose` in `src/screens/MainScreen.tsx` hid the
 * sheet and nothing else, so dismissing it (back button, scrim tap) left the
 * in-flight resolve — and its 30 s rejection timer — running with no surface
 * to report to. Only the × on the paste input called `abortResolving`.
 *
 * Extracted here because the jest suite renders no
 * `.tsx`, so "close also aborts" is only assertable against a pure function.
 * `src/lib/__tests__/receiveSheetClose.test.ts` fails if the
 * `abortResolving()` call is removed.
 */
export type ReceiveSheetCloseDeps = {
  /** Hide the sheet (visibility + focus flags live in MainScreen). */
  hide: () => void;
  /** `ShareLinkFlowContext.abortResolving` — cancels the resolve and its timer. */
  abortResolving: () => void;
};

export function closeReceiveSheet(deps: ReceiveSheetCloseDeps): void {
  deps.abortResolving();
  deps.hide();
}
