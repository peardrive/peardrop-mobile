import RNFS from "react-native-fs";
import { logStructuredError, logWarn } from "./debugLog";

/**
 * The RNFS twin of `backend/atomic-save.mjs`, which cannot be imported here:
 * it pulls in `bare-fs/promises`, resolvable only inside the Bare worklet.
 * Writes land on `<path>.tmp` and are renamed over the destination, so a kill
 * damages only the temp. `RNFSManager.moveFile` silently falls back to
 * copy-then-delete when `renameTo` fails, and that fallback is not atomic.
 */

/** Outcome of `readJsonFile`. */
export type JsonReadResult<T> =
  /** The file is not there. A fresh install, or a store never written. */
  | { status: "missing" }
  /** Read and parsed. `value` is the raw parse — callers still sanitize. */
  | { status: "ok"; value: T }
  /**
   * Present and readable, but not JSON. `movedAside` is the path the damaged
   * file was renamed to, or `null` if even the rename failed.
   */
  | { status: "corrupt"; movedAside: string | null }
  /**
   * Present but unreadable (permission, I/O, busy). Same `movedAside`
   * contract, and deliberately distinct from `missing`.
   */
  | { status: "unreadable"; movedAside: string | null };

/** Per-path write queue: interleaved writers share one fixed `<path>.tmp`, so
 *  the write leg is serialized to stop one renaming another's partly rewritten
 *  temp into place. The surrounding read-modify-write is still not atomic. */
const writeQueue = new Map<string, Promise<void>>();

function tempPathFor(path: string): string {
  return `${path}.tmp`;
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  } catch {
    // A leftover temp file is harmless — the next write truncates it.
  }
}

async function writeOnce(path: string, json: string): Promise<void> {
  const tmp = tempPathFor(path);
  try {
    await RNFS.writeFile(tmp, json, "utf8");
  } catch (err) {
    await bestEffortUnlink(tmp);
    throw err;
  }
  try {
    await RNFS.moveFile(tmp, path);
  } catch (err) {
    await bestEffortUnlink(tmp);
    throw err;
  }
}

/** Serialize `JSON.stringify(value, null, 2)` onto `path` via a temp file and
 *  a rename, so a failure cannot leave a half-written store behind. Rejects if
 *  the write or the rename fails. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  // Every `writeQueue` value is a tail whose rejection is already absorbed, so
  // chaining onto it cannot inherit an earlier writer's failure.
  const prior = writeQueue.get(path) ?? Promise.resolve();
  const run = prior.then(() => writeOnce(path, json));
  const tail: Promise<void> = run.then(noop, noop);
  writeQueue.set(path, tail);
  void tail.then(() => {
    if (writeQueue.get(path) === tail) writeQueue.delete(path);
  });
  // The caller gets the real promise, rejection and all.
  return run;
}

function noop(): void {
  /* queue chaining only — the caller sees the real rejection */
}

/** Rename an unreadable or unparseable file aside before anything else, so
 *  the next write cannot destroy data that was only momentarily unreadable.
 *  Returns `null` when even the rename failed, the one case where the data is
 *  at the mercy of the next write. */
async function preserveUnreadable(
  path: string,
  reason: "corrupt" | "unreadable",
  cause: unknown,
): Promise<string | null> {
  logStructuredError("rn.store", `${reason} store ${path}`, cause);
  const dest = `${path}.corrupted-${Date.now()}`;
  try {
    await RNFS.moveFile(path, dest);
    logWarn("rn.store", `${reason} store preserved at ${dest}`);
    return dest;
  } catch (err) {
    logStructuredError("rn.store", `could not preserve ${reason} store ${path}`, err);
    return null;
  }
}

/** Read and parse a JSON file, reporting which way it failed. Never throws;
 *  see `JsonReadResult` and `preserveUnreadable`. */
export async function readJsonFile<T = unknown>(path: string): Promise<JsonReadResult<T>> {
  try {
    if (!(await RNFS.exists(path))) return { status: "missing" };
  } catch (err) {
    // `exists` itself failing is an I/O condition, not evidence of absence.
    return { status: "unreadable", movedAside: await preserveUnreadable(path, "unreadable", err) };
  }

  let raw: string;
  try {
    raw = await RNFS.readFile(path, "utf8");
  } catch (err) {
    return { status: "unreadable", movedAside: await preserveUnreadable(path, "unreadable", err) };
  }

  try {
    return { status: "ok", value: JSON.parse(raw) as T };
  } catch (err) {
    return { status: "corrupt", movedAside: await preserveUnreadable(path, "corrupt", err) };
  }
}
