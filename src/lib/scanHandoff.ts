/**
 * What an accepted QR scan does to the Receive sheet.
 *
 * The scan handler used to hide the sheet and then start the resolve, so the
 * camera was torn down and the user landed on the list with no spinner, no
 * Cancel, and nowhere for a failure to report. The sheet now stays open and
 * shows the looking state, exactly as a pasted link does.
 *
 * A record rather than a function of anything: there is one right answer per
 * field, and the point is that the suite can see it. The hide lives in a
 * `.tsx`, which jest never renders.
 */
export type ScanHandoff = {
  /** False: the looking state needs the sheet mounted to draw on. */
  hidesReceiveSheet: boolean;
  /** True: the scanned link goes straight to runResolve, no debounce. */
  resolves: boolean;
  /** False: aborting would kill the resolve started on the next line. */
  aborts: boolean;
  /** True: the ×, the retry icon and `retryResolve` are all keyed on the draft.
   *  A one-shot ref in the provider stops the re-armed debounce resolving it twice. */
  writesDraft: boolean;
  /** True: otherwise the re-mounted camera ignores every later code. */
  clearsScanLatch: boolean;
};

export function scanHandoff(): ScanHandoff {
  return {
    hidesReceiveSheet: false,
    resolves: true,
    aborts: false,
    writesDraft: true,
    clearsScanLatch: true,
  };
}
