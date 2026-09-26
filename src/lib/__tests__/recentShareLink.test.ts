import fs from "fs";
import path from "path";
import {
  canOfferRecentShareLink,
  recentShareAction,
  selectRecentShareRows,
  RECENT_SHARES_LIMIT,
  type RecentShareRow,
} from "../recentShareLink";

/**
 * `expect(rows[0]?.shareLink).toBeUndefined()` passes against an empty array,
 * which is exactly the regression these tests exist to catch. So every
 * assertion about a row goes through `at()`, which throws on a missing index,
 * and every case asserts `rows.length` explicitly.
 */
function at<T>(rows: readonly T[], i: number): T {
  const v = rows[i];
  if (v === undefined) {
    throw new Error(
      `expected a row at index ${i}, got a list of length ${rows.length}`,
    );
  }
  return v;
}

/** A `Set` of drive ids — used for both `activeDriveIds` and `failedHydrationIds`. */
function ids(...list: string[]): Set<string> {
  return new Set(list);
}

/** No drive has failed hydration. The ordinary case. */
const NO_FAILURES = ids();

const hosted = (id: string, link = `peardrop://${id}`): RecentShareRow => ({
  id,
  origin: "hosted",
  shareLink: link,
});

describe("canOfferRecentShareLink", () => {
  it("offers the link for a hosted share that IS announcing (the control)", () => {
    expect(canOfferRecentShareLink(hosted("d1"), ids("d1"), NO_FAILURES)).toBe(
      true,
    );
  });

  it("withholds the link for a hosted share that is NOT announcing (D-05)", () => {
    // The engine reports an INACTIVE drive WITH its link string; that is the
    // whole defect. The link is present and must still be withheld.
    const row = hosted("d1");
    expect(row.shareLink).toBe("peardrop://d1");
    expect(canOfferRecentShareLink(row, ids("other"), NO_FAILURES)).toBe(false);
  });

  it("withholds the link for a received share even while announcing", () => {
    const row: RecentShareRow = {
      id: "share:abc",
      origin: "received",
      shareLink: "peardrop://abc",
    };
    expect(canOfferRecentShareLink(row, ids("share:abc"), NO_FAILURES)).toBe(
      false,
    );
  });

  it("withholds the link when there is no link, announcing or not", () => {
    expect(
      canOfferRecentShareLink({ id: "d1", origin: "hosted" }, ids("d1"), NO_FAILURES),
    ).toBe(false);
    expect(
      canOfferRecentShareLink(
        { id: "d1", origin: "hosted", shareLink: "" },
        ids("d1"),
        NO_FAILURES,
      ),
    ).toBe(false);
    expect(
      canOfferRecentShareLink(
        { id: "d1", origin: "hosted", shareLink: null },
        ids("d1"),
        NO_FAILURES,
      ),
    ).toBe(false);
  });

  it("fails closed on a missing active set rather than assuming announcing", () => {
    expect(canOfferRecentShareLink(hosted("d1"), null, NO_FAILURES)).toBe(false);
    expect(canOfferRecentShareLink(hosted("d1"), undefined, NO_FAILURES)).toBe(
      false,
    );
  });

  it("rejects a missing or empty row id", () => {
    expect(canOfferRecentShareLink(null, ids("d1"), NO_FAILURES)).toBe(false);
    expect(canOfferRecentShareLink(undefined, ids("d1"), NO_FAILURES)).toBe(false);
    expect(
      canOfferRecentShareLink(
        { id: "", origin: "hosted", shareLink: "peardrop://x" },
        ids(""),
        NO_FAILURES,
      ),
    ).toBe(false);
  });
});

/**
 * Failed hydration leaves a manifest entry ACTIVE, so `engineListDrives`
 * reports `state: "active"` and the drive lands in `activeDriveIds`. The
 * `drive-hydration-failed` handler adds it to `failedHydrationIds` and never
 * removes it from `activeDriveIds`, so the two sets overlap and `failed` has
 * to win: there is no swarm attached, the drive is not announcing, and the
 * link would point at nothing.
 */
describe("canOfferRecentShareLink — failed hydration (F2)", () => {
  it("withholds the link when the drive is in BOTH sets", () => {
    // Precondition of the defect, asserted rather than assumed: the drive
    // really is reported as announcing.
    const active = ids("d1");
    const failed = ids("d1");
    expect(active.has("d1")).toBe(true);
    expect(canOfferRecentShareLink(hosted("d1"), active, failed)).toBe(false);
  });

  it("leaves a healthy announcing share alone when a DIFFERENT drive failed", () => {
    const active = ids("healthy", "broken");
    const failed = ids("broken");
    expect(canOfferRecentShareLink(hosted("healthy"), active, failed)).toBe(true);
    expect(canOfferRecentShareLink(hosted("broken"), active, failed)).toBe(false);
  });

  it("treats an absent failure set as 'no failure known', not as fail-closed", () => {
    // Asymmetric with `activeDriveIds` on purpose: an absent failure set and an
    // empty one carry identical information. Documented in the module header.
    expect(canOfferRecentShareLink(hosted("d1"), ids("d1"), null)).toBe(true);
    expect(canOfferRecentShareLink(hosted("d1"), ids("d1"), undefined)).toBe(true);
  });
});

/**
 * Withholding the link by dropping the row makes the whole Recent Shares
 * section vanish once every share is stopped. The rule instead: keep showing
 * the rows, show Link only on shares that are announcing, and show Share
 * again on stopped ones, which starts sharing first and then offers the link.
 *
 * So the announcing test picks the action rather than the row.
 * `"share-again"` is the safe default in every doubtful case, because
 * activating an already-announcing drive is harmless while handing out a dead
 * link is the defect.
 */
describe("recentShareAction (Phase 2b)", () => {
  it("shows Link on a hosted share that IS announcing", () => {
    expect(recentShareAction(hosted("d1"), ids("d1"), NO_FAILURES)).toBe("link");
  });

  it("shows Share again on a stopped share instead of hiding it (D-05)", () => {
    // Pre-Phase-2b there was no third state: the row was dropped. The link is
    // present on the row and must still not be offered.
    const row = hosted("d1");
    expect(row.shareLink).toBe("peardrop://d1");
    expect(recentShareAction(row, ids("other"), NO_FAILURES)).toBe("share-again");
  });

  it("shows Share again when hydration FAILED, never Link (F2 preserved)", () => {
    const active = ids("d1");
    const failed = ids("d1");
    expect(active.has("d1")).toBe(true);
    expect(recentShareAction(hosted("d1"), active, failed)).toBe("share-again");
  });

  it("shows Share again when the active set is missing (fails to the safe action)", () => {
    expect(recentShareAction(hosted("d1"), null, NO_FAILURES)).toBe("share-again");
    expect(recentShareAction(hosted("d1"), undefined, NO_FAILURES)).toBe(
      "share-again",
    );
  });

  it("is exactly the inverse of canOfferRecentShareLink, every combination", () => {
    // The two must not be able to drift: one guards the pill, the other the
    // link string behind it.
    const cases: [Set<string>, Set<string>][] = [
      [ids("d1"), ids()],
      [ids("d1"), ids("d1")],
      [ids(), ids()],
      [ids("other"), ids("other")],
    ];
    expect(cases).toHaveLength(4);
    for (const [active, failed] of cases) {
      const row = hosted("d1");
      const expected = canOfferRecentShareLink(row, active, failed)
        ? "link"
        : "share-again";
      expect(recentShareAction(row, active, failed)).toBe(expected);
    }
  });
});

describe("selectRecentShareRows", () => {
  /**
   * A `selectRecentShareRows` that filtered on `canOfferRecentShareLink`
   * would return `[]` here and the section would disappear.
   */
  it("KEEPS a stopped hosted share's row (Phase 2b: no vanishing section)", () => {
    const rows = selectRecentShareRows([hosted("stopped")], RECENT_SHARES_LIMIT);
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).id).toBe("stopped");
    // The row survives; it is the ACTION that changes.
    expect(recentShareAction(at(rows, 0), ids(), NO_FAILURES)).toBe("share-again");
  });

  it("keeps a failed-hydration row too, with Share again on it (F2)", () => {
    const rows = selectRecentShareRows([hosted("broken")]);
    expect(rows).toHaveLength(1);
    expect(recentShareAction(at(rows, 0), ids("broken"), ids("broken"))).toBe(
      "share-again",
    );
  });

  it("keeps stopped and announcing rows together, order preserved", () => {
    const rows = selectRecentShareRows([hosted("stopped"), hosted("live")]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["stopped", "live"]);
    const active = ids("live");
    expect(recentShareAction(at(rows, 0), active, NO_FAILURES)).toBe("share-again");
    expect(recentShareAction(at(rows, 1), active, NO_FAILURES)).toBe("link");
  });

  it("still drops received rows — they are not ours to re-share (out of scope)", () => {
    // `src/lib/shareActions.ts:91-92` gates received rows out of activation on
    // purpose, so a "Share again" pill on one would be a dead button.
    const received: RecentShareRow = {
      id: "share:abc",
      origin: "received",
      shareLink: "peardrop://abc",
    };
    const rows = selectRecentShareRows([received, hosted("mine")]);
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).id).toBe("mine");
  });

  it("still drops rows with no link at all", () => {
    const rows = selectRecentShareRows([
      { id: "nolink", origin: "hosted" },
      { id: "empty", origin: "hosted", shareLink: "" },
      { id: "nulled", origin: "hosted", shareLink: null },
      hosted("ok"),
    ]);
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).id).toBe("ok");
  });

  it("still drops a row with a missing or empty id", () => {
    const rows = selectRecentShareRows([
      { id: "", origin: "hosted", shareLink: "peardrop://x" },
      hosted("ok"),
    ]);
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).id).toBe("ok");
  });

  it("caps at RECENT_SHARES_LIMIT and preserves input order", () => {
    const list = ["a", "b", "c", "d", "e", "f", "g"];
    const rows = selectRecentShareRows(list.map((id) => hosted(id)));
    expect(RECENT_SHARES_LIMIT).toBe(5);
    expect(rows).toHaveLength(RECENT_SHARES_LIMIT);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("lets stopped shares occupy slots, which Phase 2a deliberately denied", () => {
    // `engineDeactivateDrive` bumps `lastActivityAt` and the list sorts
    // descending on it, so freshly stopped shares sit at the top. They are
    // shown rather than filtered out, so they do occupy slots and the action
    // varies per row.
    const input: RecentShareRow[] = [
      hosted("stopped1"),
      hosted("stopped2"),
      hosted("stopped3"),
      hosted("stopped4"),
      hosted("stopped5"),
      hosted("live1"),
    ];
    const rows = selectRecentShareRows(input);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.id)).toEqual([
      "stopped1",
      "stopped2",
      "stopped3",
      "stopped4",
      "stopped5",
    ]);
    expect(rows.every((r) => recentShareAction(r, ids("live1"), NO_FAILURES) === "share-again")).toBe(true);
  });

  /**
   * Filter-then-cap, not cap-then-filter: received and link-less rows must not
   * consume slots. Rewriting the selection to
   * `rows.slice(0, limit).filter(...)` leaves the rest of the suite green, so
   * this is the only guard on it. Stopped shares are a different case — they
   * are meant to occupy slots — and this covers only the classes
   * `isRecentShareRow` rejects.
   *
   * Every case must have more than `limit` rows of the rejected class ahead of
   * the good ones; with fewer, the two orders agree and the test passes
   * vacuously. The input lengths are asserted for that reason.
   */
  it("filters BEFORE capping — dropped rows must not consume slots (F-R2)", () => {
    // The cap is what makes the two orders differ at all; pin it.
    expect(RECENT_SHARES_LIMIT).toBe(5);

    // Class 1: received rows. Defence in depth — `MainScreen.tsx` already
    // drops received rows before `sortedDrives` reaches here, but the module
    // rejects them independently.
    const receivedAhead: RecentShareRow[] = [
      { id: "share:a", origin: "received", shareLink: "peardrop://a" },
      { id: "share:b", origin: "received", shareLink: "peardrop://b" },
      { id: "share:c", origin: "received", shareLink: "peardrop://c" },
      { id: "share:d", origin: "received", shareLink: "peardrop://d" },
      { id: "share:e", origin: "received", shareLink: "peardrop://e" },
      hosted("mine"),
    ];
    // Cap-then-filter slices exactly the five received rows and returns [].
    expect(receivedAhead.length).toBeGreaterThan(RECENT_SHARES_LIMIT);
    const r1 = selectRecentShareRows(receivedAhead, RECENT_SHARES_LIMIT);
    expect(r1).toHaveLength(1);
    expect(at(r1, 0).id).toBe("mine");

    // Class 2: link-less hosted rows, the class reachable from the shipped
    // call site. A hosted drive that never announced has no shareLink, and
    // `lastActivityAt`-descending puts freshly created ones at the top.
    const linklessAhead: RecentShareRow[] = [
      { id: "new1", origin: "hosted" },
      { id: "new2", origin: "hosted", shareLink: "" },
      { id: "new3", origin: "hosted", shareLink: null },
      { id: "new4", origin: "hosted" },
      { id: "new5", origin: "hosted", shareLink: "" },
      hosted("ok1"),
      hosted("ok2"),
    ];
    expect(linklessAhead.length).toBeGreaterThan(RECENT_SHARES_LIMIT);
    const r2 = selectRecentShareRows(linklessAhead, RECENT_SHARES_LIMIT);
    expect(r2.map((r) => r.id)).toEqual(["ok1", "ok2"]);

    // Both classes mixed, still ahead of the good rows.
    const mixed: RecentShareRow[] = [
      { id: "share:x", origin: "received", shareLink: "peardrop://x" },
      { id: "nolink", origin: "hosted" },
      { id: "", origin: "hosted", shareLink: "peardrop://noid" },
      { id: "share:y", origin: "received", shareLink: "peardrop://y" },
      { id: "empty", origin: "hosted", shareLink: "" },
      { id: "share:z", origin: "received", shareLink: "peardrop://z" },
      hosted("good"),
    ];
    expect(mixed.length).toBeGreaterThan(RECENT_SHARES_LIMIT);
    const r3 = selectRecentShareRows(mixed, RECENT_SHARES_LIMIT);
    expect(r3.map((r) => r.id)).toEqual(["good"]);

    // Control: the cap still binds on the SURVIVORS, so this test cannot be
    // satisfied by deleting the `.slice` instead of ordering it correctly.
    const allGood = ["a", "b", "c", "d", "e", "f", "g"].map((id) => hosted(id));
    const r4 = selectRecentShareRows(allGood, RECENT_SHARES_LIMIT);
    expect(r4.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("tolerates a missing input list", () => {
    expect(selectRecentShareRows(null)).toEqual([]);
    expect(selectRecentShareRows(undefined)).toEqual([]);
    expect(selectRecentShareRows([])).toEqual([]);
  });
});

/**
 * The dependency-array trap. No `.tsx` file is rendered anywhere in this
 * project's suite, so the memo cannot be exercised; this reads the source text
 * instead — weaker than a render, and the strongest check available here.
 *
 * The window must be bounded. A search that slices from the memo to end of
 * file and takes the first `}, [...]);` it finds slides forward onto
 * `visibleDrives`'s deps array, which legitimately contains `activeDriveIds`,
 * so deleting the `recentShares` deps array outright leaves the suite green.
 * The region is hard-bounded to the memo's own body — from its declaration to
 * the next top-level `const` in the component — and the bound is asserted, not
 * assumed. A missing deps array then finds nothing in the region and throws.
 */
describe("MainScreen recentShares memo wiring", () => {
  const MAIN_SCREEN = path.join(__dirname, "..", "..", "screens", "MainScreen.tsx");
  const src = fs.readFileSync(MAIN_SCREEN, "utf8");

  /**
   * The `recentShares` memo's own source text, and nothing else.
   *
   * Throws rather than returning a wider slice on any surprise. Failing
   * closed is the whole point: a silently-widened window is the defect.
   */
  function recentSharesMemoSource(): string {
    const start = src.indexOf("  const recentShares = useMemo");
    if (start < 0) {
      throw new Error("could not find the recentShares memo declaration");
    }
    // The next statement at component-body indentation ends the region.
    const end = src.indexOf("\n  const ", start + 1);
    if (end < 0) {
      throw new Error("could not find the end of the recentShares memo");
    }
    const region = src.slice(start, end);
    // The bound is asserted, not trusted. A region that has swallowed the next
    // memo is a broken bound, not a passing test.
    if (region.split("\n").length > 60) {
      throw new Error(
        `recentShares region is ${region.split("\n").length} lines — bound is broken`,
      );
    }
    if (!region.includes("selectRecentShareRows")) {
      throw new Error("bounded the wrong region: no selectRecentShareRows call");
    }
    if (region.includes("visibleDrives")) {
      // The decoy a widened window lands on.
      throw new Error("region leaked into visibleDrives — bound is broken");
    }
    return region;
  }

  it("bounds the search window to the memo itself (F1 guard)", () => {
    const region = recentSharesMemoSource();
    expect(region).toContain("const recentShares = useMemo");
    expect(region).not.toContain("visibleDrives");
    // `visibleDrives`'s deps array is the decoy: prove it exists in the file
    // and is not what the region matches.
    expect(src).toContain("sort, activeDriveIds, transferByDriveId");
    expect(region).not.toContain("transferByDriveId");
  });

  it("routes the Recent Shares selection through the tested predicate", () => {
    const region = recentSharesMemoSource();
    expect(region).toContain("selectRecentShareRows(");
    expect(region).toContain("sortedDrives");
  });

  it("tags every row with recentShareAction, not with an inline condition (2b)", () => {
    const region = recentSharesMemoSource();
    expect(region).toContain("recentShareAction(");
    expect(region).toContain("activeDriveIds");
    expect(region).toContain("failedHydrationIds");
    // The import has to exist or the identifier above is not the function.
    expect(src).toContain("recentShareAction,\n  RECENT_SHARES_LIMIT,");
  });

  it("passes RECENT_SHARES_LIMIT, not a literal cap (F4)", () => {
    const region = recentSharesMemoSource();
    expect(region).toContain("RECENT_SHARES_LIMIT");
    // The import has to exist too, or the identifier above is not the constant.
    expect(src).toContain("RECENT_SHARES_LIMIT,\n} from \"../lib/recentShareLink\"");
  });

  it("lists BOTH activeDriveIds and failedHydrationIds in the deps array", () => {
    const region = recentSharesMemoSource();
    const deps = /\}, \[([^\]]*)\]\);/.exec(region);
    if (!deps || deps[1] === undefined) {
      throw new Error(
        "no dependency array inside the recentShares memo — it was deleted or moved",
      );
    }
    const listed = deps[1].split(",").map((s) => s.trim()).filter(Boolean);
    expect(listed).toContain("sortedDrives");
    expect(listed).toContain("activeDriveIds");
    expect(listed).toContain("failedHydrationIds");
  });
});

/**
 * The Send sheet must render the two states. `src/ui/SendSheet.tsx` is a
 * `.tsx` and cannot be imported by this suite either, so this is a
 * source-text check with the same self-asserting bound discipline as the memo
 * block above: the window proves its own limits and throws rather than
 * sliding onto neighbouring JSX.
 */
describe("SendSheet Recent Shares row wiring (Phase 2b)", () => {
  const SEND_SHEET = path.join(__dirname, "..", "..", "ui", "SendSheet.tsx");
  const src = fs.readFileSync(SEND_SHEET, "utf8");

  /** The `recentShares.map(...)` JSX, and nothing else. */
  function recentRowSource(): string {
    const start = src.indexOf("{recentShares.map(");
    if (start < 0) {
      throw new Error("could not find the recentShares.map JSX");
    }
    const end = src.indexOf("</ScrollView>", start);
    if (end < 0) {
      throw new Error("could not find the end of the Recent Shares list");
    }
    const region = src.slice(start, end);
    const lines = region.split("\n").length;
    if (lines > 70) {
      throw new Error(`recent-row region is ${lines} lines — bound is broken`);
    }
    if (!region.includes("styles.recentRow")) {
      throw new Error("bounded the wrong region: no recentRow style");
    }
    // Decoys on either side: `sectionLabel` sits above the ScrollView and
    // `createStyles`/`SendCard` below the component, so either appearing
    // means the window has slid off the row JSX.
    if (region.includes("styles.sectionLabel")) {
      throw new Error("region leaked backwards past the section label");
    }
    if (region.includes("createStyles") || region.includes("<SendCard")) {
      throw new Error("region leaked forwards out of the list");
    }
    return region;
  }

  it("bounds the search window to the row JSX (bound guard)", () => {
    const region = recentRowSource();
    expect(region).toContain("{recentShares.map(");
    expect(region).not.toContain("styles.sectionLabel");
    // Prove the decoys really are in the file, so the guards above mean
    // something rather than passing vacuously.
    expect(src).toContain("styles.sectionLabel");
    expect(src).toContain("function createStyles(");
  });

  it("offers Link only on the announcing branch", () => {
    const region = recentRowSource();
    expect(region).toContain('r.action === "link"');
    expect(region).toContain("onCopyRecentLink(");
    expect(region).toContain(">Link<");
  });

  it("offers Share again on the other branch, wired to onShareAgain", () => {
    const region = recentRowSource();
    expect(region).toContain("Share again");
    expect(region).toContain("onShareAgain(r.id)");
  });

  it("declares action and onShareAgain in its public types", () => {
    expect(src).toContain("action: RecentShareAction");
    expect(src).toContain("onShareAgain: (id: string) => void");
    expect(src).toContain('from "../lib/recentShareLink"');
  });

  it("no longer keys the pill off shareLink alone (the 2a/pre-2a shape)", () => {
    const region = recentRowSource();
    // `{r.shareLink ? (` was the whole condition before 2b. If it comes back,
    // a stopped share gets a Link pill again.
    expect(region).not.toContain("{r.shareLink ? (");
  });
});

/**
 * The MainScreen side of "Share again": it routes into the one existing
 * hosted activation path (`onShareIt`) rather than a second hand-rolled one,
 * and is unreachable for a received row.
 */
describe("MainScreen Share again wiring (Phase 2b)", () => {
  const MAIN_SCREEN = path.join(__dirname, "..", "..", "screens", "MainScreen.tsx");
  const src = fs.readFileSync(MAIN_SCREEN, "utf8");

  /** The `<SendSheet ... />` element, and nothing else. */
  function sendSheetElementSource(): string {
    const start = src.indexOf("      <SendSheet");
    if (start < 0) throw new Error("could not find the <SendSheet element");
    const end = src.indexOf("\n      />", start);
    if (end < 0) throw new Error("could not find the end of the <SendSheet element");
    const region = src.slice(start, end);
    const lines = region.split("\n").length;
    if (lines > 40) {
      throw new Error(`SendSheet element region is ${lines} lines — bound is broken`);
    }
    if (!region.includes("recentShares={recentShares}")) {
      throw new Error("bounded the wrong region: no recentShares prop");
    }
    if (region.includes("<FilePickerSheet")) {
      throw new Error("region leaked into FilePickerSheet — bound is broken");
    }
    return region;
  }

  it("bounds the search window to the SendSheet element (bound guard)", () => {
    const region = sendSheetElementSource();
    expect(region).toContain("<SendSheet");
    expect(region).not.toContain("<FilePickerSheet");
    expect(src).toContain("<FilePickerSheet");
  });

  it("passes onShareAgain and routes it through onShareIt", () => {
    const region = sendSheetElementSource();
    expect(region).toContain("onShareAgain=");
    expect(region).toContain("onShareAgainFromRecents(");
  });

  /**
   * The handler's own source text, bounded and self-asserting. It is a plain
   * function declaration, so the start marker is
   * `function onShareAgainFromRecents(` and the region ends at the next
   * component-body `const`.
   */
  function shareAgainHandlerSource(): string {
    const start = src.indexOf("  function onShareAgainFromRecents(");
    if (start < 0) {
      throw new Error("could not find the onShareAgainFromRecents handler");
    }
    const end = src.indexOf("\n  const ", start + 1);
    if (end < 0) throw new Error("could not find the end of the handler");
    const region = src.slice(start, end);
    const lines = region.split("\n").length;
    if (lines > 45) {
      throw new Error(`handler region is ${lines} lines — bound is broken`);
    }
    if (!region.includes("onShareAgainFromRecents")) {
      throw new Error("bounded the wrong region: handler name absent");
    }
    // `onStopSharing` is the next declaration; if its body is in the window the
    // bound has slid forward.
    if (region.includes("deactivateDrive")) {
      throw new Error("region leaked into onStopSharing — bound is broken");
    }
    return region;
  }

  it("bounds the handler window and asserts its own limits", () => {
    const region = shareAgainHandlerSource();
    expect(region).toContain("function onShareAgainFromRecents(");
    expect(region).not.toContain("deactivateDrive");
    // Prove the forward decoy exists, so the guard is not vacuous.
    expect(src).toContain("const res = await deactivateDrive(drive.id);");
  });

  it("gates the handler with canOfferStartSharing so received rows cannot reach it", () => {
    const region = shareAgainHandlerSource();
    expect(region).toContain("canOfferStartSharing(");
    expect(region).toContain('origin === "received"');
  });

  it("starts sharing through onShareIt — no second activation route", () => {
    const region = shareAgainHandlerSource();
    expect(region).toContain("void onShareIt(drive)");
    // The one thing that must NOT appear: a hand-rolled activation.
    expect(region).not.toContain("activateDrive(");
  });

  it("dismisses the Send sheet before opening the QR/link modal", () => {
    const region = shareAgainHandlerSource();
    expect(region).toContain("setPickerSheet(null)");
  });
});
