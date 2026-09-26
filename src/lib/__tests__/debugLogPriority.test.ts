/**
 * The log must not destroy its own prologue, and must not write one line per
 * tick. This is not a mirror test: every assertion runs against the real
 * `src/lib/debugLog.ts`, and only the platform boundary is replaced —
 * `react-native` (AppState), `react-native-fs` (an in-memory filesystem),
 * `expo-sharing`, `devGate`'s native constants and the AsyncStorage-backed
 * flag. The rotation arithmetic, the priority classification and the change
 * gate are the shipping code's own; if they regress, these fail.
 */

jest.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  NativeModules: {},
  Platform: { OS: "android", constants: {} },
}));

jest.mock("expo-sharing", () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));

jest.mock("react-native-fs", () => {
  const files: Record<string, string> = {};
  const has = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  /**
   * Contents of `p`, or `null` when the file does not exist. `null` rather
   * than `""` deliberately: "absent" and "present but empty" are different
   * filesystem states and `rotate()` behaves differently for each
   * (`RNFS.exists` gates both the unlink and the move). Collapsing them would
   * make this mock lie about the code path these tests exercise.
   */
  const readOrNull = (p: string): string | null => (has(p) ? (files[p] ?? "") : null);
  return {
    __files: files,
    DocumentDirectoryPath: "/docs",
    CachesDirectoryPath: "/cache",
    exists: async (p: string) => has(p),
    stat: async (p: string) => ({ size: readOrNull(p)?.length ?? 0 }),
    readFile: async (p: string) => readOrNull(p) ?? "",
    writeFile: async (p: string, c: string) => {
      files[p] = c;
    },
    appendFile: async (p: string, c: string) => {
      files[p] = (readOrNull(p) ?? "") + c;
    },
    unlink: async (p: string) => {
      delete files[p];
    },
    moveFile: async (a: string, b: string) => {
      const contents = readOrNull(a);
      if (contents === null) throw new Error(`moveFile: ${a} does not exist`);
      files[b] = contents;
      delete files[a];
    },
  };
});

/** The persisted flag. Forced ON so `syncEnabledFromStorage()` arms the writer. */
jest.mock("../../state/debugLogStorage", () => ({
  isDebugLoggingEnabledSync: () => true,
  subscribeDebugLogging: () => () => {},
}));

/** Native build constants. `devGate` reads them at module-evaluation time. */
jest.mock("../devGate", () => ({
  buildIdentity: () => ({
    appVersion: "0.1.0",
    appVersionCode: 1,
    buildType: "debug",
    isDebugBuild: true,
    isDebuggable: true,
    gateSource: "test",
    platform: "android",
    // R1: devGate now publishes BUILD_STAMP from the native constant.
    buildStamp: "FIX-2026-09.20260925-143012.a3f19c",
  }),
  describeBuild: () => "build 0.1.0 (1) debug ARMED debuggable=yes gate-src=test",
  IS_DEBUG_BUILD: true,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RNFS = require("react-native-fs") as {
  __files: Record<string, string>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dl = require("../debugLog") as typeof import("../debugLog");
/**
 * Kept typed rather than cast to `Record<string, any>`, so a signature change
 * breaks the test instead of letting every assertion fail at runtime for its
 * own unrelated reason.
 */
const dlNew = dl;

const LIVE = "/docs/peardrop-debug.log";
const ROTATED = "/docs/peardrop-debug.log.1";

/** Let every queued microtask and `setImmediate` callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function arm(): Promise<void> {
  dl.syncEnabledFromStorage();
  for (let i = 0; i < 5; i++) await settle();
}

function live(): string {
  return RNFS.__files[LIVE] ?? "";
}

beforeEach(async () => {
  for (const key of Object.keys(RNFS.__files)) delete RNFS.__files[key];
  await arm();
});

/** 2 KB of filler per line, so two rotations cost ~2100 lines, not ~75000. */
const FILLER = "x".repeat(2000);

async function floodOrdinaryLines(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    dl.log("info", "rn.backend", `Progress ${i % 100}% ${FILLER}`);
    if (i % 200 === 0) await dl.flush();
  }
  await dl.flush();
}

describe("the prologue survives eviction", () => {
  it("keeps the backend boot line in the live segment across two rotations", async () => {
    dl.logFromBackend({
      level: "info",
      tag: "engine.boot",
      msg: "manifest loaded: 4 drive entries",
      at: Date.now(),
    });
    await dl.flush();
    expect(live()).toContain("manifest loaded: 4 drive entries");

    // Two rotations: the segment holding the prologue becomes `.1`, then is
    // unlinked. Without a priority class the line is gone from both files.
    await floodOrdinaryLines(2600);

    expect(RNFS.__files[ROTATED]).toBeDefined();
    const everywhere = (RNFS.__files[ROTATED] ?? "") + live();
    expect(everywhere).toContain("manifest loaded: 4 drive entries");
  });

  it("POSITIVE CONTROL — an ordinary line written just before the check IS present", async () => {
    await floodOrdinaryLines(2600);
    dl.log("info", "rn.backend", "ordinary line written last");
    await dl.flush();
    expect(live()).toContain("ordinary line written last");
  });

  it("classifies the must-survive set as priority and the flood as ordinary", () => {
    expect(dlNew.isPriorityEntry("info", "be:engine.boot")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "be:engine.hydrate")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "device")).toBe(true);
    expect(dlNew.isPriorityEntry("warn", "build")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "rn.fgs")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "rn.freeze")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "rn.fallback")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "rn.reconcile")).toBe(true);
    expect(dlNew.isPriorityEntry("info", "rn.state")).toBe(true);
    // Every ERROR, whatever its tag.
    expect(dlNew.isPriorityEntry("error", "rn.backend")).toBe(true);
    expect(dlNew.isPriorityEntry("error", "anything.at.all")).toBe(true);
    // The flood itself must never be priority, or the class is worthless.
    expect(dlNew.isPriorityEntry("info", "rn.backend")).toBe(false);
    expect(dlNew.isPriorityEntry("info", "rn.progress")).toBe(false);
    expect(dlNew.isPriorityEntry("info", "rn.heartbeat")).toBe(false);
  });
});

describe("log on change, not on tick", () => {
  it("writes once per change, plus one forced line per heartbeat window", async () => {
    const t0 = 1_700_000_000_000;
    // 60 s of a 1 Hz hosted-idle tracker: 60 events, identical snapshot.
    for (let i = 0; i < 60; i++) {
      dlNew.logChangeGated(
        "info",
        "rn.progress",
        "progress:drive_a",
        "p=50 b=1024",
        `progress drive=drive_a 50% bytes=1024`,
        t0 + i * 1000
      );
    }
    await dl.flush();
    const written = live().split("\n").filter((l) => l.includes("progress drive=drive_a"));
    // t0 (first), t0+30s, t0+60s would be the third but the loop ends at +59s.
    expect(written.length).toBe(2);
    expect(written.length).toBeLessThan(60);
  });

  it("POSITIVE CONTROL — a changing signature is never suppressed", async () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 60; i++) {
      dlNew.logChangeGated(
        "info",
        "rn.progress",
        "progress:drive_b",
        `p=${i}`,
        `progress drive=drive_b ${i}%`,
        t0 + i * 1000
      );
    }
    await dl.flush();
    const written = live().split("\n").filter((l) => l.includes("progress drive=drive_b"));
    expect(written.length).toBe(60);
  });

  it("returns false when it suppressed and true when it wrote", () => {
    const t0 = 2_000_000_000_000;
    expect(dlNew.logChangeGated("info", "rn.progress", "k", "sig", "first", t0)).toBe(true);
    expect(dlNew.logChangeGated("info", "rn.progress", "k", "sig", "same", t0 + 1)).toBe(false);
    expect(dlNew.logChangeGated("info", "rn.progress", "k", "other", "changed", t0 + 2)).toBe(true);
  });
});

describe("R1+R2 — both identifiers reach the export header", () => {
  /** Export, and return the bundle's contents. Throws rather than asserting away. */
  async function exportContents(label: string): Promise<string> {
    const out = await dl.buildExportBundle(label);
    if (!out) throw new Error("buildExportBundle returned null — nothing to export");
    return RNFS.__files[out.uri] ?? "";
  }

  it("prints the build stamp and the FULL worklet bundle id", async () => {
    dl.setWorkletBundleId("c".repeat(64));
    dl.log("info", "rn.backend", "something to export");
    const contents = await exportContents("stuck at zero");

    // R1 — the stamp, from devGate's BUILD_STAMP via buildIdentity().
    expect(contents).toContain("stamp:     FIX-2026-09.20260925-143012.a3f19c");
    // R2 — the worklet id, pushed in rather than imported. Full 64, not a prefix.
    expect(contents).toContain(`worklet:   ${"c".repeat(64)}`);
    // The header must still state `segments:` truthfully — the carry-forward
    // writes into the live segment and must not inflate the count.
    expect(contents).toMatch(/^segments: {2}[12]$/m);
  });

  it("prints `unknown` rather than a blank when the id never arrived", async () => {
    dl.setWorkletBundleId(null);
    dl.log("info", "rn.backend", "something to export");
    const contents = await exportContents("no id");
    expect(contents).toContain("worklet:   unknown");
  });
});

describe("the worklet bundle id is parsed, not re-derived", () => {
  it("reads the BLAKE2b content hash out of the real packed bundle", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const artifact = path.join(__dirname, "..", "..", "..", "app", "app.bundle.mjs");
    const fd = fs.openSync(artifact, "r");
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    // The artifact is `export default "<len>\n<json header>…"`, so resolving
    // the JS-string escapes here yields the same string RN's
    // `import bundle from …` hands the parser.
    const head = buf.slice(0, n).toString("utf8");
    const raw = head.replace(/^export default "/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');

    const id = dlNew.parseWorkletBundleId(raw);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null rather than a guess when the header is absent", () => {
    expect(dlNew.parseWorkletBundleId("")).toBeNull();
    expect(dlNew.parseWorkletBundleId("123\n{\"version\":0}")).toBeNull();
    expect(dlNew.parseWorkletBundleId(undefined as unknown as string)).toBeNull();
  });

  it("round-trips through the registry the export header reads", () => {
    dlNew.setWorkletBundleId("a".repeat(64));
    expect(dlNew.getWorkletBundleId()).toBe("a".repeat(64));
  });
});
