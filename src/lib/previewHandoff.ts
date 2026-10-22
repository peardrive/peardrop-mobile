/**
 * Where a successful resolve leaves the Receive sheet. Must NOT route through `closeReceiveSheet`:
 * that aborts the resolve that just succeeded. The sheet needs hiding, not cancelling.
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
