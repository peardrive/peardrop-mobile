import { runExportFlow, runManualReset, type ExportDeps } from "../debugLogExport";

/**
 * The guarantee this module exists to enforce.
 *
 * Android's share sheet resolves on dismissal and reports neither the
 * chosen target nor a cancel — so "the export succeeded" is not knowable.
 * The log is therefore cleared if and only if the user explicitly answers
 * "Clear it" to the confirm shown AFTER the sheet returns.
 *
 * Every test below is really one assertion in different clothes: did
 * `clearLog` run when it shouldn't have?
 */

type Calls = string[];

function makeDeps(
  calls: Calls,
  overrides: Partial<ExportDeps> = {}
): ExportDeps {
  return {
    buildBundle: async (label) => {
      calls.push(`buildBundle:${label}`);
      return { uri: "/cache/peardrop-log_x_2026-08-08.txt", fileName: "peardrop-log_x_2026-08-08.txt", bytes: 128 };
    },
    share: async () => {
      calls.push("share");
    },
    confirmClear: async () => {
      calls.push("confirmClear");
      return false;
    },
    clearLog: async () => {
      calls.push("clearLog");
    },
    ...overrides,
  };
}

describe("runExportFlow — the log is never cleared without explicit consent", () => {
  it("does NOT clear when the user dismisses the confirm (the cancelled-export case)", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("stuck at zero", makeDeps(calls, {
      confirmClear: async () => {
        calls.push("confirmClear");
        return false;
      },
    }));

    expect(calls).not.toContain("clearLog");
    expect(outcome).toMatchObject({ ok: true, cleared: false, reason: "kept" });
  });

  it("does NOT clear when building the bundle throws — and never opens the sheet", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("boom", makeDeps(calls, {
      buildBundle: async () => {
        calls.push("buildBundle");
        throw new Error("disk full");
      },
    }));

    expect(calls).not.toContain("clearLog");
    expect(calls).not.toContain("share");
    expect(outcome).toMatchObject({ ok: false, cleared: false, stage: "bundle" });
    expect((outcome as { error: string }).error).toBe("disk full");
  });

  it("does NOT clear when the share sheet fails to open", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("no target", makeDeps(calls, {
      share: async () => {
        calls.push("share");
        throw new Error("no activity found to handle intent");
      },
    }));

    expect(calls).not.toContain("clearLog");
    expect(calls).not.toContain("confirmClear");
    expect(outcome).toMatchObject({ ok: false, cleared: false, stage: "share" });
  });

  it("does NOT clear when the confirm itself throws", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("weird", makeDeps(calls, {
      confirmClear: async () => {
        calls.push("confirmClear");
        throw new Error("modal unmounted");
      },
    }));

    expect(calls).not.toContain("clearLog");
    expect(outcome).toMatchObject({ ok: false, cleared: false, stage: "confirm" });
  });

  it("does NOT clear, and does NOT share, when there is nothing logged", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("empty", makeDeps(calls, {
      buildBundle: async () => {
        calls.push("buildBundle");
        return null;
      },
    }));

    expect(calls).toEqual(["buildBundle"]);
    expect(outcome).toMatchObject({ ok: true, cleared: false, reason: "empty" });
  });

  it("treats a zero-byte bundle as empty rather than sharing an empty file", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("zero", makeDeps(calls, {
      buildBundle: async () => {
        calls.push("buildBundle");
        return { uri: "/cache/x.txt", fileName: "x.txt", bytes: 0 };
      },
    }));

    expect(calls).not.toContain("share");
    expect(calls).not.toContain("clearLog");
    expect(outcome).toMatchObject({ reason: "empty" });
  });

  it("clears ONLY on an explicit 'Clear it', and only after bundling and sharing", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("crash on grab", makeDeps(calls, {
      confirmClear: async () => {
        calls.push("confirmClear");
        return true;
      },
    }));

    // Ordering is the point: the log is still on disk through the bundle
    // and the share, and is only touched after the user has answered.
    expect(calls).toEqual([
      "buildBundle:crash on grab",
      "share",
      "confirmClear",
      "clearLog",
    ]);
    expect(outcome).toMatchObject({ ok: true, cleared: true, reason: "cleared" });
  });

  it("reports a clear failure without claiming the log was cleared", async () => {
    const calls: Calls = [];
    const outcome = await runExportFlow("x", makeDeps(calls, {
      confirmClear: async () => true,
      clearLog: async () => {
        calls.push("clearLog");
        throw new Error("rename failed");
      },
    }));

    expect(outcome).toMatchObject({ ok: false, cleared: false, stage: "clear" });
  });

  it("passes the raw label through to the bundle builder", async () => {
    const seen: string[] = [];
    await runExportFlow("  Weird Label (2) ", makeDeps([], {
      buildBundle: async (label) => {
        seen.push(label);
        return { uri: "/c/x.txt", fileName: "x.txt", bytes: 10 };
      },
      confirmClear: async () => false,
    }));
    expect(seen).toEqual(["  Weird Label (2) "]);
  });

  it("clears exactly once, never more", async () => {
    let clears = 0;
    await runExportFlow("once", makeDeps([], {
      confirmClear: async () => true,
      clearLog: async () => {
        clears++;
      },
    }));
    expect(clears).toBe(1);
  });
});

describe("runManualReset", () => {
  it("does not clear when the confirm is declined", async () => {
    let cleared = false;
    const res = await runManualReset({
      confirmClear: async () => false,
      clearLog: async () => {
        cleared = true;
      },
    });
    expect(cleared).toBe(false);
    expect(res).toEqual({ ok: true, cleared: false });
  });

  it("clears when the confirm is accepted", async () => {
    let cleared = false;
    const res = await runManualReset({
      confirmClear: async () => true,
      clearLog: async () => {
        cleared = true;
      },
    });
    expect(cleared).toBe(true);
    expect(res).toEqual({ ok: true, cleared: true });
  });

  it("does not clear when the confirm throws", async () => {
    let cleared = false;
    const res = await runManualReset({
      confirmClear: async () => {
        throw new Error("dismissed weirdly");
      },
      clearLog: async () => {
        cleared = true;
      },
    });
    expect(cleared).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("reports a failed clear as not-cleared", async () => {
    const res = await runManualReset({
      confirmClear: async () => true,
      clearLog: async () => {
        throw new Error("unlink failed");
      },
    });
    expect(res).toMatchObject({ ok: false, cleared: false });
    expect(res.error).toBe("unlink failed");
  });
});
