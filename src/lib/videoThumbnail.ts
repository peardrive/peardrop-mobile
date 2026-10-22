import { useEffect, useState } from "react";
import * as VideoThumbnails from "expo-video-thumbnails";
import { previewModeFor } from "./files";

/**
 * Cached video-thumbnail generation, keyed by source URI at module scope. In-flight requests share
 * a promise, and failures cache as `null` so a broken or DRM video does not retry on every render.
 */
const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * A still 1 s in, to skip the fade-in and black opening frames phone cameras produce. Falls back
 * to `time: 0` for shorter clips and codecs where the seek fails, so the row still gets a picture.
 */
const PREFERRED_TIME_MS = 1000;

async function generate(uri: string): Promise<string | null> {
  const attempt = async (time: number) => {
    const result = await VideoThumbnails.getThumbnailAsync(uri, {
      time,
      quality: 0.6,
    });
    return result?.uri ?? null;
  };
  try {
    return await attempt(PREFERRED_TIME_MS);
  } catch {
    try {
      return await attempt(0);
    } catch {
      return null;
    }
  }
}

export function getCachedVideoThumbnail(uri: string): string | null | undefined {
  return cache.get(uri);
}

export async function ensureVideoThumbnail(
  uri: string,
): Promise<string | null> {
  if (cache.has(uri)) return cache.get(uri) ?? null;
  const existing = inFlight.get(uri);
  if (existing) return existing;
  const promise = generate(uri).then((value) => {
    cache.set(uri, value);
    inFlight.delete(uri);
    return value;
  });
  inFlight.set(uri, promise);
  return promise;
}

/** Returns a `file://` thumbnail URI once generated, or null while pending and on failure. */
export function useVideoThumbnail(uri: string | null | undefined): string | null {
  const initial = uri ? (cache.get(uri) ?? null) : null;
  const [thumb, setThumb] = useState<string | null>(initial);

  useEffect(() => {
    if (!uri) {
      setThumb(null);
      return;
    }
    const cached = cache.get(uri);
    if (cached !== undefined) {
      setThumb(cached ?? null);
      return;
    }
    let cancelled = false;
    void ensureVideoThumbnail(uri).then((value) => {
      if (!cancelled) setThumb(value);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return thumb;
}

/** Normalises a bare path to a `file://` URI; null when missing or not a recognised video type. */
export function toVideoSourceUri(
  path: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!path || !name) return null;
  if (previewModeFor(name) !== "video") return null;
  return path.startsWith("file://") ? path : `file://${path}`;
}
