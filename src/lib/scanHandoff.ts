/**
 * What an accepted QR scan does to the Receive sheet: it stays open and shows the looking state,
 * exactly as a pasted link does. A record, so the suite can read the answer without a render.
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
