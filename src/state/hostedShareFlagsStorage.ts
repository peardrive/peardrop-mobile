import RNFS from "react-native-fs";

/**
 * Per-hosted-share organizational flags. Hosted drives live in the engine
 * manifest, which RN must not mutate directly, so flags like "pinned" and
 * "favorite" need an RN-side annotation table keyed by the engine's driveId.
 * Cleared by the consumer on delete via `clearHostedShareFlags(driveId)`.
 *
 * Received shares carry their flags on the `ReceivedShare` record instead —
 * that storage is already RN-side. This file is the hosted side only.
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

async function readFromDisk(): Promise<HostedShareFlags[]> {
  try {
    const exists = await RNFS.exists(STORAGE_FILE);
    if (!exists) return [];
    const raw = await RNFS.readFile(STORAGE_FILE, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeToDisk(flags: HostedShareFlags[]): Promise<void> {
  try {
    await RNFS.writeFile(STORAGE_FILE, JSON.stringify(flags, null, 2), "utf8");
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
  // Drop the entry entirely when every flag has reverted to its default
  // — keeps the JSON file small and avoids accumulating dead records
  // over time.
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
