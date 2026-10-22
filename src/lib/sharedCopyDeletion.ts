/** Which of a deleted share's cache copies may be unlinked. Pure, so the refusal is assertable. */
// "Stop sharing" deletes nothing, because it can be undone. Only Delete reaches here.

export type CopyDeletionPlan = {
  /** Paths inside the cache root, safe to unlink. */
  readonly remove: string[];
  /** Paths the plan refused, with the reason, so a caller can log rather than guess. */
  readonly refused: { path: string; reason: "outside-cache" | "traversal" | "empty" }[];
};

function normalize(raw: string): string {
  let p = String(raw || "").trim();
  if (p.startsWith("file://")) {
    p = p.slice(7);
    if (p.startsWith("//")) p = p.slice(1);
  }
  try {
    p = decodeURI(p);
  } catch {
    // An undecodable path is compared raw; the prefix check below still applies.
  }
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A `..` segment is refused outright rather than resolved: this is the only guard, and a
 *  resolver here would be a second implementation of the engine's `safePathWithin`. */
export function planCopyDeletion(
  paths: readonly string[],
  cacheRoot: string,
): CopyDeletionPlan {
  const root = normalize(cacheRoot);
  const remove: string[] = [];
  const refused: CopyDeletionPlan["refused"] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = normalize(raw);
    if (!p) {
      refused.push({ path: String(raw ?? ""), reason: "empty" });
      continue;
    }
    if (p.split("/").includes("..")) {
      refused.push({ path: p, reason: "traversal" });
      continue;
    }
    if (!root || !(p === root || p.startsWith(`${root}/`))) {
      refused.push({ path: p, reason: "outside-cache" });
      continue;
    }
    if (seen.has(p)) continue;
    seen.add(p);
    remove.push(p);
  }
  return { remove, refused };
}
