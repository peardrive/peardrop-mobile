import RNFS from "react-native-fs";
import { readJsonFile, writeJsonAtomic } from "../lib/atomicFile";

/**
 * Counter store for lifetime bytes shared and received. A plain JSON file:
 * it survives a reinstall less reliably than AsyncStorage but is trivial to
 * inspect and reset. Deliberately RN-side truth, so none of this
 * bookkeeping depends on the engine.
 */

export type Stats = {
  sentBytes: number;
  receivedBytes: number;
  updatedAt: number;
};

const STORAGE_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-stats.json`;

const EMPTY: Stats = { sentBytes: 0, receivedBytes: 0, updatedAt: 0 };

type Listener = (s: Stats) => void;
const listeners = new Set<Listener>();
let cache: Stats | null = null;
let inFlight: Promise<void> | null = null;

function sanitize(raw: unknown): Stats {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const r = raw as Record<string, unknown>;
  const sent = typeof r.sentBytes === "number" && Number.isFinite(r.sentBytes) ? Math.max(0, r.sentBytes) : 0;
  const recv =
    typeof r.receivedBytes === "number" && Number.isFinite(r.receivedBytes)
      ? Math.max(0, r.receivedBytes)
      : 0;
  const at = typeof r.updatedAt === "number" ? r.updatedAt : 0;
  return { sentBytes: sent, receivedBytes: recv, updatedAt: at };
}

/** see `src/lib/atomicFile.ts`. */
async function readFromDisk(): Promise<Stats> {
  const result = await readJsonFile(STORAGE_FILE);
  if (result.status === "ok") return sanitize(result.value);
  return { ...EMPTY };
}

/**
 * Temp file plus rename, never a bare write. This store also keeps its own
 * `inFlight` mutex: the per-path queue inside `writeJsonAtomic` serializes
 * the write leg, while `mutate` serializes the whole read-modify-write.
 */
async function writeToDisk(s: Stats): Promise<void> {
  try {
    await writeJsonAtomic(STORAGE_FILE, s);
  } catch {
    // Non-fatal. The counter just won't persist this tick.
  }
}

export async function loadStats(): Promise<Stats> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

function emit(next: Stats) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {}
  }
}

async function mutate(patch: (s: Stats) => Stats): Promise<Stats> {
  while (inFlight) await inFlight;
  let resolve!: () => void;
  inFlight = new Promise<void>((r) => (resolve = r));
  try {
    const current = cache ?? (await readFromDisk());
    const next: Stats = { ...patch(current), updatedAt: Date.now() };
    await writeToDisk(next);
    emit(next);
    return next;
  } finally {
    inFlight = null;
    resolve();
  }
}

export async function addSent(bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  await mutate((s) => ({ ...s, sentBytes: s.sentBytes + bytes }));
}

export async function addReceived(bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  await mutate((s) => ({ ...s, receivedBytes: s.receivedBytes + bytes }));
}

export async function resetStats(): Promise<void> {
  await mutate(() => ({ ...EMPTY }));
}

export function subscribeStats(listener: Listener): () => void {
  listeners.add(listener);
  // Fire once immediately with whatever is cached.
  if (cache) {
    try {
      listener(cache);
    } catch {}
  } else {
    void loadStats().then((s) => {
      if (listeners.has(listener)) listener(s);
    });
  }
  return () => {
    listeners.delete(listener);
  };
}
