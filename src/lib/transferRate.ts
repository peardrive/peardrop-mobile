import { useEffect, useRef, useState } from "react";
import type { TransferSummary } from "../state/types";

export type TransferRate = {
  /** Bytes per second over the active window. 0 when we don't have enough samples. */
  speedBps: number;
  /** Seconds remaining at the current rate, or null when not computable. */
  etaSec: number | null;
};

const SAMPLE_WINDOW_MS = 5000;
const MIN_SAMPLE_GAP_MS = 250;

type Sample = { t: number; bytes: number };

/**
 * Derives a short-window transfer rate and ETA from a TransferSummary by
 * sampling `bytesTransferred` on every render. Holding samples in a ref
 * means we don't re-render just to collect data, and the state pulse only
 * fires when the window actually changes the computed rate.
 *
 * This lives on the RN side on purpose: when pearcore lands it can emit
 * rate information natively and this hook becomes a thin pass-through.
 */
export function useTransferRate(transfer: TransferSummary | null | undefined): TransferRate {
  const samplesRef = useRef<Sample[]>([]);
  const [rate, setRate] = useState<TransferRate>({ speedBps: 0, etaSec: null });

  useEffect(() => {
    if (!transfer) {
      samplesRef.current = [];
      setRate({ speedBps: 0, etaSec: null });
      return;
    }

    const now = Date.now();
    const bytes = transfer.bytesTransferred;
    const samples = samplesRef.current;
    const last = samples[samples.length - 1];

    // Reset samples if we see a regression (drive restart) or if we haven't
    // sampled in a while (transfer paused / idle).
    if (last && (bytes < last.bytes || now - last.t > SAMPLE_WINDOW_MS * 2)) {
      samplesRef.current = [{ t: now, bytes }];
      setRate({ speedBps: 0, etaSec: null });
      return;
    }

    if (!last || now - last.t >= MIN_SAMPLE_GAP_MS) {
      samples.push({ t: now, bytes });
    }

    // Drop samples older than the window so the rate tracks current
    // conditions instead of the session average.
    const cutoff = now - SAMPLE_WINDOW_MS;
    while (samples.length > 2 && samples[0] && samples[0].t < cutoff) {
      samples.shift();
    }

    const head = samples[0];
    const tail = samples[samples.length - 1];
    if (!head || !tail || tail.t === head.t) {
      setRate((prev) => (prev.speedBps === 0 && prev.etaSec === null ? prev : { speedBps: 0, etaSec: null }));
      return;
    }

    const dBytes = Math.max(0, tail.bytes - head.bytes);
    const dT = (tail.t - head.t) / 1000;
    const speedBps = dT > 0 ? dBytes / dT : 0;

    const total = transfer.totalBytes ?? transfer.driveSize ?? null;
    const remainingBytes = total != null ? Math.max(0, total - bytes) : null;
    const etaSec = remainingBytes != null && speedBps > 0 ? remainingBytes / speedBps : null;

    setRate((prev) => {
      // Only update when the change is meaningful to keep renders calm.
      const speedDelta = Math.abs(speedBps - prev.speedBps);
      const speedChanged = speedDelta > Math.max(512, prev.speedBps * 0.05);
      const etaChanged = (etaSec == null) !== (prev.etaSec == null) ||
        (etaSec != null && prev.etaSec != null && Math.abs(etaSec - prev.etaSec) > 1);
      return speedChanged || etaChanged ? { speedBps, etaSec } : prev;
    });
  }, [transfer, transfer?.bytesTransferred, transfer?.lastEventAt]);

  return rate;
}
