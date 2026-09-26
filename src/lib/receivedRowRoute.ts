/**
 * where a tap on a share row goes.
 *
 * ## The defect
 *
 * Someone opens a link, sees the file list, leaves without choosing, and comes
 * back later. Tapping that row must reopen the file picker. It did not: the
 * row fell through to the File-info panel.
 *
 * `onTapRow` (`src/screens/MainScreen.tsx`) branched on `isBundle`, then on
 * `primaryFile`, and **never read `origin`**. `rowPrimaryFile` only returns a
 * file when `localFiles.length === 1`, which is never true before a grab — so
 * every received share with nothing downloaded landed in the fallback.
 *
 * ## Why a pure module, and why ALL FOUR outcomes come through here
 *
 * `MainScreen.tsx` is unreachable from the jest suite (`jest.config.js` is
 * `testEnvironment: "node"` with no react-native transform; `testMatch`
 * collects only `*.test.ts`), so a decision made inline is a decision no test
 * can observe — the same shape as `src/lib/shareActions.ts` and
 * `src/lib/recentShareLink.ts`.
 *
 * `onTapRow` has shipped this class of
 * defect **three times**. Adding a fourth ad-hoc branch next to the other three
 * is how a fifth arrives. So the handler asks this function once and
 * dispatches on the answer: every outcome is named, ordered here, and tested.
 *
 * ## The completeness predicate is NOT re-implemented
 *
 * `Holdings.allHeld` (`src/lib/receivedHoldings.ts`) already exists and is
 * already produced at the row (`MainScreen.tsx:2363`) — it was just never read
 * by any control flow, only by labels. It is passed in, structurally, rather
 * than recomputed: two definitions of "does this device have the whole share"
 * would drift, and the label and the routing must never disagree.
 */

/** Where the tap goes. Every branch of `onTapRow` is one of these four. */
export type RowTapRoute =
  /** reopen the file picker over the stored file list. */
  | "regrab-picker"
  /** A multi-file share: the folder-contents modal. */
  | "folder-modal"
  /** A single file with a local copy: the in-app preview. */
  | "file-preview"
  /** Nothing to preview: the File-info panel (status / activate / delete). */
  | "info-panel";

/**
 * What the row knows about itself. Structural on purpose — an import of
 * `DriveRow` would drag `src/screens/MainScreen.tsx` into the suite, and
 * `DriveRow` is local to that file anyway.
 */
export type RowTapInput = {
  /** `DriveRecord.origin`. Absent on a row the engine has not classified. */
  origin?: string | null | undefined;
  /** `DriveRow.isBundle` — the manifest lists more than one file. */
  isBundle?: boolean | null | undefined;
  /** `DriveRow.primaryFile` resolved to a local copy. */
  hasPrimaryFile?: boolean | null | undefined;
  /** A `ReceivedShare` record is attached to this row. */
  hasStoredShare?: boolean | null | undefined;
  /**
   * `describeHoldings(share.files)`, or `null` for a row with no stored share.
   * Only the two fields the decision reads are required.
   */
  holdings?: { totalCount: number; allHeld: boolean } | null | undefined;
};

export function rowTapRoute(input: RowTapInput): RowTapRoute {
  /**
   * This has to come FIRST.
   *
   * Both branches below would otherwise swallow it: a received share with
   * nothing downloaded and three files is `isBundle: true`, and one with a
   * single missing file has no `primaryFile` and so fell to the info panel.
   *
   * Three guards, each of which a test asserts separately:
   *
   * - **`origin === "received"`.** A hosted row has nothing to re-grab. This is
   *   the first time this handler has read `origin` at all, which is the whole
   *   substance of the defect.
   * - **`hasStoredShare`.** The route means "open the picker over the stored
   *   file list"; with no record there is no list and the caller would have
   *   nothing to pass.
   * - **`totalCount > 0`.** `describeHoldings([])` answers `allHeld: false` —
   *   right for a label, wrong as a re-grab trigger, because there is nothing to
   *   grab. Without this, an empty record offers a picker with no rows.
   */
  if (
    input.origin === "received" &&
    input.hasStoredShare === true &&
    !!input.holdings &&
    input.holdings.totalCount > 0 &&
    !input.holdings.allHeld
  ) {
    return "regrab-picker";
  }
  if (input.isBundle === true) return "folder-modal";
  if (input.hasPrimaryFile === true) return "file-preview";
  return "info-panel";
}
