import RNFS from "react-native-fs";
import { readJsonFile, writeJsonAtomic } from "../lib/atomicFile";

/**
 * Per-hosted-share organizational flags. Hosted drives live in the engine
 * manifest, which RN must not mutate directly, so flags like pinned and
 * favorite need an RN-side annotation table keyed by driveId. Received
 * shares carry their own flags on their own record; this is the hosted side.
 */

export type HostedShareFlags = {
  driveId: string;
  isPinned: boolean;
  isFavorite: boolean;
  /** User-supplied name captured at share creation. When present, the
   *  list card + File-info modal read this back as the drive title
   *  instead of the engine-generated one. Undefined for shares the
   *  user never named. */
  customName?: string;
};

const STORAGE_FILE = `${RNFS.DocumentDirectoryPath}/peardrop-hosted-flags.json`;

type Listener = (flags: HostedShareFlags[]) => void;
const listeners = new Set<Listener>();
let cache: HostedShareFlags[] | null = null;

function sanitize(raw: unknown): HostedShareFlags[] {
  if (!Array.isArray(raw)) return [];
  const out: HostedShareFlags[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const driveId = typeof r.driveId === "string" ? r.driveId : null;
    if (!driveId) continue;
    const customName =
      typeof r.customName === "string" && r.customName.trim().length > 0
        ? r.customName
        : undefined;
    out.push({
      driveId,
      isPinned: r.isPinned === true,
      isFavorite: r.isFavorite === true,
      ...(customName ? { customName } : {}),
    });
  }
  return out;
}

/** see `src/lib/atomicFile.ts`. */
async function readFromDisk(): Promise<HostedShareFlags[]> {
  const result = await readJsonFile(STORAGE_FILE);
  if (result.status === "ok") return sanitize(result.value);
  return [];
}

/** Temp file plus rename, never a bare write. */
async function writeToDisk(flags: HostedShareFlags[]): Promise<void> {
  try {
    await writeJsonAtomic(STORAGE_FILE, flags);
  } catch {
    // best-effort
  }
}

function emit(next: HostedShareFlags[]) {
  cache = next;
  for (const l of Array.from(listeners)) {
    try {
      l(next);
    } catch {
      // shield other listeners
    }
  }
}

export async function loadHostedFlags(): Promise<HostedShareFlags[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

async function upsertFlags(
  driveId: string,
  patch: Partial<
    Pick<HostedShareFlags, "isPinned" | "isFavorite" | "customName">
  >,
): Promise<HostedShareFlags[]> {
  const list = await loadHostedFlags();
  const idx = list.findIndex((f) => f.driveId === driveId);
  const existing: HostedShareFlags =
    idx >= 0 && list[idx]
      ? (list[idx] as HostedShareFlags)
      : { driveId, isPinned: false, isFavorite: false };
  const next: HostedShareFlags = { ...existing, ...patch };
  // No-op write if nothing actually changed.
  if (
    idx >= 0 &&
    list[idx] &&
    next.isPinned === existing.isPinned &&
    next.isFavorite === existing.isFavorite &&
    next.customName === existing.customName
  ) {
    return list;
  }
  // Drop the entry entirely when every flag is back to its default, so the
  // file does not accumulate dead records.
  const isEmpty =
    !next.isPinned && !next.isFavorite && !next.customName;
  let updated: HostedShareFlags[];
  if (idx >= 0) {
    if (isEmpty) {
      updated = list.filter((_, i) => i !== idx);
    } else {
      updated = [...list];
      updated[idx] = next;
    }
  } else if (!isEmpty) {
    updated = [...list, next];
  } else {
    return list;
  }
  await writeToDisk(updated);
  emit(updated);
  return updated;
}

export async function setHostedSharePinned(
  driveId: string,
  pinned: boolean,
): Promise<HostedShareFlags[]> {
  return upsertFlags(driveId, { isPinned: pinned });
}

export async function setHostedShareFavorite(
  driveId: string,
  favorite: boolean,
): Promise<HostedShareFlags[]> {
  return upsertFlags(driveId, { isFavorite: favorite });
}

export async function setHostedShareCustomName(
  driveId: string,
  name: string,
): Promise<HostedShareFlags[]> {
  const trimmed = name.trim();
  return upsertFlags(driveId, {
    customName: trimmed.length > 0 ? trimmed : undefined,
  });
}

export async function clearHostedShareFlags(
  driveId: string,
): Promise<HostedShareFlags[]> {
  const list = await loadHostedFlags();
  const next = list.filter((f) => f.driveId !== driveId);
  if (next.length === list.length) return list;
  await writeToDisk(next);
  emit(next);
  return next;
}

export function subscribeHostedFlags(listener: Listener): () => void {
  listeners.add(listener);
  if (cache) {
    try {
      listener(cache);
    } catch {
      // shield
    }
  } else {
    void loadHostedFlags().then((f) => {
      if (listeners.has(listener)) {
        try {
          listener(f);
        } catch {
          // shield
        }
      }
    });
  }
  return () => {
    listeners.delete(listener);
  };
}
