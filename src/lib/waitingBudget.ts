/** How much background waiting is left today, in the phone's local time. Pure, so the arithmetic is assertable without storage. */

/** The in-app cap. Well under the platform's own `dataSync` allowance, which has to stay available for a real transfer. */
export const WAITING_BUDGET_MS = 2 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shortest real day, a spring-forward one. A midnight sooner than this after the last is a zone change and is not honoured. */
export const MIN_DAY_MS = 23 * 60 * 60 * 1000;

/** Milliseconds east of UTC at an instant. Injected so the day boundary is testable in any zone. */
export type ZoneOffset = (at: number) => number;

export const deviceZoneOffset: ZoneOffset = (at) => -new Date(at).getTimezoneOffset() * 60_000;

/**
 * The longest silence between wakes that still counts as waiting. Several times the engine's tick,
 * so ordinary scheduler jitter is billed and a frozen or dead process is not.
 */
export const WAITING_WAKE_MAX_GAP_MS = 150_000;

/**
 * One stretch of background waiting. `end` is advanced on every wake rather than written once at
 * the stop, so a process the OS kills leaves a span ending at its last tick instead of an open one.
 */
export type WaitingSpan = {
  readonly start: number;
  readonly end: number;
};

export type WaitingBudgetState = {
  readonly spans: readonly WaitingSpan[];
  /** The day boundary last billed against, so a zone change cannot open a second day early. */
  readonly dayStart?: number;
};

export const EMPTY_WAITING_BUDGET: WaitingBudgetState = { spans: [] };

/** How many spans are kept. A day of 30 s wakes closes far fewer than this; the bound is for a clock that jumps. */
const MAX_SPANS = 64;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Drops anything malformed where it enters, so no later comparison has to admit `NaN`. */
export function normaliseSpan(span: unknown): WaitingSpan | null {
  if (!span || typeof span !== "object") return null;
  const start = finite((span as { start?: unknown }).start);
  const end = finite((span as { end?: unknown }).end);
  if (start === null || end === null) return null;
  if (end < start) return null;
  return { start, end };
}

export function normaliseBudget(raw: unknown): WaitingBudgetState {
  const list = (raw as { spans?: unknown })?.spans;
  if (!Array.isArray(list)) return EMPTY_WAITING_BUDGET;
  const spans: WaitingSpan[] = [];
  for (const entry of list) {
    const span = normaliseSpan(entry);
    if (span) spans.push(span);
  }
  const dayStart = finite((raw as { dayStart?: unknown }).dayStart);
  const kept = spans.slice(-MAX_SPANS);
  return dayStart === null ? { spans: kept } : { spans: kept, dayStart };
}

/** The most recent local midnight at or before `now`. */
export function localDayStart(now: number, offsetAt: ZoneOffset = deviceZoneOffset): number {
  const off = finite(offsetAt(now)) ?? 0;
  const midnight = Math.floor((now + off) / DAY_MS) * DAY_MS;
  // Across a DST change the offset in force at midnight differs from the one in force now.
  const atMidnight = finite(offsetAt(midnight - off)) ?? off;
  const start = midnight - atMidnight;
  return start <= now ? start : midnight - off;
}

/** Where today's billing starts. A new day counts only once a real day has passed since the last, so travelling east cannot reset the cap early. */
export function billingFloor(
  state: WaitingBudgetState,
  now: number,
  offsetAt: ZoneOffset = deviceZoneOffset,
): number {
  const today = localDayStart(now, offsetAt);
  const last = finite(state.dayStart);
  if (last === null || today <= last) return today;
  return today - last >= MIN_DAY_MS ? today : last;
}

/** Everything that can no longer contribute to today, dropped so the store does not grow. A day of slack covers a zone moving west. */
export function pruneBudget(
  state: WaitingBudgetState,
  now: number,
  offsetAt: ZoneOffset = deviceZoneOffset,
): WaitingBudgetState {
  const keepAfter = billingFloor(state, now, offsetAt) - DAY_MS;
  const spans = state.spans.filter((s) => s.end > keepAfter).slice(-MAX_SPANS);
  return spans.length === state.spans.length ? state : { ...state, spans };
}

/** Milliseconds of background waiting since the day began. A span crossing midnight counts only its part after it. */
export function spentMs(
  state: WaitingBudgetState,
  now: number,
  offsetAt: ZoneOffset = deviceZoneOffset,
): number {
  const floor = billingFloor(state, now, offsetAt);
  let total = 0;
  for (const span of state.spans) {
    const start = Math.max(span.start, floor);
    const end = Math.min(span.end, now);
    if (end > start) total += end - start;
  }
  return total;
}

export function remainingMs(
  state: WaitingBudgetState,
  now: number,
  capMs: number = WAITING_BUDGET_MS,
  offsetAt: ZoneOffset = deviceZoneOffset,
): number {
  const cap = finite(capMs);
  // A non-finite or negative cap is no budget at all, decided here rather than at the comparison.
  if (cap === null || cap <= 0) return 0;
  return Math.max(0, cap - spentMs(state, now, offsetAt));
}

export function budgetExhausted(
  state: WaitingBudgetState,
  now: number,
  capMs: number = WAITING_BUDGET_MS,
  offsetAt: ZoneOffset = deviceZoneOffset,
): boolean {
  return remainingMs(state, now, capMs, offsetAt) <= 0;
}

/** Bill up to now, extending the running stretch when the silence since its last report is short enough to have been waiting. */
// A longer gap opens a fresh span: unreported silence is a process frozen, foregrounded or dead, none of which is waiting.
export function advanceSpan(
  state: WaitingBudgetState,
  now: number,
  maxGapMs: number = WAITING_WAKE_MAX_GAP_MS,
  offsetAt: ZoneOffset = deviceZoneOffset,
): WaitingBudgetState {
  const at = finite(now);
  const gap = finite(maxGapMs);
  if (at === null) return state;
  const pruned = pruneBudget(state, at, offsetAt);
  const dayStart = billingFloor(pruned, at, offsetAt);
  const last = pruned.spans[pruned.spans.length - 1];
  const extendable =
    last !== undefined && gap !== null && at >= last.end && at - last.end <= gap;
  if (extendable) {
    const spans = pruned.spans.slice(0, -1);
    spans.push({ start: last!.start, end: at });
    return { spans, dayStart };
  }
  return { spans: [...pruned.spans, { start: at, end: at }].slice(-MAX_SPANS), dayStart };
}

/** Start billing a background window. The same rule as a wake, so a stretch is never extended across a foreground gap. */
export function openSpan(
  state: WaitingBudgetState,
  now: number,
  maxGapMs: number = WAITING_WAKE_MAX_GAP_MS,
  offsetAt: ZoneOffset = deviceZoneOffset,
): WaitingBudgetState {
  return advanceSpan(state, now, maxGapMs, offsetAt);
}

/** A lowered cap, or null for anything that is not one. The ceiling is the rule: an override may only ever shorten background waiting. */
export function clampCapOverride(ms: unknown): number | null {
  const n = finite(ms);
  if (n === null || n <= 0) return null;
  return n <= WAITING_BUDGET_MS ? n : null;
}

/** The cap in force. An override counts only while diagnostics are on, so turning them off restores the shipped two hours with no second write. */
export function effectiveCapMs(
  overrideMs: number | null,
  diagnosticsEnabled: boolean,
): number {
  if (!diagnosticsEnabled) return WAITING_BUDGET_MS;
  return clampCapOverride(overrideMs) ?? WAITING_BUDGET_MS;
}

/** The log line R5 asks for at every service start. */
export function describeBudget(
  state: WaitingBudgetState,
  now: number,
  capMs: number = WAITING_BUDGET_MS,
  offsetAt: ZoneOffset = deviceZoneOffset,
): string {
  const spent = spentMs(state, now, offsetAt);
  const left = remainingMs(state, now, capMs, offsetAt);
  return (
    `waitingBudget spentMs=${spent} remainingMs=${left} capMs=${capMs} ` +
    `dayStart=${billingFloor(state, now, offsetAt)} spans=${state.spans.length}`
  );
}
