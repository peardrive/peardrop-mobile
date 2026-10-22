import type { OpenLinkResult } from "./types";
import { errorCause, errorMessage, userFacingError } from "../lib/errorMessage";

export type ResolveGenRef = { current: number };

/**
 * Holder for the pending resolve's timeout. The caller owns the ref and can clear the timer
 * directly, so the timeout cannot outlive a cancelled resolve.
 */
export type ResolveTimerRef = {
  current: ReturnType<typeof setTimeout> | null;
};

export type ResolveDeps = {
  openLink: (link: string) => Promise<OpenLinkResult>;
  abortOpen: () => Promise<unknown> | void;
  onBegin?: () => void;
  onSuccess: (out: OpenLinkResult) => void;
  /** The engine's machine-readable cause when there is one, passed alongside the message rather than re-derived: by the time a caller has only a sentence, what distinguishes "nobody answered" from "that link is malformed" has been thrown away. */
  onFailure: (errorMessage: string, cause?: string | null) => void;
  onTimeout: () => void;
  onFinally?: () => void;
  timeoutMs?: number;
  /** Caller-owned ref parking the active timeout handle, so an abort need not wait for openLink. */
  timerRef?: ResolveTimerRef;
  /**
   * Optional breadcrumb sink, injected rather than imported so this module
   * stays free of react-native and testable in a plain node environment.
   */
  onLog?: (level: "debug" | "info" | "warn", msg: string) => void;
};

/**
 * The generation guard, extracted so it can be tested without mounting React: side-effect callbacks
 * fire only if no newer resolve started since dispatch. No React dependency, deliberately.
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
      // A newer resolve started mid-flight, so every side effect below is suppressed. Logged,
      // because from the user's seat this is the "I tapped it and nothing happened" case.
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
      deps.onFailure(errorMessage(out.error) || "Could not open link.", errorCause(out.error));
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
        deps.onFailure(userFacingError(e, "Could not open link."), errorCause(e));
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
