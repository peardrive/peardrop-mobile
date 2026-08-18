import type { OpenLinkResult } from "./types";
import { errorMessage } from "../lib/errorMessage";

export type ResolveGenRef = { current: number };

/**
 * Holder for the pending-resolve's timeout. The caller owns this ref and
 * can clear the timer directly (e.g. from abortResolving), which makes the
 * timer race-safe: the 30 s setTimeout doesn't outlive a cancelled resolve.
 */
export type ResolveTimerRef = {
  current: ReturnType<typeof setTimeout> | null;
};

export type ResolveDeps = {
  openLink: (link: string) => Promise<OpenLinkResult>;
  abortOpen: () => Promise<unknown> | void;
  onBegin?: () => void;
  onSuccess: (out: OpenLinkResult) => void;
  onFailure: (errorMessage: string) => void;
  onTimeout: () => void;
  onFinally?: () => void;
  timeoutMs?: number;
  /**
   * Optional ref the caller owns. While a resolve is in flight, the active
   * timeout handle is parked here. Callers can clearTimeout it directly to
   * abort the resolve's timer without waiting for openLink to settle.
   */
  timerRef?: ResolveTimerRef;
  /**
   * Breadcrumb sink, injected rather than imported: importing src/lib/debugLog
   * here would pull in react-native-fs and break this module's node-environment
   * unit tests.
   */
  onLog?: (level: "debug" | "info" | "warn", msg: string) => void;
};

/**
 * Core of `ShareLinkFlowContext.runResolve`, extracted so the generation
 * guard can be tested without mounting React. Increments `gen.current`,
 * awaits `openLink(link)` against a timeout, and only fires side-effect
 * callbacks if the generation at dispatch time is still current (i.e., no
 * newer resolve has started since). Callers wire state setters into the
 * callbacks; this module deliberately has no React dependency.
 */
export async function runGuardedResolve(
  link: string,
  gen: ResolveGenRef,
  deps: ResolveDeps
): Promise<void> {
  const log = deps.onLog ?? (() => {});
  const myGen = ++gen.current;
  const startedAt = Date.now();
  log("info", `resolve start gen=${myGen}`);
  try {
    await deps.abortOpen();
  } catch {
    // Best-effort — abort failures are never fatal.
  }
  deps.onBegin?.();

  const timeoutMs = deps.timeoutMs ?? 30000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for peers.")),
      timeoutMs
    );
  });
  if (deps.timerRef) deps.timerRef.current = timer;

  try {
    const out = (await Promise.race([
      deps.openLink(link),
      timeoutPromise,
    ])) as OpenLinkResult;
    if (myGen !== gen.current) {
      // A newer resolve started while this one was in flight, so every side
      // effect below is suppressed. Logged because from the user's seat this
      // is the "I tapped it and nothing happened" case.
      log(
        "warn",
        `resolve gen=${myGen} DISCARDED (superseded by gen=${gen.current}) after ${Date.now() - startedAt}ms — ` +
          `no callbacks fired`
      );
      return;
    }
    if (out.ok) {
      log("info", `resolve gen=${myGen} ok in ${Date.now() - startedAt}ms files=${out.files?.length ?? 0}`);
      deps.onSuccess(out);
    } else {
      log("warn", `resolve gen=${myGen} failed in ${Date.now() - startedAt}ms`);
      deps.onFailure(errorMessage(out.error) || "Could not open link.");
    }
  } catch (e: unknown) {
    if (myGen !== gen.current) {
      log("warn", `resolve gen=${myGen} threw but was already superseded — swallowed`);
    } else {
      const msg = String((e as Error)?.message || e);
      // Treat the timeout reject path specially so consumers can offer an
      // abort affordance distinct from generic link errors.
      if (msg.includes("Timed out waiting for peers")) {
        log(
          "warn",
          `resolve gen=${myGen} TIMED OUT after ${timeoutMs}ms — no peer answered`
        );
        deps.onTimeout();
      } else {
        log("warn", `resolve gen=${myGen} error after ${Date.now() - startedAt}ms: ${msg}`);
        deps.onFailure(msg);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (deps.timerRef && deps.timerRef.current === timer) {
      deps.timerRef.current = null;
    }
    if (myGen === gen.current) deps.onFinally?.();
  }
}
