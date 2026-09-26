import fs from "fs";
import path from "path";

import { RESHARE_INCOMPLETE_HINT } from "../reshareControl";

/**
 * The call sites for the three re-share surfaces. `reshareControl.test.ts`
 * next door proves nothing about the app on its own: its suite stays green
 * whether or not `MainScreen` ever reaches the module, and a passing suite
 * over code nothing calls is not evidence.
 *
 * These are source-text probes because all three surfaces live in `.tsx`
 * (`MainScreen.tsx`, `ShareQrModal.tsx`, `FolderContentsModal.tsx`) and the
 * suite runs with `testEnvironment: "node"` and no react-native transform, so
 * none of them can be imported. The window must be bounded and the bound
 * asserted, not assumed — a silently-widened window is the defect.
 *
 * What these can prove: the production call exists, in the right function,
 * with the right argument, and that the predicate it replaced is gone. Not
 * that it runs.
 */

const MAIN_SCREEN = path.join(__dirname, "..", "..", "screens", "MainScreen.tsx");
const SHARE_QR = path.join(__dirname, "..", "..", "ui", "ShareQrModal.tsx");
const FOLDER_MODAL = path.join(
  __dirname,
  "..",
  "..",
  "ui",
  "FolderContentsModal.tsx",
);

const mainSrc = fs.readFileSync(MAIN_SCREEN, "utf8");
const qrSrc = fs.readFileSync(SHARE_QR, "utf8");
const folderSrc = fs.readFileSync(FOLDER_MODAL, "utf8");

/**
 * Whole-file presence, asserted without feeding the file to `toContain`.
 * `expect(mainSrc).toContain(x)` prints the whole of `MainScreen.tsx` into the
 * failure report and buries every other failure next to it. Comparing two
 * small objects says the same thing in two lines.
 */
function contains(src: string, needle: string): { needle: string; present: boolean } {
  return { needle, present: src.includes(needle) };
}
const present = (needle: string) => ({ needle, present: true });
const absent = (needle: string) => ({ needle, present: false });

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

describe("MainScreen imports the re-share decision rather than re-deriving it", () => {
  /**
   * A call to a name nothing imports is a `ReferenceError` waiting for the
   * device, so the named imports are asserted as exact statements: a mention
   * inside a doc comment cannot satisfy them.
   */
  it("imports all four entry points from the tested module", () => {
    for (const needle of [
      "  receivedShareIsAnnouncing,",
      "  reshareControl,",
      "  reshareStartOutcome,",
      "  reshareStopOutcome,",
      '} from "../lib/reshareControl";',
    ]) {
      expect(contains(mainSrc, needle)).toEqual(present(needle));
    }
  });
});

describe("SURFACE 1 — the received row's Share / Stop control (kebab)", () => {
  /** The kebab item block itself, bounded at the hosted branch that follows. */
  function reshareItemSource(): string {
    const r = region(
      mainSrc,
      '          if (kebabReshare && kebabReshare.kind !== "none") {',
      "          } else if (!kebabIsReceivedShare && kebabActive) {",
      40,
    );
    // Self-check on the bound: the hosted Stop item is the NEXT block and is a
    // decoy for every probe below — it pushes a "Stop sharing" label too.
    expect(r).not.toContain('key: "stop"');
    expect(r).not.toContain("onStopSharing(");
    return r;
  }

  it("bounds the search window to the re-share block itself (F1 guard)", () => {
    const r = reshareItemSource();
    expect(r).toContain('key: "reshare"');
    // The decoys exist outside the window, so the bound is doing real work.
    expect(contains(mainSrc, "              onPress: () => void onStopSharing(kebabDrive),")).toEqual(
      present("              onPress: () => void onStopSharing(kebabDrive),"),
    );
    expect(contains(mainSrc, '              label: "Start sharing",')).toEqual(
      present('              label: "Start sharing",'),
    );
  });

  /**
   * The probe for surface 1: delete this `list.push` and the received row has
   * no Share control at all. The label and the icon are taken from the
   * control, never re-typed here — two literals for one word agree only until
   * someone edits one of them.
   */
  it("pushes the control the tested module returned", () => {
    const r = reshareItemSource();
    expect(r).toContain("const control = kebabReshare;");
    expect(r).toContain("label: control.label,");
    expect(r).toContain('icon: control.kind === "stop" ? "stop-circle" : "share-outline",');
  });

  /**
   * The control is visible and disabled on an incomplete row, carrying
   * exactly one sentence. A build that hides it instead satisfies nothing,
   * and `disabled`/`sublabel` are the only two props that can express that
   * state.
   */
  it("renders the incomplete row disabled with its reason, not hidden", () => {
    const r = reshareItemSource();
    expect(r).toContain("disabled: !control.enabled,");
    expect(r).toContain("sublabel: control.disabledReason,");
    // The sheet must be able to honour both. A prop the component ignores is
    // the same as no prop.
    const kebab = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "KebabActionSheet.tsx"),
      "utf8",
    );
    expect(contains(kebab, "  disabled?: boolean;")).toEqual(
      present("  disabled?: boolean;"),
    );
    expect(contains(kebab, "  sublabel?: string | null;")).toEqual(
      present("  sublabel?: string | null;"),
    );
    expect(contains(kebab, "onPress={isDisabled ? undefined : item.onPress}")).toEqual(
      present("onPress={isDisabled ? undefined : item.onPress}"),
    );
    expect(contains(kebab, "{item.sublabel}")).toEqual(present("{item.sublabel}"));
  });

  /** The exact string, pinned from the module the control reads it from. */
  it("carries the owner's sentence and no other", () => {
    expect(RESHARE_INCOMPLETE_HINT).toBe("Finish downloading to share it.");
  });
});

describe("SURFACE 2 — Stop sharing a received copy", () => {
  /** `onReshare`'s own body, bounded at the next component-body declaration. */
  function onReshareSource(): string {
    const r = region(
      mainSrc,
      "  const onReshare = useCallback(",
      "\n  // Sprint 3M: unified pin / favorite toggles.",
      60,
    );
    expect(r).not.toContain("const togglePinned");
    return r;
  }

  it("bounds the search window to onReshare itself (F1 guard)", () => {
    const r = onReshareSource();
    expect(r).toContain("const onReshare = useCallback(");
    expect(contains(mainSrc, "  const togglePinned = useCallback(")).toEqual(
      present("  const togglePinned = useCallback("),
    );
  });

  /**
   * The probe for surface 2. Stop is `serve: false`, not `deactivateDrive`:
   * deactivating tears the session down and leaves the persisted `reshared`
   * intent set, so the boot rule re-announces on the next launch and the
   * user's stop lasts only until they close the app.
   */
  it("reaches the engine through activate with an explicit serve flag", () => {
    const r = onReshareSource();
    expect(r).toContain("await activateDrive(driveId, { serve })");
    expect(r).not.toContain("deactivateDrive(");
  });

  /**
   * The tri-state, defended at the only two sites that can break it. `serve`
   * absent means "no opinion" and is what keeps a received drive client-only
   * by default. `onShareIt`, the hosted path, must keep passing no options
   * object, and `onReshare` must keep passing a real boolean. Collapsing
   * either into the other deletes a state from the app.
   */
  it("leaves onShareIt's no-opinion call untouched", () => {
    expect(contains(mainSrc, "const res = await activateDrive(drive.id);")).toEqual(
      present("const res = await activateDrive(drive.id);"),
    );
    // Nothing anywhere may hand `activate` a bare `{}` or a coerced flag.
    expect(contains(mainSrc, "activateDrive(drive.id, {")).toEqual(
      absent("activateDrive(drive.id, {"),
    );
  });

  /**
   * Both directions read the reply through the tested module — including the
   * `serveRefused`-before-`mode` ordering, which is the only thing that can
   * tell a refusal from a failed promotion.
   */
  it("reads the reply through the tested outcome readers, both directions", () => {
    const r = onReshareSource();
    expect(r).toContain(
      "const out = serve ? reshareStartOutcome(res) : reshareStopOutcome(res);",
    );
    // The live mode is recorded from the reply, never assumed from the request.
    expect(r).toContain("setObservedReshareModes(");
    expect(r).toContain("out.mode");
    expect(r).not.toContain('serve ? "server" : "client"');
  });

  it("routes by the engine driveId, never by the synthetic row id", () => {
    const r = onReshareSource();
    expect(r).toContain("const driveId = signals.driveId;");
    expect(r).toContain("if (!driveId || !shareKey) return;");
    expect(r).not.toContain("activateDrive(drive.id");
  });
});

describe("SURFACE 3 — Copy Link and QR are gated on announcing, not on active", () => {
  /**
   * The predicate itself. `active` is true for every hydrated received drive,
   * all of which announce nothing; this is the line that stops the app handing
   * out a link for a swarm it does not have.
   */
  it("defines the kebab gate as announcing for received, active for hosted", () => {
    const needle =
      "  const kebabCanOfferLink = kebabIsReceivedShare\n    ? kebabAnnouncing\n    : kebabActive;";
    expect(contains(mainSrc, needle)).toEqual(present(needle));
    expect(
      contains(
        mainSrc,
        "    !!kebabDrive && receivedShareIsAnnouncing(reshareSignalsFor(kebabDrive));",
      ),
    ).toEqual(
      present(
        "    !!kebabDrive && receivedShareIsAnnouncing(reshareSignalsFor(kebabDrive));",
      ),
    );
  });

  /**
   * The probe for the kebab half of surface 3: both items, and the previous
   * predicate asserted gone. Absence is the whole claim here, because the
   * defect is not a missing gate but the wrong one.
   */
  it("gates both kebab items on the new predicate and retires the old one", () => {
    expect(contains(mainSrc, "if (kebabCanOfferLink && shareLink) {")).toEqual(
      present("if (kebabCanOfferLink && shareLink) {"),
    );
    expect(contains(mainSrc, "          if (kebabCanOfferLink) {")).toEqual(
      present("          if (kebabCanOfferLink) {"),
    );
    expect(contains(mainSrc, "if (kebabActive && shareLink) {")).toEqual(
      absent("if (kebabActive && shareLink) {"),
    );
  });

  /**
   * THE PROBE for the info modal. `MainScreen` computes the gate and
   * `ShareQrModal` honours it; both halves are required, so both are asserted.
   */
  it("passes the gate into ShareQrModal and uses it for the QR and the Copy button", () => {
    expect(contains(mainSrc, "canOfferLink={qrCanOfferLink}")).toEqual(
      present("canOfferLink={qrCanOfferLink}"),
    );
    expect(
      contains(
        mainSrc,
        "              qrCanOfferLink && link ? () => void onCopyLink(link) : undefined",
      ),
    ).toEqual(
      present(
        "              qrCanOfferLink && link ? () => void onCopyLink(link) : undefined",
      ),
    );
    expect(
      contains(mainSrc, "            ? receivedShareIsAnnouncing(reshareSignalsFor(drive))"),
    ).toEqual(
      present("            ? receivedShareIsAnnouncing(reshareSignalsFor(drive))"),
    );
    // The ungated predicate, gone.
    expect(
      contains(mainSrc, "isActive && link ? () => void onCopyLink(link) : undefined"),
    ).toEqual(absent("isActive && link ? () => void onCopyLink(link) : undefined"));

    // The component half. `?? isActive`, never `|| isActive`: an explicit
    // `false` must win, and `||` falls back for exactly the rows the gate
    // exists for.
    expect(
      contains(qrSrc, "const linkOfferable = (canOfferLink ?? isActive) === true;"),
    ).toEqual(present("const linkOfferable = (canOfferLink ?? isActive) === true;"));
    expect(contains(qrSrc, "{linkOfferable && hasLink ? (")).toEqual(
      present("{linkOfferable && hasLink ? ("),
    );
    expect(contains(qrSrc, "{isActive && hasLink ? (")).toEqual(
      absent("{isActive && hasLink ? ("),
    );
    // Hosted rows are unchanged, and that is a claim about the DEFAULT: with no
    // `canOfferLink` the expression is `isActive`, exactly as before.
    expect(contains(qrSrc, "  canOfferLink?: boolean;")).toEqual(
      present("  canOfferLink?: boolean;"),
    );
  });

  /**
   * The probe for the folder modal, the genuinely ungated one: its CTA keys
   * on `shareLink` existing and nothing else, and the post-grab completion
   * effect opens this modal after every multi-file grab.
   */
  it("gates the folder modal's Copy Link CTA at the call site", () => {
    const needle =
      "        shareLink={\n          folderModalCanOfferLink ? folderModalDrive?.shareLink ?? null : null\n        }";
    expect(contains(mainSrc, needle)).toEqual(present(needle));
    expect(
      contains(mainSrc, "          if (folderModalCanOfferLink && link) void onCopyLink(link);"),
    ).toEqual(
      present("          if (folderModalCanOfferLink && link) void onCopyLink(link);"),
    );
    // The predicate: announcing for received, and hosted behaviour untouched.
    expect(
      contains(
        mainSrc,
        "      ? receivedShareIsAnnouncing(reshareSignalsFor(folderModalDrive))",
      ),
    ).toEqual(
      present(
        "      ? receivedShareIsAnnouncing(reshareSignalsFor(folderModalDrive))",
      ),
    );
    // The ungated pass-through, gone.
    expect(
      contains(mainSrc, "shareLink={folderModalDrive?.shareLink ?? null}"),
    ).toEqual(absent("shareLink={folderModalDrive?.shareLink ?? null}"));
    // The component still renders the CTA off the prop, so passing `null` is
    // the whole mechanism. If this branch ever stops reading `shareLink`, the
    // call-site gate silently stops working.
    expect(contains(folderSrc, "            ) : shareLink ? (")).toEqual(
      present("            ) : shareLink ? ("),
    );
  });
});
