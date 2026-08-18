import { useEffect, useState } from "react";
import * as VideoThumbnails from "expo-video-thumbnails";
import { previewModeFor } from "./files";

/**
 * Cached video-thumbnail generation. `expo-video-thumbnails` writes a
 * one-frame JPEG into the cache dir for a given video URI + time offset,
 * so we only ever need to run it once per source per session and can
 * hand the resulting `file://` back to any number of `<Image>` consumers.
 *
 * The cache lives at module scope keyed by the source URI. In-flight
 * requests share a promise so N mounted rows for the same video only
 * spawn one generation. Failures are cached as `null` so a broken/DRM
 * video doesn't re-attempt on every re-render (call `clearVideoThumbnailCache`
 * to reset if needed — currently unused; kept for future retry hooks).
 */
const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Grab a still 1s into the clip so we skip the fade-in / all-black
 * opening frames common in phone-camera recordings. Falls back to
 * `time: 0` for videos shorter than the preferred offset (or codecs
 * where the seek fails outright) so the row still gets a picture
 * instead of the icon tile.
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

/**
 * Hook: given a local video path (or null), returns a `file://` thumbnail
 * URI once generated. Returns `null` while pending or on failure so the
 * caller can fall back to a glyph tile.
 */
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

/**
 * Convenience: normalize a bare path into a `file://` URI suitable for
 * `expo-video-thumbnails` and `<Image>`. Returns null when the input is
 * missing or the filename isn't a recognized video type.
 */
export function toVideoSourceUri(
  path: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!path || !name) return null;
  if (previewModeFor(name) !== "video") return null;
  return path.startsWith("file://") ? path : `file://${path}`;
}
