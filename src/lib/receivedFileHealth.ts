import { baseName } from "./files";

/**
 * whether a received file is really on the
 * device, decided here instead of trusting a stored flag.
 *
 * ## The defect this closes
 *
 * `receivedSharesStorage` has **no existence check on `localPath` anywhere**,
 * and `isDownloaded: true` has no `true → false` transition in the tree. The
 * latch is in `reconcileShareRecord`: a prior record with
 * `isDownloaded && localPath` is carried forward **unconditionally**, so a file
 * the user cleared out in Files — or that Android reclaimed without asking —
 * stays "on device" forever. The row then refuses to re-grab it (the re-grab
 * affordance is gated on `isMissing`, which the stale flag pins to `false`) and
 * a re-paste answers *"You've already got these."* **Unreachable and
 * un-re-gettable, with no user action required to get there.**
 *
 * ## Which fix this is
 *
 * S-PERSIST-2's: stat `prior.localPath` before honouring `isDownloaded: true`,
 * and demote on a miss. **X-STORE-2's *preferred* option is not built** — it
 * wanted the row to derive "on device" from `receivedFilesStorage` instead of
 * from a flag, which would add a second store to the rendering path joined on
 * `shareLink` + basename. That is the fragile two-store join the audit has a
 * separate defect for; it makes the rendering path worse, not cheaper.
 *
 * S-COPY-1's sketch — open the preview on the `"full"` dedup branch — is
 * **forbidden** and nothing here enables it. The problem was never the branch;
 * it was that the flag feeding it was false.
 *
 * ## Why a pure module
 *
 * The two call sites are `src/state/ShareLinkFlowContext.tsx` and
 * `src/screens/MainScreen.tsx`, neither of which the jest suite can reach —
 * `testMatch` collects only `*.test.ts` and no `.test.tsx` exists. Amendment
 * move the decision into `src/lib/` and test it there. The filesystem
 * probe is injected, so this module imports nothing from React or RNFS.
 */

/** A stored per-file record. Structurally `ReceivedShareFile`. */
export type StoredShareFile = {
  name: string;
  path?: string | undefined;
  size: number;
  isDownloaded: boolean;
  localPath?: string | undefined;
  downloadedAt?: number | undefined;
};

/** One manifest entry, as a resolve returns it. */
export type ManifestFileLike = { name: string; size?: number | null };

export type HealedShareFiles = {
  files: StoredShareFile[];
  /**
   * `localPath`s whose `isDownloaded` was retracted because the file is gone.
   * Reported rather than swallowed so the caller can log a real repair.
   */
  demoted: string[];
};

/**
 * Rebuild a share's file list from a fresh manifest plus whatever was stored,
 * honouring `isDownloaded: true` **only** when the recorded path is still on
 * disk.
 *
 * `isOnDisk` is the injected probe. It is called at most once per prior file
 * that claims to be downloaded — never for files that never were — so the cost
 * is bounded by what the user actually holds, inside the paste gesture, in the
 * foreground. **Deliberately not a background sweep:** RN timers do not fire
 * backgrounded and there is no native scheduler, so a sweep would have nowhere
 * to run.
 *
 * A probe that throws must be treated as **absent** by the caller, not as
 * present — see `ShareLinkFlowContext`'s wrapper. Demoting a file that is
 * actually there costs one re-grab; keeping one that is gone is the defect.
 */
export function healShareFiles(args: {
  manifestFiles: ManifestFileLike[];
  prior: StoredShareFile[];
  /**
   * Tri-state on purpose. `true` = present, `false` = **proven absent**,
   * `undefined` = the probe could not answer.
   *
   * (review finding F-9): the caller used to collapse a thrown
   * `RNFS.exists` into `false`, so one transient i/o error read as "the user's
   * file is gone" and the entry was demoted — stripping `localPath` with it,
   * which then left the bytes orphaned because `deleteShare` had nothing left
   * to unlink. That is prune-on-doubt, the same hazard `manifest-recovery.mjs`
   * has a never-prune rule for, and it is a data-loss shape rather than a
   * display bug. **Only a definite `false` demotes.**
   */
  isOnDisk: (localPath: string) => boolean | undefined;
}): HealedShareFiles {
  const { manifestFiles, prior, isOnDisk } = args;
  const priorByName = new Map(prior.map((f) => [baseName(f.name), f]));
  const demoted: string[] = [];

  const held = (f: StoredShareFile | undefined): f is StoredShareFile & { localPath: string } => {
    if (!f?.isDownloaded || !f.localPath) return false;
    // `=== false` and not falsiness: `undefined` means the probe could not
    // answer, and an unanswered probe must never cost the user a record.
    if (isOnDisk(f.localPath) === false) {
      demoted.push(f.localPath);
      return false;
    }
    return true;
  };

  const files: StoredShareFile[] = manifestFiles.map((m) => {
    const existing = priorByName.get(baseName(m.name));
    if (held(existing)) {
      return {
        name: m.name,
        size: m.size ?? existing.size ?? 0,
        isDownloaded: true,
        localPath: existing.localPath,
        downloadedAt: existing.downloadedAt,
      };
    }
    return { name: m.name, size: m.size ?? 0, isDownloaded: false };
  });

  // Files the user holds that this manifest no longer lists (the share was
  // re-created with a different blob). They are still on disk and still
  // theirs, so they stay in the record — but they get the same existence
  // check, which is the whole point. Before this they were the one branch
  // that carried `isDownloaded` forward with no check at all.
  const manifestNames = new Set(manifestFiles.map((m) => baseName(m.name)));
  for (const [name, file] of priorByName) {
    if (manifestNames.has(name)) continue;
    if (held(file)) files.push(file);
  }

  return { files, demoted };
}

/**
 * Retract `isDownloaded` for the entry at `localPath`.
 *
 * The second half of S-PERSIST-2, and free knowledge the app currently throws
 * away: `previewFile` already proves the file is gone with an `RNFS.exists`
 * call, shows *"This file is no longer available locally."* and returns —
 * **without writing the fact down**, so the next render still claims the file
 * is on the device and the row still refuses to re-grab it.
 *
 * Returns `null` when nothing changed, so the caller can skip the write
 * rather than churning the store on every preview of a healthy file.
 */
export function demoteMissingFile(
  files: StoredShareFile[],
  localPath: string,
): StoredShareFile[] | null {
  let changed = false;
  const next = files.map((f) => {
    if (f.localPath !== localPath || !f.isDownloaded) return f;
    changed = true;
    const { localPath: _gone, downloadedAt: _then, ...rest } = f;
    return { ...rest, isDownloaded: false };
  });
  return changed ? next : null;
}
