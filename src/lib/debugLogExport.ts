// The export → (confirm) → reset orchestrator.
//
// RN-free by design: every side effect arrives as an injected function, so the
// ordering guarantee below is covered by unit tests with fakes rather than
// on-device hope. See src/lib/__tests__/debugLogExport.test.ts.
//
// The guarantee: Android gives no trustworthy "the user actually sent it"
// signal. Sharing.shareAsync() resolves on sheet *dismissal*, identically
// whether the user picked Gmail or hit Back — there is no chosen-target or
// cancel callback. So there is no auto-reset: the log is cleared only when the
// user explicitly answers "Clear it" to a confirm shown after the sheet
// returns. Every other path leaves the log intact. And "clear" is a rotation,
// not a delete, so even the explicit path is recoverable.

export type ExportStage =
  | "bundle" // building the bundle from the rotation segments
  | "share" // handing the file to the system share sheet
  | "confirm" // asking the user whether to clear
  | "clear"; // rotating the live log aside

export type ExportOutcome =
  /** Bundle built, sheet shown, user chose to keep the log. */
  | { ok: true; cleared: false; reason: "kept"; fileName: string }
  /** Bundle built, sheet shown, user chose to clear — log rotated. */
  | { ok: true; cleared: true; reason: "cleared"; fileName: string }
  /** Nothing to export; no sheet was shown and nothing was touched. */
  | { ok: true; cleared: false; reason: "empty"; fileName: null }
  /** Something failed. `stage` says where. The log was NOT cleared. */
  | { ok: false; cleared: false; stage: ExportStage; error: string; fileName: string | null };

export type ExportDeps = {
  /**
   * Build the export bundle on disk and return where it landed. Returns
   * null (or a zero-byte result) when there's nothing worth exporting.
   *
   * Implementations MUST write a *copy* — never hand back the live log
   * path. Reset must never be able to touch a file that's mid-share.
   */
  buildBundle: (label: string) => Promise<{ uri: string; fileName: string; bytes: number } | null>;
  /**
   * Hand the bundle to the system share sheet. Resolves on dismissal —
   * which, per the note above, tells us nothing about delivery.
   */
  share: (uri: string, fileName: string) => Promise<void>;
  /**
   * Ask the user, after the sheet returns, whether to clear the log.
   * Resolves true only on an explicit "Clear it".
   */
  confirmClear: () => Promise<boolean>;
  /** Rotate the live log aside. Only ever called on an explicit `true`. */
  clearLog: () => Promise<void>;
  /** Optional breadcrumb sink so the export flow logs its own steps. */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
};

function errText(e: unknown): string {
  return String((e as Error)?.message || e || "unknown error");
}

/**
 * Run the full export flow. Never throws — every failure path comes back
 * as a typed outcome so the caller can toast it, and in every one of those
 * paths `clearLog` has not been called.
 */
export async function runExportFlow(
  label: string,
  deps: ExportDeps
): Promise<ExportOutcome> {
  const log = deps.log ?? (() => {});

  // --- Stage 1: build the bundle -------------------------------------
  let bundle: { uri: string; fileName: string; bytes: number } | null;
  try {
    bundle = await deps.buildBundle(label);
  } catch (e: unknown) {
    log("error", `export: bundle failed — ${errText(e)}`);
    return { ok: false, cleared: false, stage: "bundle", error: errText(e), fileName: null };
  }

  if (!bundle || bundle.bytes <= 0) {
    log("info", "export: nothing to export (log is empty)");
    return { ok: true, cleared: false, reason: "empty", fileName: null };
  }

  const { uri, fileName, bytes } = bundle;
  log("info", `export: bundled ${bytes} bytes as ${fileName}`);

  // --- Stage 2: share -------------------------------------------------
  // A throw here means the sheet never opened (no share target, provider
  // misconfigured, permission). The log stays untouched.
  try {
    await deps.share(uri, fileName);
  } catch (e: unknown) {
    log("error", `export: share failed — ${errText(e)}`);
    return { ok: false, cleared: false, stage: "share", error: errText(e), fileName };
  }

  // --- Stage 3: confirm ----------------------------------------------
  // The sheet has returned. We do NOT know whether anything was actually
  // sent, so we ask. A failure to even ask is treated as "keep".
  let wantsClear = false;
  try {
    wantsClear = await deps.confirmClear();
  } catch (e: unknown) {
    log("warn", `export: confirm failed, keeping log — ${errText(e)}`);
    return { ok: false, cleared: false, stage: "confirm", error: errText(e), fileName };
  }

  if (!wantsClear) {
    log("info", "export: user kept the log");
    return { ok: true, cleared: false, reason: "kept", fileName };
  }

  // --- Stage 4: clear (rotate) ---------------------------------------
  // Reached only on an explicit "Clear it".
  try {
    await deps.clearLog();
  } catch (e: unknown) {
    log("error", `export: clear failed — ${errText(e)}`);
    return { ok: false, cleared: false, stage: "clear", error: errText(e), fileName };
  }

  log("info", "export: log rotated after user confirmed clear");
  return { ok: true, cleared: true, reason: "cleared", fileName };
}

/**
 * Manual reset — the Settings "Reset log" button. Independent of export.
 *
 * Same rotate-not-delete semantics, and the confirm is the caller's
 * destructive-tone ConfirmModal. Split out from runExportFlow so the two
 * reset paths can't accidentally share state.
 */
export async function runManualReset(deps: {
  confirmClear: () => Promise<boolean>;
  clearLog: () => Promise<void>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}): Promise<{ ok: boolean; cleared: boolean; error?: string }> {
  const log = deps.log ?? (() => {});
  let confirmed = false;
  try {
    confirmed = await deps.confirmClear();
  } catch (e: unknown) {
    return { ok: false, cleared: false, error: errText(e) };
  }
  if (!confirmed) {
    log("info", "reset: cancelled by user");
    return { ok: true, cleared: false };
  }
  try {
    await deps.clearLog();
  } catch (e: unknown) {
    log("error", `reset: failed — ${errText(e)}`);
    return { ok: false, cleared: false, error: errText(e) };
  }
  log("info", "reset: log rotated on manual reset");
  return { ok: true, cleared: true };
}
