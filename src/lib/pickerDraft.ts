/** The picker's draft and the button under the list: ticks are a draft, so a mis-tap cannot stop a file with no way back. */
// The checkbox, the button label and the strike-through all read this module, and nothing reads the record behind its back.

import type { SelectionDiff } from "./rowLifecycle";

/** What the button under the list says and does. */
export type DraftButton =
  /** `ready` only: the first grab. */
  | { readonly kind: "grab"; readonly label: string; readonly enabled: boolean }
  /** The draft matches what is saved. Closes and changes nothing. */
  | { readonly kind: "looksGood"; readonly label: "Looks good"; readonly enabled: true }
  /** The draft differs. Applies the diff, then closes. */
  | { readonly kind: "confirm"; readonly label: "Confirm changes"; readonly enabled: true }
  /** `stopped` and unchanged. Resumes. */
  | { readonly kind: "resume"; readonly label: "Resume"; readonly enabled: true };

export type DraftInput = {
  /** The row's status. */
  readonly status: string;
  /** The keys the record has saved. */
  readonly saved: readonly string[];
  /** The keys ticked in the draft. */
  readonly ticked: readonly string[];
  /** Keys the user marked with the x. A subset of `ticked` by construction —
   *  marking one does not untick it, it schedules a stop. */
  readonly willStop: readonly string[];
  /** Every file in the share, with its size, so the count and total are computed from the ticked list the checkbox renders. */
  readonly files?: readonly { readonly name: string; readonly size: number }[];
  /** Has this share ever saved a file? This is what separates first-grab vocabulary from after-grab vocabulary, which the status alone cannot. */
  // A completed grab settles the row back to ready with its selection cleared, so the status reads ready for a share with files already on disk.
  readonly hasGrabbed?: boolean;
  /** The ticked keys already on disk, which decide whether the no-op label is honest. */
  // Omitted means not known, treated as satisfied, so this cannot manufacture a dead button for a caller that never opted in.
  readonly held?: readonly string[];
};

/** Bytes as a short label, local because the button's rounding is its own question. */
function shortBytes(bytes: number): string {
  const b = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** The Grab button's label, from the draft. Exported so a test can state the rule without a render, and so the one arithmetic has one name. */
export function grabLabelFor(input: DraftInput): string {
  const sizes = new Map((input.files ?? []).map((f) => [f.name, f.size]));
  const n = input.ticked.length;
  let bytes = 0;
  for (const key of input.ticked) bytes += sizes.get(key) ?? 0;
  return `Grab ${n} (${shortBytes(bytes)})`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const k of b) if (!set.has(k)) return false;
  return true;
}

/** Has the user changed anything? A scheduled stop counts as a change. */
export function draftIsDirty(input: DraftInput): boolean {
  if (input.willStop.length > 0) return true;
  return !sameSet(input.saved, input.ticked);
}

/** The diff a confirm sends. Stop and remove are kept apart because only a stop should tear a live pipe down, and a file unticked while merely pending has no pipe to tear. */
export function draftDiff(input: DraftInput): SelectionDiff {
  const saved = new Set(input.saved);
  const ticked = new Set(input.ticked);
  const stopping = new Set(input.willStop);
  const add: string[] = [];
  const remove: string[] = [];
  for (const k of ticked) {
    if (!saved.has(k) && !stopping.has(k)) add.push(k);
  }
  for (const k of saved) {
    if (stopping.has(k)) continue;
    if (!ticked.has(k)) remove.push(k);
  }
  const diff: SelectionDiff = {};
  if (add.length) (diff as { add?: string[] }).add = add;
  if (remove.length) (diff as { remove?: string[] }).remove = remove;
  if (stopping.size) (diff as { stop?: string[] }).stop = [...stopping];
  return diff;
}

/** The button. A ready row keeps the first-grab label, but only while it really is the first grab. */
// A stopped row reads as a resume when nothing changed and a confirm when the draft did, because the change is the news.
export function draftButton(input: DraftInput): DraftButton {
  const firstGrab =
    (input.status === "ready" || input.status === "waiting") && !input.hasGrabbed;
  if (firstGrab) {
    return {
      kind: "grab",
      label: grabLabelFor(input),
      enabled: input.ticked.length > 0,
    };
  }
  if (draftIsDirty(input)) {
    return { kind: "confirm", label: "Confirm changes", enabled: true };
  }
  if (input.status === "stopped") {
    return { kind: "resume", label: "Resume", enabled: true };
  }
  /** The no-op label is honest only when the row needs no help: already satisfied, or a status that acts on its own. */
  // The dead-button case is the complement, and a resume is the control that fits because it re-arms through confirm.
  const selfActing =
    input.status === "downloading" ||
    input.status === "queued" ||
    input.status === "paused";
  if (!selfActing && !isSatisfied(input)) {
    return { kind: "resume", label: "Resume", enabled: true };
  }
  return { kind: "looksGood", label: "Looks good", enabled: true };
}

/** Is every ticked file already on disk? An unknown is treated as satisfied so this cannot invent a resume button, and an empty draft is satisfied because nothing is outstanding. */
function isSatisfied(input: DraftInput): boolean {
  if (input.held === undefined) return true;
  if (input.ticked.length === 0) return true;
  const held = new Set(input.held);
  return input.ticked.every((k) => held.has(k));
}

/** The hint under the header, in every after-grab status. */
export const DRAFT_HINT = "Change your selection, then tap Confirm changes.";

/** Is this file struck through in the draft? The x marks a stop rather than performing one, so the file stays listed and ticked, which is the only way the user can see what confirming will do. */
export function isMarkedToStop(input: DraftInput, key: string): boolean {
  return input.willStop.includes(key);
}
