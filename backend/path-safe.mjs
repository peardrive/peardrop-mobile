// safePathWithin guard against path-traversal
// on peer-provided paths. Mirrors desktop v0.24.0's `safeJoin` at
// lib/file-utils.js:30-43. The name uses "within" to make the semantic
// explicit — the return value is a path that is provably inside `root`.
//
// Used on the receive side to defend against a hostile sender's manifest
// carrying entries like `"path": "../../../etc/passwd"`. Node's path.join
// collapses `..` segments and can produce a path outside the intended
// root. This helper resolves and then verifies containment; on any
// suspicion, it throws a typed error rather than returning a path.
//
// The typed error carries a `cause` field so the calling engine can
// distinguish path-traversal (peer misbehavior) from other write
// failures (local disk issues). See Unify_process/proposal.md §5.3 for
// the ErrorCause taxonomy.

import path from "bare-path";

import { EngineError } from "./engine-errors.mjs";

// PathTraversalError is now an EngineError subclass. The
// name "PathTraversalError" is kept because it appears in test tripwires
// and reads cleanly in stack traces; the extra typing (category, cause,
// toJSON) comes from the base class.
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

// Join an untrusted relative path onto a trusted root and return the
// resulting absolute path, guaranteeing it stays inside `root`.
// Rejects (throws PathTraversalError) on:
//   - null/empty/non-string input
//   - paths containing NUL bytes (some syscalls truncate at NUL)
//   - absolute paths (leading `/` or drive letter after cleaning)
//   - paths that resolve outside root (via `..` traversal)
//   - paths that resolve to root itself (would write to the root dir,
//     not to a file within — always a bug in the caller or the manifest)
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
