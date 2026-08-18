// Path-traversal guard for peer-provided manifest paths.

import path from "bare-path";

import { EngineError } from "./engine-errors.mjs";

// Typed so callers can distinguish peer misbehavior from local write failures.
export class PathTraversalError extends EngineError {
  constructor(message, detail) {
    super({
      category: "receive.path-traversal",
      cause: "peer-path-traversal",
      message,
      detail,
    });
    this.name = "PathTraversalError";
  }
}

// Join an untrusted relative path onto a trusted root, guaranteeing the
// result stays strictly inside `root`. Throws PathTraversalError otherwise.
export function safePathWithin(root, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathTraversalError(
      "empty or non-string path",
      { relPath },
    );
  }
  // Strip NUL bytes (some syscalls truncate at NUL) and leading separators,
  // so the path is relative regardless of what the peer sent.
  const cleaned = relPath.replace(/\0/g, "").replace(/^[/\\]+/, "");
  if (cleaned.length === 0) {
    throw new PathTraversalError(
      "empty path after cleaning",
      { relPath },
    );
  }
  // resolve-then-prefix-check, not path.join: join collapses `..` and can
  // still yield a path outside root.
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, cleaned);
  // Must be strictly below root (root + separator), never root itself.
  if (
    target !== resolvedRoot &&
    target.startsWith(resolvedRoot + path.sep)
  ) {
    return target;
  }
  throw new PathTraversalError(
    `unsafe path outside download folder: ${relPath}`,
    { relPath, root, resolved: target },
  );
}
