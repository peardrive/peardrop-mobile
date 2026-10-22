/**
 * Closing the Receive sheet must also abort the resolve, or the in-flight resolve and its timer run
 * on with no surface to report to. A pure function so the suite can assert it without a render.
 */
export type ReceiveSheetCloseDeps = {
  /** Hide the sheet (visibility + focus flags live in MainScreen). */
  hide: () => void;
  /** `ShareLinkFlowContext.abortResolving` — cancels the resolve and its timer. */
  abortResolving: () => void;
  clearDraft: () => void;
};

export function closeReceiveSheet(deps: ReceiveSheetCloseDeps): void {
  deps.abortResolving();
  deps.clearDraft();
  deps.hide();
}
