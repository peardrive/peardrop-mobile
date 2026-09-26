// safePathWithin guards peer-provided paths against traversal: the return
// value is provably inside `root`. A hostile sender's manifest can carry
// entries like `"path": "../../../etc/passwd"`, and path.join collapses `..`
// segments into a path outside the intended root, so this resolves and then
// verifies containment, throwing rather than returning a path.
//
// The typed error carries a `cause` field so the engine can tell peer
// path-traversal apart from a local write failure.

import path from "bare-path";

import { EngineError } from "./engine-errors.mjs";

// The name "PathTraversalError" is kept because test tripwires assert on it
// and it reads cleanly in stack traces; the typing comes from the base class.
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

// Join an untrusted relative path onto a trusted root, guaranteeing the result
// stays inside `root`. Throws PathTraversalError on empty or non-string input,
// on NUL bytes (some syscalls truncate at NUL), on absolute paths, and on
// anything resolving outside root or onto root itself.
export function safePathWithin(root, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathTraversalError(
      "empty or non-string path",
      { relPath },
    );
  }
  // Neutralize NUL bytes; strip leading slashes/backslashes so the path
  // is treated as relative regardless of what the peer sent.
  const cleaned = relPath.replace(/\0/g, "").replace(/^[/\\]+/, "");
  if (cleaned.length === 0) {
    throw new PathTraversalError(
      "empty path after cleaning",
      { relPath },
    );
  }
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
