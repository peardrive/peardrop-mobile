/** The row's percentage, from bytes rather than the engine's event, which is per-attempt and restarts a resume near zero. */
// The denominator is the whole selection and the numerator includes what earlier attempts saved.

export type ProgressFile = {
  /** The drive entry key, as the selection stores it. */
  readonly name: string;
  readonly size: number;
  /** Already on disk from an earlier attempt, or from this one. */
  readonly isDownloaded: boolean;
  /** Bytes of this file already replicated, persisted so they survive the attempt ending. */
  readonly partialBytes?: number;
};

export type RowProgressInput = {
  readonly files: readonly ProgressFile[];
  /** The drive entry keys the user asked for. */
  readonly selection: readonly string[];
  /** Bytes this attempt has pulled over the wire for files not yet marked downloaded, counting each block index once per download. */
  readonly bytesThisAttempt?: number | null;
};

export type RowProgress = {
  /** 0..100. */
  readonly pct: number;
  /** Selected files already on disk. */
  readonly filesDone: number;
  readonly selectedCount: number;
};

/** One spelling for a drive entry key â€” the same normalization `waitingStatus`
 *  uses, repeated rather than imported so this module stays leaf-level. */
function norm(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

function usable(n: unknown): number {
  // `NaN` is a number and would poison every sum downstream; validated here,
  // where the value enters, rather than at the comparison that interprets it.
  if (!Number.isFinite(n as number)) return 0;
  return Math.max(0, n as number);
}

/** Held bytes plus this attempt's, over the selection's total, clamped. */
// A selection whose total size is unknown, which an older host's manifest can produce, falls back to the file count, because a zero for a half-done download is worse than a coarse figure.
export function rowProgress(input: RowProgressInput): RowProgress {
  const wanted = new Set(input.selection.map(norm));
  const selectedCount = wanted.size;

  let total = 0;
  let held = 0;
  let filesDone = 0;
  let remaining = 0;
  let partial = 0;

  for (const f of input.files) {
    if (!wanted.has(norm(f.name))) continue;
    const size = usable(f.size);
    total += size;
    if (f.isDownloaded) {
      held += size;
      filesDone++;
    } else {
      remaining += size;
      // Clamped at the file's own size: a partial can never exceed the file it belongs to.
      partial += Math.min(usable(f.partialBytes), size);
    }
  }

  if (selectedCount === 0) return { pct: 0, filesDone: 0, selectedCount: 0 };

  if (total <= 0) {
    // No usable sizes. The file count is the only honest denominator left.
    return {
      pct: clamp(Math.round((filesDone / selectedCount) * 100)),
      filesDone,
      selectedCount,
    };
  }

  // The persisted partials are the figure, and the wire total is only the fallback for a record
  // written before them. Never summed: it spans files already counted in `held`.
  const source = partial > 0 ? partial : usable(input.bytesThisAttempt);
  // Clamped at `remaining` so a wire figure inflated by block overhead cannot
  // make the bar claim more than the files that are still outstanding hold.
  const fresh = Math.min(source, remaining);
  return {
    pct: clamp(Math.round(((held + fresh) / total) * 100)),
    filesDone,
    selectedCount,
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
