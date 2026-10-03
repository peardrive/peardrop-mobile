import fs from "fs";
import path from "path";

/**
 * wiring — the half of the feature `npm test` can actually reach.
 *
 * `toastOutletSelect.test.ts` proves the RULE. Nothing proves the WIRING,
 * because this suite renders no `.tsx`: `roots` is `src` only and the
 * transform does not handle components. So these are source probes, in the
 * same style as `receiveSheetWiring.test.ts` — they assert the structural
 * facts T1 depends on, each of which is silently breakable by an edit that
 * leaves the feature looking present.
 *
 * What they cannot see, and what the device checks are therefore for: whether
 * a toast actually paints and animates inside a dialog window.
 */
const UI = path.join(__dirname, "..", "..", "ui");
const TOAST = path.join(UI, "Toast.tsx");
const APP_INDEX = path.join(__dirname, "..", "..", "..", "app", "index.tsx");

const toastSrc = fs.readFileSync(TOAST, "utf8");
const appSrc = fs.readFileSync(APP_INDEX, "utf8");

/**
 * Files with no live importer, so a `<Modal>` in them ships nothing.
 *
 * Each is named with its reason because this is the ONLY hand-maintained list
 * left here — and a hand-maintained list is exactly what let the `MainScreen`
 * media takeover ship with no outlet through the first round of this work.
 * The set of files that must carry an outlet is derived from the tree below,
 * so adding a `Modal` anywhere fails this suite until it is wired or
 * justified here.
 */
const NO_LIVE_IMPORTER: Record<string, string> = {
  "src/ui/QrScanModal.tsx": "superseded by the camera embedded in ReceiveSheet",
  "src/ui/GrabIntoFolderSheet.tsx": "dead; Appendix D candidate",
  "src/ui/MediaTakeover.tsx": "dead; superseded by MainScreen's own takeover",
  "src/screens/ReceiveScreen.tsx": "dead (FIX-2026-09 Phase 2h)",
  "src/screens/HomeScreen.tsx": "dead; superseded by MainScreen",
};

const SRC = path.join(__dirname, "..", "..");

/** Every `.tsx` under src/ that renders a `<Modal`, relative to the repo. */
function filesRenderingAModal(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__") continue;
        walk(abs);
      } else if (e.name.endsWith(".tsx")) {
        if (fs.readFileSync(abs, "utf8").includes("<Modal")) {
          out.push(`src/${path.relative(SRC, abs).split(path.sep).join("/")}`);
        }
      }
    }
  };
  walk(SRC);
  return out.sort();
}

/** The ones that actually ship, and therefore must carry an outlet. */
const MUST_CARRY_OUTLET = filesRenderingAModal().filter(
  (f) => !(f in NO_LIVE_IMPORTER),
);

describe("T1 — every shipped Modal carries its own toast outlet", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(SRC, "..", rel), "utf8");

  it("covers the ten the ruling named, plus MainScreen's own takeover", () => {
    // Derived, not hand-written. The ruling enumerated ten files in src/ui/;
    // MainScreen renders an eleventh `Modal` — `transparent={false}` and full
    // screen, the same worst case as FilePickerSheet — which the enumeration
    // missed because it was drawn from src/ui/ alone.
    expect(MUST_CARRY_OUTLET).toEqual([
      "src/screens/MainScreen.tsx",
      "src/ui/BottomSheet.tsx",
      "src/ui/ConfirmModal.tsx",
      "src/ui/FilePickerSheet.tsx",
      "src/ui/FolderAccessModal.tsx",
      "src/ui/FolderContentsModal.tsx",
      "src/ui/NameShareModal.tsx",
      "src/ui/ReceiveSheet.tsx",
      "src/ui/SendSheet.tsx",
      "src/ui/SharePreviewModal.tsx",
      "src/ui/ShareQrModal.tsx",
    ]);
  });

  it("mounts an outlet as the LAST child of every one of them", () => {
    // Position is the mechanism, not decoration: RN draws siblings without
    // zIndex in declaration order, so an outlet that is not last can be
    // painted under the sheet's own content.
    const wrong = MUST_CARRY_OUTLET.filter((rel) => {
      const lines = read(rel).split("\n");
      const close = lines.findIndex((l) => l.trim() === "</Modal>");
      if (close < 1) return true;
      return !/^\{\w+ && <ToastOutlet \/>\}$|^\{!!\w+ && <ToastOutlet \/>\}$/.test(
        lines[close - 1]?.trim() ?? "",
      );
    });
    expect(wrong).toEqual([]);
  });

  it("gates each outlet on its host's visibility, for iOS", () => {
    // RN's Modal keeps children mounted after hiding on iOS (Modal.js
    // :277-284 — `isRendered` is reset only at unmount). An ungated outlet in
    // a hidden sheet stays registered, and being later than the root it wins
    // forever: zero toasts after closing any sheet. Android unmounts children,
    // so the gate is a no-op there and a fix only for iOS.
    const ungated = MUST_CARRY_OUTLET.filter((rel) =>
      read(rel).includes("\n      <ToastOutlet />\n"),
    );
    expect(ungated).toEqual([]);
  });

  it("imports the outlet in each one", () => {
    const missing = MUST_CARRY_OUTLET.filter(
      (rel) => !/import \{ ToastOutlet(, useToast)? \} from "\.[./]*\/?[uU]i?\/?Toast";|import \{ ToastOutlet \} from "\.\/Toast";/.test(read(rel)),
    );
    expect(missing).toEqual([]);
  });

  it("mounts exactly one outlet per modal — a second would race the first", () => {
    const counts = MUST_CARRY_OUTLET.map((rel) => ({
      rel,
      mounts: read(rel).split("<ToastOutlet />").length - 1,
    })).filter((r) => r.mounts !== 1);
    expect(counts).toEqual([]);
  });

  it("names a reason for every file it excuses", () => {
    // A dead-list entry with no reason is how a live modal gets excused by
    // accident. Also checks the excused files still exist.
    const bad = Object.entries(NO_LIVE_IMPORTER).filter(
      ([rel, why]) =>
        !why ||
        why.length < 10 ||
        !fs.existsSync(path.join(SRC, "..", rel)),
    );
    expect(bad).toEqual([]);
  });
});

describe("T1 — the root outlet", () => {
  it("is mounted inside the provider, after the navigator", () => {
    const outlet = appSrc.indexOf("<ToastOutlet />");
    const tabs = appSrc.indexOf("<Tabs />");
    const closeProvider = appSrc.indexOf("</ShareLinkFlowProvider>");
    expect({
      mounted: outlet > 0,
      afterTabs: outlet > tabs,
      insideFlowProvider: outlet < closeProvider,
    }).toEqual({ mounted: true, afterTabs: true, insideFlowProvider: true });
  });

  it("is the last child of the flow provider, so nothing draws over it", () => {
    const tail = appSrc.slice(
      appSrc.indexOf("<ToastOutlet />") + "<ToastOutlet />".length,
      appSrc.indexOf("</ShareLinkFlowProvider>"),
    );
    // Only whitespace may follow it.
    expect({ tail: tail.trim() }).toEqual({ tail: "" });
  });

  it("mounts exactly once at the root", () => {
    expect(appSrc.split("<ToastOutlet />").length - 1).toBe(1);
  });
});

describe("T1 — the provider / outlet split", () => {
  it("moves both Animated.Values out of the provider and into the outlet", () => {
    // The stated risk this split exists to avoid: one native-driver value
    // attached to views in two native windows. If the provider still created
    // them, every outlet would share one pair and the split would be cosmetic.
    const providerStart = toastSrc.indexOf("export function ToastProvider");
    const outletStart = toastSrc.indexOf("export function ToastOutlet");
    expect({ providerFound: providerStart > 0, outletFound: outletStart > 0 }).toEqual({
      providerFound: true,
      outletFound: true,
    });
    const provider = toastSrc.slice(providerStart, outletStart);
    const outlet = toastSrc.slice(outletStart);
    expect({
      providerAnimatedValues: provider.split("new Animated.Value").length - 1,
      outletAnimatedValues: outlet.split("new Animated.Value").length - 1,
    }).toEqual({ providerAnimatedValues: 0, outletAnimatedValues: 2 });
  });

  it("leaves the provider with no toast markup of its own", () => {
    const providerStart = toastSrc.indexOf("export function ToastProvider");
    const outletStart = toastSrc.indexOf("export function ToastOutlet");
    const provider = toastSrc.slice(providerStart, outletStart);
    // A leftover copy in the provider would render a second toast in the
    // activity window, under every sheet — the defect T1 removes.
    expect({
      animatedView: provider.includes("<Animated.View"),
      dismissButton: provider.includes("Dismiss notification"),
    }).toEqual({ animatedView: false, dismissButton: false });
  });

  it("registers each outlet once per mount, with a stable id", () => {
    // The ordering trap documented in toastOutletSelect.test.ts: re-registering
    // moves an outlet to the END of the list, so an effect that re-ran on a
    // theme change would let the ROOT outlet steal the toast from an open
    // sheet. The dep array must therefore be [id] and nothing else.
    //
    // Scoped to the registration effect's OWN closing line, not "does `}, [id]);`
    // appear anywhere below". The looser form passed if the effect gained a
    // second dep and some later effect happened to close with `[id]`.
    const outlet = toastSrc.slice(toastSrc.indexOf("export function ToastOutlet"));
    const reg = outlet.indexOf("    register(id);");
    const effect = outlet.slice(reg, outlet.indexOf("});", reg) + 3);
    expect({
      registers: reg > 0,
      unregistersOnUnmount: effect.includes("return () => unregister(id);"),
      // The whole effect body, from the register call to its own close.
      closesWithIdOnly: /\}, \[id\]\);\s*$/.test(
        outlet.slice(reg, outlet.indexOf("}, [id]);", reg) + "}, [id]);".length),
      ),
      noOtherDeps: !/\}, \[id, /.test(effect),
      idFromRef: outlet.includes("idRef.current === null"),
    }).toEqual({
      registers: true,
      unregistersOnUnmount: true,
      closesWithIdOnly: true,
      noOtherDeps: true,
      idFromRef: true,
    });
  });

  it("keeps the public ToastApi at exactly show + dismiss", () => {
    // Ruling 3: no call site may need to change. Widening ToastApi is the one
    // edit that would break them all at once, and tsc catches it only if a
    // call site happens to conflict.
    //
    // Counts every member line rather than matching `^  word:`, which missed
    // `readonly extra: ...` and any multi-word modifier — a member could be
    // added with the old regex green.
    const api = toastSrc.slice(
      toastSrc.indexOf("type ToastApi = {"),
      toastSrc.indexOf("const ToastContext"),
    );
    const body = api.slice(api.indexOf("{") + 1, api.lastIndexOf("}"));
    const members = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
      // A member declaration is whatever precedes the first colon.
      .map((l) => l.split(":")[0]?.trim());
    expect(members).toEqual(["show", "dismiss"]);
  });

  it("draws only when it is the elected outlet", () => {
    const outlet = toastSrc.slice(toastSrc.indexOf("export function ToastOutlet"));
    expect({
      usesRule: outlet.includes("isActiveToastOutlet(registered, id)"),
      bailsWhenNotActive: outlet.includes("if (!active || !rendered) return null;"),
    }).toEqual({ usesRule: true, bailsWhenNotActive: true });
  });

  it("guards the exit animation's completion callback", () => {
    // A `show` landing mid-fade sets visible true again and re-runs the
    // effect; an unguarded completion would then unmount the toast that was
    // just raised.
    const outlet = toastSrc.slice(toastSrc.indexOf("export function ToastOutlet"));
    expect(outlet.includes("if (finished) setRendered(false);")).toBe(true);
  });
});
