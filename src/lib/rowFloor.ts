/** A row's percentage may not go backwards while it is grabbing the same thing. Keyed to what
 *  it is grabbing: a bigger denominator makes the figure drop legitimately. */

export type RowFloor = {
  /** What the floor belongs to. A different signature means a different question. */
  readonly signature: string;
  readonly pct: number;
};

/** The selection and its total; either changing resets the floor. The total is in it because a
 *  sender removing a file shrinks the denominator without the user touching the selection. */
export function floorSignature(
  selection: readonly string[] | undefined,
  selectedTotalBytes: number,
): string {
  const keys = [...(selection ?? [])]
    .map((s) => String(s || "").trim())
    .filter((s) => s.length > 0)
    .sort();
  const total = Number.isFinite(selectedTotalBytes) ? Math.max(0, Math.round(selectedTotalBytes)) : 0;
  return `${keys.length}:${total}:${keys.join("|")}`;
}

/** The percentage to show, and the floor to thread back in on the next render. */
export function applyRowFloor(
  prev: RowFloor | null | undefined,
  signature: string,
  pct: number | null,
): { pct: number | null; floor: RowFloor } {
  if (pct === null || !Number.isFinite(pct)) {
    const kept = prev && prev.signature === signature ? prev : { signature, pct: 0 };
    return { pct, floor: kept };
  }
  const clamped = Math.max(0, Math.min(100, pct));
  // A different signature is a different share; the old high-water mark says nothing about it.
  if (!prev || prev.signature !== signature) {
    return { pct: clamped, floor: { signature, pct: clamped } };
  }
  const floored = Math.max(prev.pct, clamped);
  return { pct: floored, floor: { signature, pct: floored } };
}
