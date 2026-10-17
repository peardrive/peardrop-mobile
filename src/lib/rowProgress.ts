/** The row's percentage, from bytes rather than the engine's event, which is per-attempt and restarts a resume near zero. */
// The denominator is the whole selection and the numerator includes what earlier attempts saved.

export type ProgressFile = {
  /** The drive entry key, as the selection stores it. */
  readonly name: string;
  readonly size: number;
  /** Already on disk from an earlier attempt, or from this one. */
  readonly isDownloaded: boolean;
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

  for (const f of input.files) {
    if (!wanted.has(norm(f.name))) continue;
    const size = usable(f.size);
    total += size;
    if (f.isDownloaded) {
      held += size;
      filesDone++;
    } else {
      remaining += size;
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

  // Clamped at `remaining` so a wire figure inflated by block overhead cannot
  // make the bar claim more than the files that are still outstanding hold.
  const fresh = Math.min(usable(input.bytesThisAttempt), remaining);
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
