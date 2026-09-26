import fs from "fs";
import path from "path";

/**
 * The call sites, pinned. `src/lib/receivedRegrab.ts`,
 * `src/lib/receivedRowRoute.ts` and `rememberDriveSession` can each be
 * written, unit-tested and called by nothing: their own suites stay green
 * whether or not the app ever reaches them. A green suite over code nothing
 * calls is not evidence, so the wiring needs its own pin somewhere jest can
 * see it.
 *
 * These are source-text probes because every call site is in a `.tsx`
 * (`ShareLinkFlowContext.tsx`, `MainScreen.tsx`) or in a
 * react-native-importing `.ts` (`src/state/backend.ts`), and the suite runs
 * with `testEnvironment: "node"` and no react-native transform, so none of
 * them can be imported. The window must be bounded and the bound asserted,
 * not assumed — a silently-widened window is the defect.
 *
 * What these probes can prove: the production call exists, in the right
 * function, with the right argument. Not that it runs.
 */

const SHARE_LINK_FLOW = path.join(
  __dirname,
  "..",
  "..",
  "state",
  "ShareLinkFlowContext.tsx",
);
const BACKEND = path.join(__dirname, "..", "..", "state", "backend.ts");
const MAIN_SCREEN = path.join(__dirname, "..", "..", "screens", "MainScreen.tsx");

const flowSrc = fs.readFileSync(SHARE_LINK_FLOW, "utf8");
const backendSrc = fs.readFileSync(BACKEND, "utf8");
const mainSrc = fs.readFileSync(MAIN_SCREEN, "utf8");

/**
 * Slice one component-body declaration out of a `.tsx`. `startMarker` is
 * matched verbatim, `endMarker` bounds the region, and the result is
 * length-checked. Every failure mode is an `expect`, never a throw, so a probe
 * run before the wiring lands fails on an assertion rather than on a missing
 * symbol.
 */
/**
 * Whole-file presence, asserted without feeding the file to `toContain`.
 * `expect(mainSrc).toContain(x)` prints the whole of `MainScreen.tsx` into the
 * failure report and buries every other failure beside it. Comparing two small
 * objects says the same thing in two lines.
 */
function contains(src: string, needle: string): { needle: string; present: boolean } {
  return { needle, present: src.includes(needle) };
}
const present = (needle: string) => ({ needle, present: true });

function region(
  src: string,
  startMarker: string,
  endMarker: string,
  maxLines: number,
): string {
  const start = src.indexOf(startMarker);
  expect({ marker: startMarker, found: start >= 0 }).toEqual({
    marker: startMarker,
    found: true,
  });
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect({ marker: endMarker, found: end > start }).toEqual({
    marker: endMarker,
    found: true,
  });
  const slice = src.slice(start, end);
  const lines = slice.split("\n").length;
  expect({ region: startMarker, lines, withinBound: lines <= maxLines }).toEqual({
    region: startMarker,
    lines,
    withinBound: true,
  });
  return slice;
}

// `partitionGrabNames` is the only fetch/keep split in the app.

describe("ShareLinkFlowContext runDownload wiring (H-5)", () => {
  /** `runDownload`'s own body, bounded at the next component-body `const`. */
  function runDownloadSource(): string {
    const r = region(
      flowSrc,
      "  const runDownload = useCallback(",
      // The next component-body declaration. Its doc comment falls inside the
      // window, so the line bound is generous and the content self-checks
      // below, not the line count, are the real bound.
      "\n  const openStoredSharePicker = useCallback(",
      400,
    );
    // Self-checks on the bound: the region must be runDownload and nothing else.
    expect(r).toContain("setDownloadAllBusy(true)");
    expect(r).not.toContain("const downloadAllFromPreview");
    // The picker is the next declaration and mentions the stored record too,
    // so it is a decoy for every probe below. Prove it is outside the window.
    expect(r).not.toContain("storedShareToOpenResult(");
    return r;
  }

  it("bounds the search window to runDownload itself (F1 guard)", () => {
    const r = runDownloadSource();
    expect(r).toContain("const runDownload = useCallback(");
    // The decoy: `downloadSelectedFromPreview` is the very next declaration
    // pair and also mentions `runDownload`. Prove it is outside the window.
    expect(contains(flowSrc, "const downloadSelectedFromPreview")).toEqual(
      present("const downloadSelectedFromPreview"),
    );
    expect(r).not.toContain("const downloadSelectedFromPreview");
  });

  /**
   * The probe for `partitionGrabNames`. A hand-rolled
   * `targetNames.filter((n) => alreadySet.has(n))` split reads only
   * `alreadyDownloadedNames`, which a live resolve alone populates, so any
   * grab that did not resolve partitions against an empty set and re-fetches
   * every file the user already holds — which `uniquePath` then writes as
   * `photo (1).jpg`. If that literal comes back, the offline re-grab is
   * duplicating files again.
   */
  it("splits fetch/keep through partitionGrabNames, not a local filter", () => {
    const r = runDownloadSource();
    expect(r).toContain("partitionGrabNames(");
    expect(r).not.toContain("targetNames.filter((n) => alreadySet.has(n))");
    expect(r).not.toContain("targetNames.filter((n) => !alreadySet.has(n))");
  });

  /**
   * `DownloadResult.destDir` crosses the RPC and is easily dropped on the
   * floor; `rememberDriveSession` exists to catch it, and needs a caller.
   */
  it("persists the drive session after a grab (C-4/C-5)", () => {
    const r = runDownloadSource();
    expect(r).toContain("rememberDriveSession(");
    expect(r).toContain("destDir");
  });

  /**
   * The offline picker opens with `sessionDriveId === null` on purpose —
   * that is the `closePreview` seam — so `runDownload`'s opening guard is
   * reachable by a real user gesture and must answer rather than silently
   * returning.
   */
  it("answers a grab with no engine session instead of returning silently", () => {
    const r = runDownloadSource();
    expect(r).not.toContain("if (!sessionDriveId) return;");
  });

  /**
   * The receive path's permission ask needs its own pin.
   * `notificationPermission.test.ts` covers the decision thoroughly — the
   * `AppState` guard, the memo, the log lines — and none of it reaches the
   * question of whether the ask is wired into the receive gesture at all:
   * delete `void ensureNotificationPermission();` from `runDownload` and the
   * suite stays green. Without it, a user who only ever receives is never
   * asked in the foreground, and the only prompt comes from the backstop
   * inside `notifyTransferComplete`, whose `AppState === "active"` guard
   * confines it to the background — a permission dialog over another app.
   *
   * Three claims, all bounded to `runDownload` except the import: the aliased
   * import exists, because a call to a name nothing imports is a
   * ReferenceError waiting for the device; the call is inside `runDownload`;
   * and it is fire-and-forget, because awaiting it would park the grab, the
   * modal dismissal and the progress card behind an OS dialog.
   */
  it("asks for the notification permission on the user's own Grab tap (H-4)", () => {
    // 1 — the import. Asserted against the whole file, but as an exact
    // statement, so a mention inside a doc comment cannot satisfy it.
    expect(
      contains(
        flowSrc,
        'import { ensurePermission as ensureNotificationPermission } from "../lib/notifications";',
      ),
    ).toEqual(
      present(
        'import { ensurePermission as ensureNotificationPermission } from "../lib/notifications";',
      ),
    );

    // 2 — the probe: the call site itself, inside runDownload's bounded body.
    const r = runDownloadSource();
    expect(r).toContain("void ensureNotificationPermission();");

    // 3 — fire-and-forget, and ahead of the modal dismissal it must not block.
    expect(r).not.toContain("await ensureNotificationPermission(");
    const askAt = r.indexOf("ensureNotificationPermission()");
    const closeAt = r.indexOf("setPreviewVisible(false)");
    expect({
      askFound: askAt >= 0,
      closeFound: closeAt >= 0,
      askBeforeClose: askAt >= 0 && closeAt > askAt,
    }).toEqual({ askFound: true, closeFound: true, askBeforeClose: true });
  });
});

// `driveId` has to be written at both `upsertShare` call sites.

describe("upsertShare call sites carry driveId (C-4, H-5)", () => {
  it("writes driveId from the resolved manifest in reconcileShareRecord", () => {
    const r = region(
      flowSrc,
      "  const reconcileShareRecord = useCallback(",
      "\n  const rejectUnusableResolve",
      120,
    );
    expect(r).toContain("await upsertShare(next)");
    expect(r).not.toContain("const rejectUnusableResolve");
    // `OpenLinkResult.driveId` is the value; the record field is `driveId`.
    expect(r).toContain("driveId: manifest.driveId");
  });

  it("writes driveId on the simulated-receive record in backend.ts", () => {
    const r = region(
      backendSrc,
      "        await upsertShare({",
      "\n        });",
      30,
    );
    expect(r).toContain("shareKey: res.shareKey.toLowerCase()");
    expect(r).toContain("driveId: res.driveId");
  });
});

// The offline picker, and the tap that reaches it.

describe("the offline re-grab picker (ADD-1, H-5)", () => {
  /**
   * The seam: `closePreview` only calls `deactivateDrive` when
   * `sessionDriveId` is set, so a picker that leaves it null cannot tear down
   * a session it never opened — the same seam `DEMO_DRIVE_ID` uses. No new
   * flag and no new close path.
   */
  it("builds the picker from the stored record with no engine session", () => {
    const r = region(
      flowSrc,
      "  const openStoredSharePicker = useCallback(",
      "\n  const downloadAllFromPreview",
      60,
    );
    expect(r).toContain("storedShareToOpenResult(");
    expect(r).toContain("setSessionDriveId(null)");
    expect(r).toContain("setPreviewVisible(true)");
    // The badge set comes from the stored download flags, not from a resolve.
    expect(r).toContain("heldNames(");
  });

  it("exposes openStoredSharePicker on the context API", () => {
    expect(contains(flowSrc, "openStoredSharePicker: (")).toEqual(
      present("openStoredSharePicker: ("),
    );
  });

  /**
   * `closePreview` is the seam's other half and must stay conditional. Made
   * unconditional, opening the picker offline would deactivate whatever drive
   * happened to be in `sessionDriveId`.
   */
  it("leaves closePreview's teardown conditional on a live session", () => {
    const r = region(
      flowSrc,
      "  const closePreview = useCallback(",
      "\n  /**",
      25,
    );
    expect(r).toContain("if (sessionDriveId && sessionDriveId !== DEMO_DRIVE_ID)");
  });
});

describe("MainScreen onTapRow routing (ADD-1, H-5)", () => {
  /** `onTapRow`'s own body, bounded at the next component-body declaration. */
  function onTapRowSource(): string {
    const r = region(
      mainSrc,
      "  const onTapRow = useCallback(",
      "\n  async function shareFilesAndTrack(",
      70,
    );
    expect(r).not.toContain("shareFilesAndTrack");
    return r;
  }

  it("bounds the search window to onTapRow itself (F1 guard)", () => {
    const r = onTapRowSource();
    expect(r).toContain("const onTapRow = useCallback(");
    expect(contains(mainSrc, "async function shareFilesAndTrack(")).toEqual(
      present("async function shareFilesAndTrack("),
    );
  });

  /**
   * The probe. `onTapRow` acquires this class of defect one ad-hoc branch at
   * a time, so the handler asks `rowTapRoute` once and dispatches on the
   * answer: a further outcome is then a change to a tested pure module rather
   * than another `if` nobody can assert.
   */
  it("dispatches on rowTapRoute rather than on inline isBundle/primaryFile ifs", () => {
    const r = onTapRowSource();
    expect(r).toContain("rowTapRoute(");
    // The two branches that never read `origin` — the substance of the defect.
    expect(r).not.toContain("if (drive.isBundle) {");
    expect(r).not.toContain("if (!primary) {");
  });

  it("feeds rowTapRoute the holdings predicate rather than recomputing it", () => {
    const r = onTapRowSource();
    expect(r).toContain("describeHoldings(");
    expect(r).toContain("origin: drive.origin");
    expect(r).toContain("hasStoredShare");
  });

  /**
   * A `regrab-picker` route must reach a picker. A route that falls through
   * to the info panel is worse than not routing at all.
   */
  it("routes regrab-picker into the offline picker, not the info panel", () => {
    const r = onTapRowSource();
    expect(r).toContain('"regrab-picker"');
    expect(r).toContain("openStoredSharePicker(");
    // Pulled off the context, not hand-rolled locally.
    expect(contains(mainSrc, "    openStoredSharePicker,")).toEqual(
      present("    openStoredSharePicker,"),
    );
  });

  it("imports rowTapRoute from the tested module", () => {
    expect(contains(mainSrc, 'from "../lib/receivedRowRoute"')).toEqual(
      present('from "../lib/receivedRowRoute"'),
    );
    // The named import specifically, not an incidental mention in a comment.
    expect(
      contains(mainSrc, 'import { rowTapRoute } from "../lib/receivedRowRoute";'),
    ).toEqual(present('import { rowTapRoute } from "../lib/receivedRowRoute";'));
  });
});
