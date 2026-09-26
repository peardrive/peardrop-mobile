/**
 * The worklet must be able to say that it dropped lines before the log flag
 * arrived. `backend/debug-log.mjs` is ESM outside `roots: ["<rootDir>/src"]`
 * and `moduleFileExtensions` does not list `mjs`, so `require` cannot reach
 * it. Rather than mirror it, this reads the real file off disk and evaluates
 * it, stripping only the `export` keyword, which a `Function` body cannot
 * have. `debug-log.mjs` imports nothing, so there is nothing to resolve.
 */

import * as fs from "fs";
import * as path from "path";

const REPO = path.join(__dirname, "..", "..", "..");
const SOURCE =
  process.env.PEARDROP_DEBUG_LOG_MJS ?? path.join(REPO, "backend", "debug-log.mjs");

type WorkletLog = {
  setLogEmit: (fn: unknown) => void;
  setLogEnabled: (v: unknown) => void;
  isLogEnabled: () => boolean;
  droppedBeforeFlagCount?: () => number;
  hasLogFlagArrived?: () => boolean;
  blog: (level: string, tag: string, msg: string) => void;
  binfo: (tag: string, msg: string) => void;
  swallowed: (tag: string, what: string, err: unknown) => void;
};

/**
 * Assert a value is present, and narrow it.
 *
 * `noUncheckedIndexedAccess` makes `emitted[0]` `T | undefined`. The fix must not
 * be `!` or `?.`: `expect(emitted[0]?.msg).toContain(…)` passes vacuously if the
 * array is empty in some future regression, which is precisely the failure these
 * tests exist to catch. This throws with the reason instead, so an empty array
 * fails loudly and for the right reason.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

/** Evaluate the real module text and hand back its exported bindings. */
function loadWorkletLog(): WorkletLog {
  const src = fs.readFileSync(SOURCE, "utf8");
  const names = Array.from(
    src.matchAll(/^export\s+(?:function|const|let)\s+([A-Za-z0-9_$]+)/gm)
  ).map((m) => m[1]);
  const body = `${src.replace(/^export\s+/gm, "")}\nreturn { ${names.join(", ")} };`;
  // `new Function` is deliberate: the worklet module is not reachable through
  // jest's resolver, so the test evaluates its real source text rather than a
  // copy that could drift. No lint rule currently forbids it here.
  return new Function(body)() as WorkletLog;
}

describe("pre-flag drops are counted and reported", () => {
  it("counts every line refused before the flag ever arrives", () => {
    const wl = loadWorkletLog();
    const emitted: { level: string; tag: string; msg: string }[] = [];
    wl.setLogEmit((e: unknown) => emitted.push(e as { level: string; tag: string; msg: string }));

    // This is the boot race: engineInit → loadManifest → binfo, all before
    // RPC_SET_DEBUG_LOGGING lands.
    wl.binfo("engine.boot", "manifest loaded: 4 drive entries");
    wl.binfo("engine.hydrate", "hydrate start: 2 of 4 manifest entries eligible");
    wl.swallowed("engine.boot", "rm storage for drive_x", new Error("nope"));

    expect(emitted).toHaveLength(0);
    expect(wl.hasLogFlagArrived?.()).toBe(false);
    expect(wl.droppedBeforeFlagCount?.()).toBe(3);
  });

  it("states the count on the first rising edge, so a field export can prove it", () => {
    const wl = loadWorkletLog();
    const emitted: { level: string; tag: string; msg: string }[] = [];
    wl.setLogEmit((e: unknown) => emitted.push(e as { level: string; tag: string; msg: string }));

    wl.binfo("engine.boot", "manifest loaded: 4 drive entries");
    wl.setLogEnabled(true);

    expect(emitted).toHaveLength(1);
    const line = must(emitted[0], "the rising-edge line");
    expect(line.level).toBe("warn");
    expect(line.msg).toContain("pre-flag lines dropped=1");
  });

  it("reports zero when the flag arrived first — the state the W1-4 fix produces", () => {
    const wl = loadWorkletLog();
    const emitted: { msg: string }[] = [];
    wl.setLogEmit((e: unknown) => emitted.push(e as { msg: string }));

    wl.setLogEnabled(true);
    wl.binfo("engine.boot", "manifest loaded: 4 drive entries");

    expect(must(emitted[0], "the rising-edge line").msg).toContain(
      "pre-flag lines dropped=0"
    );
    // POSITIVE CONTROL, same run: the boot line itself now reaches the emitter.
    expect(emitted.some((e) => e.msg.includes("manifest loaded: 4 drive entries"))).toBe(true);
  });

  it("does not keep counting after the flag has arrived once", () => {
    const wl = loadWorkletLog();
    wl.setLogEmit(() => {});
    wl.setLogEnabled(true);
    wl.setLogEnabled(false);
    wl.binfo("engine.boot", "a line while the user has Debugging off");
    wl.binfo("engine.boot", "and another");
    expect(wl.droppedBeforeFlagCount?.()).toBe(0);
    expect(wl.hasLogFlagArrived?.()).toBe(true);
  });

  it("still returns before any string work while disabled (Appendix C property)", () => {
    const wl = loadWorkletLog();
    let emits = 0;
    wl.setLogEmit(() => {
      emits++;
    });
    let rendered = 0;
    const costly = {
      toString() {
        rendered++;
        return "expensive";
      },
    };
    wl.blog("info", "engine.boot", costly as unknown as string);
    expect(emits).toBe(0);
    expect(rendered).toBe(0);
  });
});
