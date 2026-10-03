import fs from "fs";
import path from "path";

/**
 * Every Receive-sheet dismissal routes through one close path.
 *
 * `closeReceiveSheet` guarantees abort → clear → hide, but only for callers
 * that use it. Two closers were added around it and never adopted it, so the
 * helper's own test passed while the scan and timeout paths cleared nothing.
 * These probes assert the wiring the unit test cannot see.
 *
 * Same bounded-region pattern as `regrabWiring.test.ts`: the window MUST be
 * bounded and the bound asserted, never assumed.
 */

const MAIN_SCREEN = path.join(__dirname, "..", "..", "screens", "MainScreen.tsx");
const SHARE_LINK_FLOW = path.join(
  __dirname,
  "..",
  "..",
  "state",
  "ShareLinkFlowContext.tsx",
);
const PREVIEW_MODAL = path.join(__dirname, "..", "..", "ui", "SharePreviewModal.tsx");
const mainSrc = fs.readFileSync(MAIN_SCREEN, "utf8");
const flowSrc = fs.readFileSync(SHARE_LINK_FLOW, "utf8");
const previewSrc = fs.readFileSync(PREVIEW_MODAL, "utf8");

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

describe("MainScreen Receive-sheet close wiring", () => {
  it("builds the one close path out of closeReceiveSheet, with a clearDraft dep", () => {
    const body = region(
      mainSrc,
      "  const dismissReceiveSheet = useCallback(() => {",
      "\n  // UX-2026-09 · I-2: after the 30 s resolve timeout",
      16,
    );
    expect([
      contains(body, "closeReceiveSheet({"),
      contains(body, "abortResolving,"),
      contains(body, 'clearDraft: () => setLinkDraft("")'),
      contains(body, "setReceiveSheetVisible(false)"),
    ]).toEqual([
      present("closeReceiveSheet({"),
      present("abortResolving,"),
      present('clearDraft: () => setLinkDraft("")'),
      present("setReceiveSheetVisible(false)"),
    ]);
  });

  it("routes the sheet's onClose through it, not through a bare setter", () => {
    expect(contains(mainSrc, "onClose={dismissReceiveSheet}")).toEqual(
      present("onClose={dismissReceiveSheet}"),
    );
  });

  it("routes the 30 s timeout through it — the closed sheet must not keep the link", () => {
    const body = region(
      mainSrc,
      "    if (resolveTimeoutTick <= 0) return;",
      "  }, [resolveTimeoutTick",
      4,
    );
    expect(contains(body, "dismissReceiveSheet();")).toEqual(
      present("dismissReceiveSheet();"),
    );
  });
});

describe("R-1 preview handoff wiring", () => {
  it("routes all three success verdicts through previewHandoffFor", () => {
    expect([
      contains(flowSrc, 'import { previewHandoffFor, type ResolveHandoffKind }'),
      contains(flowSrc, 'handOffToPreview("full");'),
      contains(flowSrc, 'handOffToPreview("partial");'),
      contains(flowSrc, 'handOffToPreview("none");'),
    ]).toEqual([
      present('import { previewHandoffFor, type ResolveHandoffKind }'),
      present('handOffToPreview("full");'),
      present('handOffToPreview("partial");'),
      present('handOffToPreview("none");'),
    ]);
  });

  it("derives both the preview flag and the tick from the module, not by hand", () => {
    const body = region(
      flowSrc,
      "      const handOffToPreview = (handoffKind: ResolveHandoffKind) => {",
      "\n      if (kind === \"full\")",
      8,
    );
    expect([
      contains(body, "previewHandoffFor(handoffKind)"),
      contains(body, "setPreviewVisible(handoff.opensPreview)"),
      contains(body, "if (handoff.closesReceiveSheet) setPreviewOpenedTick"),
    ]).toEqual([
      present("previewHandoffFor(handoffKind)"),
      present("setPreviewVisible(handoff.opensPreview)"),
      present("if (handoff.closesReceiveSheet) setPreviewOpenedTick"),
    ]);
  });

  it("hides the sheet on the tick WITHOUT aborting — the resolve succeeded", () => {
    const body = region(
      mainSrc,
      "    if (previewOpenedTick <= 0) return;",
      "  }, [previewOpenedTick]);",
      5,
    );
    expect([
      contains(body, "setReceiveSheetVisible(false);"),
      contains(body, "dismissReceiveSheet"),
    ]).toEqual([present("setReceiveSheetVisible(false);"), {
      needle: "dismissReceiveSheet",
      present: false,
    }]);
  });
});

describe("R-2 picker lookup wiring", () => {
  it("drives the status line from pickerLookupStatus, not from inline conditions", () => {
    expect([
      // The import is multi-line now — it also pulls in PickerLookupState for
      // the haptic edge detector's ref — so match the specifier, not the line.
      contains(previewSrc, 'from "../lib/pickerLookupStatus"'),
      contains(previewSrc, "pickerLookupStatus({"),
      contains(previewSrc, "{lookup.text}"),
      contains(previewSrc, 'accessibilityLiveRegion="polite"'),
    ]).toEqual([
      present('from "../lib/pickerLookupStatus"'),
      present("pickerLookupStatus({"),
      present("{lookup.text}"),
      present('accessibilityLiveRegion="polite"'),
    ]);
  });

  it("reads `resolving` off the context — the modal ignored it before", () => {
    const body = region(
      previewSrc,
      "  } = useShareLinkFlow();",
      "\n  const files = useMemo(",
      4,
    );
    expect(contains(previewSrc, "    resolving,\n  } = useShareLinkFlow();")).toEqual(
      present("    resolving,\n  } = useShareLinkFlow();"),
    );
    expect(body.length).toBeGreaterThan(0);
  });

  it("aborts the background lookup when the picker closes, so a late result is inert", () => {
    const body = region(
      flowSrc,
      "  const closePreview = useCallback(() => {",
      "\n  }, [abortOpen, deactivateDrive, sessionDriveId]);",
      25,
    );
    expect([
      contains(body, "resolveGen.current++;"),
      contains(body, "void abortOpen();"),
      contains(body, "setResolving(false);"),
      // The seam that lets the offline picker open with no session must stay.
      contains(body, "if (sessionDriveId && sessionDriveId !== DEMO_DRIVE_ID)"),
    ]).toEqual([
      present("resolveGen.current++;"),
      present("void abortOpen();"),
      present("setResolving(false);"),
      present("if (sessionDriveId && sessionDriveId !== DEMO_DRIVE_ID)"),
    ]);
  });
});

describe("looking-state wiring", () => {
  const RECEIVE_SHEET = path.join(__dirname, "..", "..", "ui", "ReceiveSheet.tsx");
  const sheetSrc = fs.readFileSync(RECEIVE_SHEET, "utf8");

  it("renders the indicator with its colour from indicatorColor, not a raw token", () => {
    // Scoped to the panel: theme.primary is legitimate elsewhere in this file
    // (the camera placeholder's spinner and icon).
    const panel = region(
      sheetSrc,
      "              {visible && resolving ? (",
      "\n              ) : Platform.OS === \"web\" ? (",
      26,
    );
    expect([
      contains(sheetSrc, 'import { indicatorColor } from "../lib/indicatorColor"'),
      contains(panel, "color={indicatorColor(theme)}"),
      // A raw theme.primary here is the bug ruling 10 exists to prevent.
      contains(panel, "color={theme.primary}"),
    ]).toEqual([
      present('import { indicatorColor } from "../lib/indicatorColor"'),
      present("color={indicatorColor(theme)}"),
      { needle: "color={theme.primary}", present: false },
    ]);
  });

  it("takes the label and the t=0 caption from resolveHint, not from the tsx", () => {
    expect([
      contains(sheetSrc, "label={RESOLVE_LOOKING_LABEL}"),
      contains(sheetSrc, "{resolveHint ?? RESOLVE_HINTS.initial}"),
    ]).toEqual([
      present("label={RESOLVE_LOOKING_LABEL}"),
      present("{resolveHint ?? RESOLVE_HINTS.initial}"),
    ]);
  });

  it("puts the looking arm BEFORE the camera ladder, so CameraView unmounts", () => {
    const loading = sheetSrc.indexOf("{visible && resolving ? (");
    const web = sheetSrc.indexOf('Platform.OS === "web" ? (');
    const cam = sheetSrc.indexOf("<CameraView");
    expect({ found: loading > 0 }).toEqual({ found: true });
    // Order is the whole mechanism: a later arm would render alongside, not
    // instead of, the camera.
    expect({ beforeWeb: loading < web, beforeCam: loading < cam }).toEqual({
      beforeWeb: true,
      beforeCam: true,
    });
  });

  it("clears the scan latch and the stale badge when the looking state is left", () => {
    const body = region(
      sheetSrc,
      "    if (!resolving) {",
      "\n    const startedAt = Date.now();",
      12,
    );
    expect([
      contains(body, "scannedRef.current = false;"),
      contains(body, "setScanFlash(false);"),
      contains(body, "setScanError(null);"),
    ]).toEqual([
      present("scannedRef.current = false;"),
      present("setScanFlash(false);"),
      present("setScanError(null);"),
    ]);
  });

  it("puts those resets BEFORE the early return, so they are not dead code", () => {
    // Presence alone is vacuous: moving any of them below the `return;` leaves
    // the string in the region while never executing it.
    const body = region(
      sheetSrc,
      "    if (!resolving) {",
      "\n    const startedAt = Date.now();",
      12,
    );
    const ret = body.indexOf("return;");
    expect({ found: ret > 0 }).toEqual({ found: true });
    const reachable = (needle: string) => ({
      needle,
      reachable: body.indexOf(needle) > 0 && body.indexOf(needle) < ret,
    });
    expect([
      reachable("scannedRef.current = false;"),
      reachable("setScanFlash(false);"),
      reachable("setScanError(null);"),
    ]).toEqual([
      { needle: "scannedRef.current = false;", reachable: true },
      { needle: "setScanFlash(false);", reachable: true },
      { needle: "setScanError(null);", reachable: true },
    ]);
  });

  it("gates the looking arm on `visible` too, so only one sonar can mount", () => {
    // iOS Modal keeps its children rendered after the first open
    // (`isRendered`, Modal.js:267-270), so a hidden Receive sheet would mount
    // a second, invisible sonar every time the picker resolves. Android
    // unmounts the subtree, so this is a no-op there.
    expect(contains(sheetSrc, "{visible && resolving ? (")).toEqual(
      present("{visible && resolving ? ("),
    );
  });

  it("no longer renders the resolve hint twice", () => {
    // Two polite live regions with the same sentence announced it twice.
    const occurrences = sheetSrc.split("{resolveHint").length - 1;
    expect({ occurrences }).toEqual({ occurrences: 1 });
  });

  it("no longer hides the sheet on an accepted scan", () => {
    const body = region(
      mainSrc,
      "        onScan={(data) => {",
      "\n        linkError={linkError}",
      9,
    );
    expect([
      contains(body, "scanHandoff()"),
      contains(body, "void resolveFromScan(data, { writeDraft: true });"),
      contains(body, "setReceiveSheetVisible(false)"),
    ]).toEqual([
      present("scanHandoff()"),
      present("void resolveFromScan(data, { writeDraft: true });"),
      { needle: "setReceiveSheetVisible(false)", present: false },
    ]);
  });
});

/**
 * One scan must produce exactly ONE resolve.
 *
 * A scan now writes `linkDraft` so the input, the × and the retry icon work —
 * and that re-arms the 450 ms debounce. A second resolve is not merely
 * redundant: it bumps the generation and calls `abortOpen()`, killing the
 * first mid-flight so an `out.driveId` it produced never gets torn down
 * (`resolveGuard.ts:53,57,78-88`). A one-shot ref makes the debounce skip
 * exactly the value the scan already resolved.
 *
 * The ordering IS the mechanism, so presence alone would be vacuous: the guard
 * above the `clearTimeout` leaves a stale timer armed, and below the
 * `setTimeout` it never prevents anything.
 */
describe("P-2 one scan, one resolve", () => {
  const DEBOUNCE_START =
    "  useEffect(() => {\n    if (debounceRef.current) clearTimeout(debounceRef.current);";

  it("writes the draft through the raw setter, with the ref set first", () => {
    // Bound raised 24 → 40. The reason is a review finding, not drift: arming
    // the one-shot had to become conditional on the write actually changing
    // the draft (an identical value is a no-op setter, so the effect never
    // re-runs and the ref is never consumed), and the comment explaining that
    // trap is worth more than a tight bound. The far edge is still pinned by
    // the next declaration in the end marker.
    const body = region(
      flowSrc,
      "  const resolveFromScan = useCallback(",
      "\n  const retryResolve = useCallback",
      40,
    );
    const ref = body.indexOf("draftWrittenByScanRef.current = shown;");
    const set = body.indexOf("setLinkDraftRaw(shown);");
    expect([
      contains(body, "opts?: { writeDraft?: boolean }"),
      contains(body, "normalizeShareLink(text)"),
      contains(body, "await runResolve(text);"),
    ]).toEqual([
      present("opts?: { writeDraft?: boolean }"),
      present("normalizeShareLink(text)"),
      present("await runResolve(text);"),
    ]);
    // Ref before setter: it must be in place by the time the effect reads the
    // new draft, or the guard misses and a second resolve fires.
    expect({ refFound: ref > 0, setFound: set > 0, refBeforeSet: ref < set }).toEqual({
      refFound: true,
      setFound: true,
      refBeforeSet: true,
    });
  });

  it("puts the one-shot guard AFTER the clearTimeout and BEFORE the setTimeout", () => {
    const body = region(flowSrc, DEBOUNCE_START, "  }, [linkDraft, ready, runResolve]);", 24);
    const clear = body.indexOf("clearTimeout(debounceRef.current);");
    const guard = body.indexOf("if (draftWrittenByScanRef.current === linkDraft) {");
    const arm = body.indexOf("debounceRef.current = setTimeout(");
    expect({
      clearFound: clear >= 0,
      guardFound: guard > 0,
      armFound: arm > 0,
      guardAfterClear: guard > clear,
      guardBeforeArm: guard < arm,
    }).toEqual({
      clearFound: true,
      guardFound: true,
      armFound: true,
      guardAfterClear: true,
      guardBeforeArm: true,
    });
  });

  it("consumes the guard ABOVE its own return, so the one-shot is not permanent", () => {
    // Presence alone is vacuous, the same way it was for the scan-latch resets
    // above: move the clear below the `return;` and the string stays in the
    // region while never executing. The one-shot would then never be consumed,
    // and every later draft equal to the last scanned value would be dropped
    // silently and forever rather than once.
    const body = region(flowSrc, DEBOUNCE_START, "  }, [linkDraft, ready, runResolve]);", 30);
    const guard = body.indexOf("if (draftWrittenByScanRef.current === linkDraft) {");
    const clear = body.indexOf("draftWrittenByScanRef.current = null;");
    const ret = body.indexOf("return;", guard);
    expect({
      guardFound: guard >= 0,
      clearFound: clear > 0,
      clearInsideGuard: clear > guard,
      clearBeforeReturn: clear < ret,
    }).toEqual({
      guardFound: true,
      clearFound: true,
      clearInsideGuard: true,
      clearBeforeReturn: true,
    });
  });

  it("arms the one-shot only when the write changes the draft", () => {
    // The bug this pins: an identical value is a no-op setter, so the effect
    // never re-runs and the ref is never consumed — it then swallows the next
    // genuine resolve of that link. The arm must sit inside a comparison
    // against the committed draft.
    const body = region(flowSrc, "  const resolveFromScan = useCallback(", "  const retryResolve", 34);
    const cmp = body.indexOf("if (shown !== linkDraftRef.current) {");
    const arm = body.indexOf("draftWrittenByScanRef.current = shown;");
    const write = body.indexOf("setLinkDraftRaw(shown);");
    expect({
      compareFound: cmp > 0,
      armGuarded: arm > cmp,
      writeGuarded: write > cmp,
      armBeforeWrite: arm < write,
    }).toEqual({
      compareFound: true,
      armGuarded: true,
      writeGuarded: true,
      armBeforeWrite: true,
    });
  });
});

/**
 * Grab is gated, and the picker says one thing at a time.
 *
 * All of this is JSX, so `npm test` cannot render it. The decisions live in
 * `pickerGrabGate.ts` and `sharePreviewCopy.ts`, which ARE unit-tested; these
 * probes assert only that the component actually consults them instead of
 * re-deriving the answer inline, which is how the original dead button and the
 * duplicated status line both happened.
 */
describe("P-3 / P-4 picker gating and layout wiring", () => {
  it("takes the button's state from pickerGrabGate, not from downloadAllBusy", () => {
    expect([
      contains(previewSrc, 'from "../lib/pickerGrabGate"'),
      contains(previewSrc, "pickerGrabGate({"),
      contains(previewSrc, "lookupState: lookup.state,"),
      contains(previewSrc, "disabled={!gate.enabled}"),
      // The old gate. Leaving it would re-enable Grab with no session.
      contains(previewSrc, "disabled={downloadAllBusy}"),
    ]).toEqual([
      present('from "../lib/pickerGrabGate"'),
      present("pickerGrabGate({"),
      present("lookupState: lookup.state,"),
      present("disabled={!gate.enabled}"),
      { needle: "disabled={downloadAllBusy}", present: false },
    ]);
  });

  it("guards the press handler as well as the disabled prop", () => {
    // A disabled prop is a layout fact; the guard is the invariant. The defect
    // being removed was precisely a tappable button whose handler returned.
    const body = region(
      previewSrc,
      "  const onPressGrab = () => {",
      "\n  return (",
      12,
    );
    expect(contains(body, "if (!gate.grabAllowed) return;")).toEqual(
      present("if (!gate.grabAllowed) return;"),
    );
  });

  it("wires Look again to relookupPreview, not to retryResolve", () => {
    // retryResolve reads linkDraft, which openStoredSharePicker never writes,
    // so it returns immediately from this surface.
    expect([
      contains(previewSrc, "relookupPreview,"),
      contains(previewSrc, "void relookupPreview()"),
      contains(previewSrc, 'gate.kind === "lookAgain"'),
      contains(previewSrc, "void retryResolve()"),
    ]).toEqual([
      present("relookupPreview,"),
      present("void relookupPreview()"),
      present('gate.kind === "lookAgain"'),
      { needle: "void retryResolve()", present: false },
    ]);
  });

  it("exposes relookupPreview on the context value AND its dep array", () => {
    // This file hand-maintains both lists; omitting the dep is the standard
    // bug here, and it is invisible until the callback goes stale at runtime.
    const occurrences = flowSrc.split("      relookupPreview,").length - 1;
    expect({ occurrences }).toEqual({ occurrences: 2 });
  });

  it("fires the found haptic off lookup.state, never off the 1 Hz tick object", () => {
    // Depending on `lookup` would re-run this effect every second, and the
    // modal recomputes `lookup` from `tickNow`.
    expect([
      contains(previewSrc, "}, [previewVisible, lookup.state]);"),
      contains(previewSrc, "haptics.success()"),
      contains(previewSrc, 'prev !== "found" && lookup.state === "found"'),
    ]).toEqual([
      present("}, [previewVisible, lookup.state]);"),
      present("haptics.success()"),
      present('prev !== "found" && lookup.state === "found"'),
    ]);
  });

  it("suppresses the duplicate banner by TRIGGER, never by tone", () => {
    // Dropping the whole `wait` arm leaves still-resolving and already-held
    // with no surface, and the else arm then renders both of them red.
    expect([
      contains(previewSrc, 'linkError.trigger !== "no-manifest"'),
      contains(previewSrc, 'linkError.tone === "wait"'),
    ]).toEqual([
      present('linkError.trigger !== "no-manifest"'),
      present('linkError.tone === "wait"'),
    ]);
  });

  it("drops the inner !linkError, which made the dead tap completely silent", () => {
    expect(contains(flowSrc, "if (!linkError) {")).toEqual({
      needle: "if (!linkError) {",
      present: false,
    });
  });

  it("has the house header row and no text Close", () => {
    expect([
      contains(previewSrc, "styles.titleRow"),
      contains(previewSrc, "styles.closeCircle"),
      contains(previewSrc, 'accessibilityLabel="Close"'),
      contains(previewSrc, "styles.closeText"),
      contains(previewSrc, ">Close</Text>"),
    ]).toEqual([
      present("styles.titleRow"),
      present("styles.closeCircle"),
      present('accessibilityLabel="Close"'),
      { needle: "styles.closeText", present: false },
      { needle: ">Close</Text>", present: false },
    ]);
  });

  it("renders an Ionicon for the file type, not the emoji helper", () => {
    expect([
      contains(previewSrc, "fileIconName(f.name)"),
      contains(previewSrc, "fileIcon("),
    ]).toEqual([
      present("fileIconName(f.name)"),
      { needle: "fileIcon(", present: false },
    ]);
  });

  it("carries no emoji literal at all", () => {
    const emoji = previewSrc.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu);
    expect({ found: emoji ?? [] }).toEqual({ found: [] });
  });

  it("truncates both the title and the row names in the middle, on one line", () => {
    // `ellipsizeMode` is inert in RN without `numberOfLines`, so counting the
    // mode alone would pass with the feature gone. Pin both, and pin that the
    // two-line form that permitted the mid-word break is no longer present.
    const mode = previewSrc.split('ellipsizeMode="middle"').length - 1;
    const oneLine = previewSrc.split("numberOfLines={1}").length - 1;
    expect({ mode, oneLine }).toEqual({ mode: 2, oneLine: 2 });
    expect(contains(previewSrc, "numberOfLines={2}")).toEqual({
      needle: "numberOfLines={2}",
      present: false,
    });
  });

  it("takes the subtitle and the Grab label from sharePreviewCopy", () => {
    expect([
      contains(previewSrc, 'from "../lib/sharePreviewCopy"'),
      contains(previewSrc, "previewSubtitle(files.length, openResult?.totalBytes)"),
      contains(previewSrc, "previewPrimaryLabel({"),
      // The inline pluralisation and the unconditional label both go. Matched
      // in their CODE form — the bare string still appears in prose above,
      // explaining what the label used to be.
      contains(previewSrc, '"file" : "files"'),
      contains(previewSrc, ': "Grab everything";'),
    ]).toEqual([
      present('from "../lib/sharePreviewCopy"'),
      present("previewSubtitle(files.length, openResult?.totalBytes)"),
      present("previewPrimaryLabel({"),
      { needle: '"file" : "files"', present: false },
      { needle: ': "Grab everything";', present: false },
    ]);
  });

  it("gives the capped list a flexShrink and the sheet a bottom inset", () => {
    expect([
      contains(previewSrc, "list: { maxHeight: 360, flexShrink: 1 }"),
      contains(previewSrc, "useSafeAreaInsets"),
      contains(previewSrc, "paddingBottom: bottomInset + 16,"),
    ]).toEqual([
      present("list: { maxHeight: 360, flexShrink: 1 }"),
      present("useSafeAreaInsets"),
      present("paddingBottom: bottomInset + 16,"),
    ]);
  });

  it("puts the status row ABOVE the pick controls", () => {
    // the status row
    // is what the user is waiting on, and the controls below depend on it.
    const status = previewSrc.indexOf("styles.lookupRow");
    const topRow = previewSrc.indexOf("styles.topRow}");
    const list = previewSrc.indexOf("styles.list}");
    expect({ statusFound: status > 0, topRowFound: topRow > 0 }).toEqual({
      statusFound: true,
      topRowFound: true,
    });
    expect({
      statusBeforeTopRow: status < topRow,
      topRowBeforeList: topRow < list,
    }).toEqual({
      statusBeforeTopRow: true,
      topRowBeforeList: true,
    });
  });

  it("mounts the inline sonar only in the looking state", () => {
    expect([
      contains(previewSrc, "<PearSonarLite"),
      contains(previewSrc, 'lookup.state === "looking" ? ('),
      contains(previewSrc, "size={30}"),
    ]).toEqual([
      present("<PearSonarLite"),
      present('lookup.state === "looking" ? ('),
      present("size={30}"),
    ]);
  });

  it("feeds the hint the grab gate's own verdict, not the button's enabled flag", () => {
    // `enabled` and `grabAllowed` diverge during a busy grab, and the hint
    // ("tap any file to grab just that one") must not invite a tap the gate
    // would refuse.
    expect(contains(previewSrc, "previewHint(files.length, gate.grabAllowed)")).toEqual(
      present("previewHint(files.length, gate.grabAllowed)"),
    );
  });
});

/**
 * the dim.
 *
 * The scrim restoration was the round's headline deliverable and had no test
 * at all: `grep scrim` over the suite matched only the substring inside the
 * word "discriminator". These probes are the cheap part — that the two
 * backdrops read the token rather than a literal, and that the token is still
 * the house 0.5 on every theme, since ruling 11 froze the level.
 */
describe("the restored modal scrim", () => {
  const THEMES = path.join(__dirname, "..", "..", "ui", "themes.ts");
  const themesSrc = fs.readFileSync(THEMES, "utf8");
  const sheetSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "ui", "ReceiveSheet.tsx"),
    "utf8",
  );

  it("draws both backdrops from theme.scrim, not a literal", () => {
    expect([
      contains(sheetSrc, "backgroundColor: theme.scrim,"),
      contains(previewSrc, "backgroundColor: theme.scrim,"),
    ]).toEqual([
      present("backgroundColor: theme.scrim,"),
      present("backgroundColor: theme.scrim,"),
    ]);
  });

  it("leaves no transparent backdrop behind on either surface", () => {
    // The exact literal both files carried while the dim was removed.
    const offenders = [
      ["ReceiveSheet.tsx", sheetSrc],
      ["SharePreviewModal.tsx", previewSrc],
    ].filter(([, src]) => String(src).includes('backgroundColor: "transparent"'));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it("keeps the scrim at the house 0.5 on all 11 themes", () => {
    const levels = themesSrc.match(/scrim: "rgba\(0,0,0,([0-9.]+)\)"/g) ?? [];
    expect({ count: levels.length, distinct: [...new Set(levels)] }).toEqual({
      count: 11,
      distinct: ['scrim: "rgba(0,0,0,0.5)"'],
    });
  });
});
