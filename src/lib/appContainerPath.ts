// iOS gives the app a NEW data-container folder on every install and update
// (`/var/mobile/Containers/Data/Application/<UUID>/Documents`) and moves the files across.
// Any absolute path saved before the update still names the OLD folder, so the file looks
// gone: downloads are fetched again as "name (1).ext" and shares lose their files.
// Saved paths are therefore re-pointed at the current container when they are read.
//
// Twin of backend/app-container-path.mjs (the worklet side). Keep the two identical.

const CONTAINER_DOCS =
  /(?:\/private)?\/var\/mobile\/Containers\/Data\/Application\/[0-9A-Fa-f-]{36}\/Documents(?=\/|$|")/g;

/** The current container's Documents folder, or null when `documentRoot` is not an iOS
 *  container path (Android, tests) — then nothing is ever rewritten. */
function currentDocs(documentRoot: string): string | null {
  if (typeof documentRoot !== "string") return null;
  const m = documentRoot.match(CONTAINER_DOCS);
  return m ? m[0] : null;
}

/** Re-point every old-container prefix inside `value` (any depth, any string) at the
 *  current container. Returns the new value and how many strings changed. */
export function rebaseContainerPaths<T>(value: T, documentRoot: string): { value: T; changed: number } {
  const docs = currentDocs(documentRoot);
  if (!docs) return { value, changed: 0 };
  let changed = 0;
  const fix = (s: string): string => {
    const out = s.replace(CONTAINER_DOCS, docs);
    if (out !== s) changed++;
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const out = walk(value) as T;
  return { value: changed ? out : value, changed };
}
