/**
 * Where a successful resolve leaves the Receive sheet.
 *
 * The sheet and the preview are two RN `Modal`s owned by two different state
 * systems: `receiveSheetVisible` is local to `MainScreen`, `previewVisible`
 * lives in `ShareLinkFlowContext`. Nothing on the success path connected them,
 * so pasting a link left the sheet mounted under the picker.
 *
 * This must NOT route through `closeReceiveSheet`: that calls `abortResolving`,
 * which bumps the resolve generation and fires an engine abort — on a resolve
 * that just succeeded. The sheet needs hiding, not cancelling.
 *
 * Extracted for the Amendment A-3 reason: the suite renders no `.tsx`, so the
 * decision is only assertable as a pure function.
 */
export type ResolveHandoffKind = "full" | "partial" | "none";

export type PreviewHandoff = {
  /** Hide the Receive sheet. True for every success, `full` included. */
  closesReceiveSheet: boolean;
  /** Whether a picker actually appears. `full` shows a toast and no preview. */
  opensPreview: boolean;
};

export function previewHandoffFor(kind: ResolveHandoffKind): PreviewHandoff {
  // `full` opens no preview but still raises "You've already got these." —
  // the sheet has to go or the toast lands behind it.
  return { closesReceiveSheet: true, opensPreview: kind !== "full" };
}
