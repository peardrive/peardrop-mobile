import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBackend } from "./backend";
import type { OpenLinkResult } from "./types";
import {
  appendDownloadResults,
  loadDownloaded,
  type DownloadedItem,
} from "./receivedFilesStorage";
import {
  loadShare,
  markFilesDownloaded,
  rememberDriveSession,
  upsertShare,
  type ReceivedShare,
  type ReceivedShareFile,
} from "./receivedSharesStorage";
// The fetch/keep rule and the offline picker's adapter are pure modules
// because this file is unreachable from the suite. Do not re-inline either
// one: a hand-rolled split is the defect they exist to close.
import {
  heldNames,
  partitionGrabNames,
  storedShareToOpenResult,
  type StoredFileLike,
} from "../lib/receivedRegrab";
import { addReceived } from "./statsStorage";
import { runGuardedResolve, type ResolveTimerRef } from "./resolveGuard";
import { extractKey, normalizeShareLink, shouldAttemptResolve } from "../lib/links";
import { haptics } from "../lib/haptics";
import { useToast } from "../ui/Toast";
import { useDevMode } from "./devModeStorage";
import RNFS from "react-native-fs";
import { baseName } from "../lib/files";
import { healShareFiles } from "../lib/receivedFileHealth";
import { userFacingError } from "../lib/errorMessage";
import { ensurePermission as ensureNotificationPermission } from "../lib/notifications";
import { log as debugLog, logStructuredError } from "../lib/debugLog";
// The verdict and the ordering both live in pure modules under src/lib,
// because a .tsx cannot be imported by the suite. Do not re-inline either
// one: inlining is what leaves a resolve guard unassertable.
import { classifyResolve } from "../lib/resolveOutcome";
import {
  disposeResolve,
  RESOLVE_NO_MANIFEST_MESSAGE,
} from "../lib/resolveDisposition";
import {
  DEMO_DRIVE_ID,
  getDemoOpenResult,
  isDemoLink,
  materializeDemoFiles,
} from "../lib/demo";


type ShareLinkFlowApi = {
  linkDraft: string;
  setLinkDraft: (s: string) => void;
  resolving: boolean;
  linkError: string | null;
  sessionDriveId: string | null;
  lastResolvedLink: string;
  openResult: OpenLinkResult | null;
  previewVisible: boolean;
  closePreview: () => void;
  qrVisible: boolean;
  setQrVisible: (v: boolean) => void;
  /**
   * Bumped when the scanner's manual-entry affordance is tapped, so the
   * paste input can be opened and focused. A one-shot signal: consumers
   * open on change, and nothing needs clearing.
   */
  manualEntryTick: number;
  requestManualEntry: () => void;
  /**
   * Open the file picker over a stored received share, rendered from disk,
   * without waiting for the sender to be found. Starts the resolve the grab
   * will need in parallel. A no-op for an empty record.
   */
  openStoredSharePicker: (share: ReceivedShare) => void;
  downloadAllBusy: boolean;
  downloadAllFromPreview: () => Promise<void>;
  downloadSelectedFromPreview: (fileNames: string[]) => Promise<void>;
  resolveFromScan: (text: string) => Promise<void>;
  /** Re-runs the resolve against whatever's currently in linkDraft. */
  retryResolve: () => Promise<void>;
  abortResolving: () => void;
  /**
   * IDs of already-downloaded files matching the most recent paste or scan.
   * The list highlights these and calls `clearHighlights` when the flash
   * animation finishes.
   */
  highlightedDownloadedIds: string[];
  clearHighlights: () => void;
  /**
   * Names of files in the resolved manifest the user already has on disk,
   * matched by link and name, with the file still present. The preview
   * badges those rows and defaults them unchecked. Empty when the resolve
   * is not a partial match.
   */
  alreadyDownloadedNames: string[];
  /**
   * File names the preview should pre-check when it opens, typically from
   * tapping a missing file to re-grab it. Null means no preselection, and
   * the preview applies its own default rules.
   */
  pendingPreselection: string[] | null;
  setPendingPreselection: (names: string[] | null) => void;
  /**
   * The moment-of-completion signal for a download, set immediately after
   * the files are recorded. Consumers read it once and call
   * `consumeCompletedDownload` to clear, which makes it a one-shot trigger
   * rather than persisted state.
   */
  lastCompletedDownload: {
    shareKey: string;
    names: string[];
    /** Files now on disk for this grab (newly fetched + kept existing). */
    saved: number;
    /** Files the engine skipped. Non-zero means a PARTIAL grab. */
    failed: number;
    /**
     * The user stopped this grab part-way. `saved` still counts what
     * landed; `failed` means nothing here, because the remaining files
     * were never attempted.
     */
    cancelled?: boolean;
    at: number;
  } | null;
  consumeCompletedDownload: () => void;
};

const ShareLinkFlowContext = createContext<ShareLinkFlowApi | null>(null);

export function ShareLinkFlowProvider({ children }: { children: React.ReactNode }) {
  const { ready, openLink, startDownload, abortOpen, cancelTransfer, deactivateDrive } =
    useBackend();
  const { show: showToast } = useToast();
  const { enabled: devMode } = useDevMode();
  const [linkDraft, setLinkDraftRaw] = useState("");
  const [resolving, setResolving] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Any input edit clears the error immediately: otherwise the previous one
  // sticks until the next resolve completes, which reads as unresponsive.
  const setLinkDraft = useCallback((next: string) => {
    setLinkDraftRaw(next);
    setLinkError(null);
    // Emptying the input wipes any pending preselection: the user has
    // walked away from the re-grab they started.
    if (next.length === 0) setPendingPreselectionState(null);
  }, []);
  const [sessionDriveId, setSessionDriveId] = useState<string | null>(null);
  const [lastResolvedLink, setLastResolvedLink] = useState("");
  const [openResult, setOpenResult] = useState<OpenLinkResult | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [qrVisible, setQrVisible] = useState(false);
  const [manualEntryTick, setManualEntryTick] = useState(0);
  const requestManualEntry = useCallback(() => {
    setQrVisible(false);
    setManualEntryTick((n) => n + 1);
  }, []);
  const [downloadAllBusy, setDownloadAllBusy] = useState(false);
  const [highlightedDownloadedIds, setHighlightedDownloadedIds] = useState<string[]>([]);
  const [alreadyDownloadedNames, setAlreadyDownloadedNames] = useState<string[]>([]);
  // pendingPreselection survives debounced resolve attempts, so a retry
  // keeps it, and clears on an explicit clear, a close, or a completion.
  const [pendingPreselection, setPendingPreselectionState] = useState<string[] | null>(null);
  const setPendingPreselection = useCallback((names: string[] | null) => {
    setPendingPreselectionState(names && names.length > 0 ? names : null);
  }, []);
  // A one-shot completion signal: the question is which download just
  // completed, not whether a share had a recent one. Consumers read once on
  // the state change and call consumeCompletedDownload to clear it.
  const [lastCompletedDownload, setLastCompletedDownload] = useState<{
    shareKey: string;
    names: string[];
    saved: number;
    failed: number;
    cancelled?: boolean;
    at: number;
  } | null>(null);
  const consumeCompletedDownload = useCallback(() => {
    setLastCompletedDownload(null);
  }, []);

  const clearHighlights = useCallback(() => {
    setHighlightedDownloadedIds([]);
  }, []);

  const resolveGen = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveTimerRef = useRef<ResolveTimerRef["current"]>(null);

  /**
   * Dismissing a preview tears the session down: a successful resolve leaves a
   * live swarm behind, so merely looking at a link would pin the sender's
   * foreground service up. Safe only because `runDownload` closes the preview
   * itself. This closes the drive without purging, and does not wait on it.
   */
  const closePreview = useCallback(() => {
    setPreviewVisible(false);
    setLinkError(null);
    // Closing the preview without grabbing clears the smart-regrab hint.
    setPendingPreselectionState(null);
    // The demo drive has no engine session to release.
    if (sessionDriveId && sessionDriveId !== DEMO_DRIVE_ID) {
      void deactivateDrive(sessionDriveId).catch(() => {});
    }
  }, [deactivateDrive, sessionDriveId]);

  /**
   * Classify the dedup match between the resolved manifest and the files
   * already downloaded. "full" skips the preview and highlights the rows,
   * "partial" opens it with the matched names badged and unchecked, and
   * "none" opens it plainly. The match key is the link and the file name
   * together, never the name alone, so two shares carrying the same file
   * name are never conflated. `loadDownloaded` has already dropped entries
   * whose file is gone, so the candidates are implicitly on disk.
   */
  const classifyDedup = useCallback(
    (
      candidates: DownloadedItem[],
      manifest: OpenLinkResult,
    ): {
      kind: "full" | "partial" | "none";
      alreadyNames: string[];
      matchedIds: string[];
    } => {
      const manifestNames = (manifest.files || []).map((f) => f.name);
      if (candidates.length === 0 || manifestNames.length === 0) {
        return { kind: "none", alreadyNames: [], matchedIds: [] };
      }
      // Manifest entries carry a leading slash and stored names do not, so
      // both sides are keyed through `baseName` or every lookup misses and
      // the preview shows files as new when they are already on disk. The
      // original manifest name is kept in `alreadyNames` so the preview's
      // own selection checks still match.
      const candidateByBaseName = new Map<string, DownloadedItem>();
      for (const c of candidates) candidateByBaseName.set(baseName(c.name), c);
      const alreadyNames: string[] = [];
      const matchedIds: string[] = [];
      for (const name of manifestNames) {
        const hit = candidateByBaseName.get(baseName(name));
        if (hit) {
          alreadyNames.push(name);
          matchedIds.push(hit.id);
        }
      }
      if (alreadyNames.length === 0) {
        return { kind: "none", alreadyNames: [], matchedIds: [] };
      }
      if (alreadyNames.length === manifestNames.length) {
        return { kind: "full", alreadyNames, matchedIds };
      }
      return { kind: "partial", alreadyNames, matchedIds };
    },
    [],
  );

  // Persist or refresh the per-share record from a resolved manifest. The
  // file list comes from the engine, which is canonical about the share,
  // and existing per-file metadata is preserved by name match.
  const reconcileShareRecord = useCallback(
    async (manifest: OpenLinkResult, normalizedLink: string): Promise<ReceivedShare | null> => {
      const key = extractKey(normalizedLink);
      if (!key) return null;
      const existing = await loadShare(key);
      const existingByName = new Map(
        (existing?.files ?? []).map((f) => [baseName(f.name), f]),
      );
      const manifestFiles = manifest.files ?? [];
      /**
       * Never carry `isDownloaded: true` forward unchecked: a file deleted
       * outside the app would stay on record for the life of the install,
       * so the row would never offer a re-grab. The check happens here, at
       * resolve time, inside the user's own gesture and in the foreground,
       * because a timer in this app has nowhere to run. One probe per file
       * that claims to be downloaded; the rest are not probed.
       */
      const onDisk = new Map<string, boolean>();
      for (const f of existingByName.values()) {
        if (!f.isDownloaded || !f.localPath || onDisk.has(f.localPath)) continue;
        try {
          onDisk.set(f.localPath, await RNFS.exists(f.localPath));
        } catch {
          // Deliberately not `false`. A thrown probe means it could not be
          // checked, not that the file is gone, and recording it as `false`
          // would strip the `localPath` and orphan bytes that a delete
          // could no longer unlink. Left unset, the probe answers
          // `undefined`, which `healShareFiles` treats as hold the record.
        }
      }
      const healed = healShareFiles({
        manifestFiles,
        prior: Array.from(existingByName.values()),
        isOnDisk: (p) => onDisk.get(p),
      });
      const reconciledFiles: ReceivedShareFile[] = healed.files;
      if (healed.demoted.length > 0) {
        debugLog(
          "warn",
          "rn.resolve",
          `demoted ${healed.demoted.length} file(s) missing from disk for share ${key}`,
        );
      }
      const now = Date.now();
      const next: ReceivedShare = {
        shareKey: key,
        shareLink: normalizedLink,
        /**
         * The engine drive id, persisted: the only other mapping from share
         * key to drive is rebuilt in memory and does not survive a restart,
         * leaving a share the user walked away from with no id to reopen by.
         * Falling back to `existing?.driveId` rather than taking
         * `manifest.driveId` bare, so a resolve that answers without one
         * cannot erase the id a previous resolve earned.
         */
        driveId: manifest.driveId ?? existing?.driveId,
        /**
         * Not news at resolve time — `rememberDriveSession` writes it after
         * a grab — but carried forward explicitly, because this literal is
         * a fresh record and omitting the key would rely on a merge guard.
         */
        downloadFolder: existing?.downloadFolder,
        shareName: manifest.shareName || existing?.shareName || "Share",
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastUpdatedAt: existing?.lastUpdatedAt ?? now,
        files: reconciledFiles,
      };
      try {
        await upsertShare(next);
      } catch {
        // Best-effort — the in-memory openResult still works for this session.
      }
      return next;
    },
    [],
  );

  /**
   * The single rejection route for a resolve whose manifest did not replicate,
   * shared by two call sites so both do the same things. The engine's drive
   * update resolves on head metadata, not on content replication, so the manifest
   * blob may not have streamed yet. Treat it as transient: error, clean up, retry.
   */
  const rejectUnusableResolve = useCallback(
    (manifest: OpenLinkResult, where: string) => {
      // The engine logs why the manifest was unavailable; this records what
      // the user saw, which predicate decided it, and that the half-formed
      // drive was purged. `files` is reported for diagnosis only, and is
      // explicitly not what was gated on.
      debugLog(
        "warn",
        "rn.resolve",
        `no-manifest resolve rejected at ${where} drive=${manifest.driveId ?? "?"} ` +
          `hasManifest=${manifest.hasManifest} files=${manifest.files?.length ?? 0} ` +
          `- gated on hasManifest (NOT files.length); showing retry copy and purging the half-formed drive`,
      );
      haptics.warning();
      if (manifest.driveId) {
        void cancelTransfer(manifest.driveId, { purge: true });
      }
      // The copy makes no claim about file count, because this guard does
      // not key on one. An exported constant rather than a literal, so the
      // copy deny-list applies to it mechanically: a string in a .tsx
      // cannot be reached by a test in this project.
      setLinkError(RESOLVE_NO_MANIFEST_MESSAGE);
    },
    [cancelTransfer],
  );

  const applyDedupClassification = useCallback(
    (
      kind: "full" | "partial" | "none",
      alreadyNames: string[],
      matchedIds: string[],
      manifest: OpenLinkResult,
      normalizedLink: string,
    ) => {
      // A file count cannot gate this in either direction: a share may
      // legitimately declare zero files, and the engine's listing fallback
      // can produce files with no manifest at all. `hasManifest` is the
      // only value that separates them, and `classifyResolve` gates on it
      // and fails closed. This is the second line of defence — `runResolve`
      // classifies before it persists — kept because a guard that runs only
      // when the caller remembers to call it is not a guard.
      if (classifyResolve(manifest) !== "usable") {
        rejectUnusableResolve(manifest, "applyDedupClassification");
        return;
      }
      // A successful resolve clears the link input: the user has moved from
      // typing a link to looking at what is in the share. Failures leave it
      // in place so a retry has something to work with. The preselection
      // goes too, since the preview is about to consume it.
      const clearOnSuccess = () => {
        setLinkDraftRaw("");
        setPendingPreselectionState(null);
      };
      if (kind === "full") {
        // Every manifest file is already on disk, so the preview is skipped
        // and the matching rows flash via highlightedDownloadedIds instead.
        setHighlightedDownloadedIds(matchedIds);
        setAlreadyDownloadedNames([]);
        setSessionDriveId(manifest.driveId ?? null);
        setLastResolvedLink(normalizedLink);
        setOpenResult(manifest);
        setPreviewVisible(false);
        haptics.actionDone();
        showToast("You've already got these.");
        clearOnSuccess();
        return;
      }
      if (kind === "partial") {
        // Some manifest files match, so the preview opens with badges and a
        // softer toast acknowledging the overlap.
        setAlreadyDownloadedNames(alreadyNames);
        setSessionDriveId(manifest.driveId ?? null);
        setLastResolvedLink(normalizedLink);
        setOpenResult(manifest);
        setPreviewVisible(true);
        haptics.actionDone();
        showToast("You already have some of these.");
        clearOnSuccess();
        return;
      }
      // No match — open preview normally, no badges, no dedup toast.
      setAlreadyDownloadedNames([]);
      setSessionDriveId(manifest.driveId ?? null);
      setLastResolvedLink(normalizedLink);
      setOpenResult(manifest);
      setPreviewVisible(true);
      haptics.actionDone();
      clearOnSuccess();
    },
    [showToast, rejectUnusableResolve],
  );

  const runResolve = useCallback(
    async (raw: string) => {
      const normalized = normalizeShareLink(raw);
      if (!normalized) {
        setLinkError("That doesn't look like a PearDrop link.");
        return;
      }
      // Candidate dedup matches: downloaded entries from this link whose
      // file still exists. `loadDownloaded` has already dropped the rest.
      let candidates: DownloadedItem[] = [];
      try {
        const downloaded = await loadDownloaded();
        candidates = downloaded.filter(
          (it) =>
            !!it.shareLink && normalizeShareLink(it.shareLink) === normalized,
        );
      } catch {
        // A failed probe falls through to a normal resolve with no dedup,
        // which beats blocking the share over one file read.
      }
      // Per-share dedup: the share store is keyed by share key, so pasting
      // a previously-grabbed link returns a record with the right flags.
      // Disk-based dedup stays as a fallback for shares with no record.
      const reconcileAndDedup = async (
        out: OpenLinkResult,
      ): Promise<{ kind: "full" | "partial" | "none"; alreadyNames: string[]; matchedIds: string[] }> => {
        const record = await reconcileShareRecord(out, normalized);
        const manifestNames = (out.files || []).map((m) => m.name);
        const alreadyNames: string[] = [];
        if (record) {
          const byName = new Map(record.files.map((f) => [baseName(f.name), f]));
          for (const n of manifestNames) {
            const hit = byName.get(baseName(n));
            if (hit?.isDownloaded) alreadyNames.push(n);
          }
        }
        // Fall back to the on-disk items when the share record yields no
        // matches, which covers a file held with no record behind it.
        if (alreadyNames.length === 0) {
          const legacy = classifyDedup(candidates, out);
          return legacy;
        }
        const matchedIds = candidates
          .filter((c) => alreadyNames.some((n) => baseName(n) === baseName(c.name)))
          .map((c) => c.id);
        if (alreadyNames.length === manifestNames.length) {
          return { kind: "full", alreadyNames, matchedIds };
        }
        return { kind: "partial", alreadyNames, matchedIds };
      };

      // The demo link resolves to a synthetic manifest from the bundled
      // assets. Dedup still runs, so partial-match badges work there too.
      if (isDemoLink(normalized)) {
        resolveGen.current++;
        const demoResult = getDemoOpenResult();
        setResolving(false);
        setLinkError(null);
        // The demo path takes the same classify-then-persist order as the
        // real one. It never touches the engine, so no engine-side gate can
        // protect it, which is part of why the RN guard has to exist. It
        // passes only while `getDemoOpenResult()` keeps saying it has a
        // manifest, and that is now enforced rather than assumed.
        await disposeResolve(demoResult, {
          persist: () => reconcileAndDedup(demoResult),
          accept: (cls) =>
            applyDedupClassification(
              cls.kind,
              cls.alreadyNames,
              cls.matchedIds,
              demoResult,
              normalized,
            ),
          reject: () => rejectUnusableResolve(demoResult, "demo"),
        });
        return;
      }
      await runGuardedResolve(normalized, resolveGen, {
        openLink,
        abortOpen,
        timerRef: resolveTimerRef,
        // resolveGuard stays free of react-native, so the log sink is
        // injected here rather than imported there.
        onLog: (level, msg) => debugLog(level, "rn.resolve", msg),
        onBegin: () => {
          setResolving(true);
          setLinkError(null);
        },
        onSuccess: async (out) => {
          if (out.driveId) {
            // The order is the point: `disposeResolve` classifies first and
            // calls `persist` only on a good resolve. Persisting first would
            // write an empty share record for a manifest-less resolve before
            // the guard ran, and nothing deletes that row afterwards. The
            // draft is kept on both routes so the user can re-paste, copy or
            // edit it.
            await disposeResolve(out, {
              persist: () => reconcileAndDedup(out),
              accept: (cls) =>
                applyDedupClassification(
                  cls.kind,
                  cls.alreadyNames,
                  cls.matchedIds,
                  out,
                  normalized,
                ),
              reject: () => rejectUnusableResolve(out, "onSuccess"),
            });
          } else {
            // The reply was ok but carried no driveId: a soft failure.
            haptics.error();
            // The copy names no cause. There is no connectivity detection
            // anywhere in the tree, and an incomplete resolve cannot tell an
            // offline host from discovery still running, so it claims
            // neither.
            setLinkError("Couldn't open that link — give it another go?");
          }
        },
        onFailure: (message) => {
          haptics.error();
          setLinkError(message);
        },
        onTimeout: () => {
          // A best-effort abort, so a timeout does not leave the engine
          // holding a pending open.
          void abortOpen();
          haptics.warning();
          // Names no cause, for the reason above.
          setLinkError("Couldn't reach the other pear — give it another go?");
        },
        onFinally: () => setResolving(false),
      });
    },
    [
      abortOpen,
      openLink,
      classifyDedup,
      applyDedupClassification,
      reconcileShareRecord,
      rejectUnusableResolve,
    ],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!ready || !linkDraft.trim()) {
      setLinkError(null);
      return;
    }
    if (!shouldAttemptResolve(linkDraft)) {
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runResolve(linkDraft);
    }, 450);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [linkDraft, ready, runResolve]);

  const resolveFromScan = useCallback(
    async (text: string) => {
      setQrVisible(false);
      await runResolve(text);
    },
    [runResolve]
  );

  const retryResolve = useCallback(async () => {
    if (!linkDraft.trim()) return;
    await runResolve(linkDraft);
  }, [linkDraft, runResolve]);

  const abortResolving = useCallback(() => {
    resolveGen.current++;
    // Cancel the timeout directly so it cannot outlive the resolve. A no-op
    // when `runGuardedResolve` has already cleared it.
    if (resolveTimerRef.current) {
      clearTimeout(resolveTimerRef.current);
      resolveTimerRef.current = null;
    }
    void abortOpen();
    setResolving(false);
  }, [abortOpen]);

  const runDownload = useCallback(
    async (fileNames?: string[]) => {
      /**
       * A user can reach this guard. `openStoredSharePicker` opens the
       * picker from disk with no session on purpose, while the resolve that
       * will supply one runs in parallel, so a tap inside that window has
       * genuinely nothing to download from yet. A silent return would be a
       * dead button, so the user is told which of the two happened: still
       * looking, or already failed.
       */
      if (!sessionDriveId) {
        showToast(linkError || "Still finding the sender — give it a moment.", {
          kind: linkError ? "error" : "info",
        });
        return;
      }
      setDownloadAllBusy(true);
      setLinkError(null);
      // The receive path's own permission ask, mirroring the send path: the
      // user's own tap, app in front of them, the first moment there is
      // something worth being notified about. Fire-and-forget, because the
      // grab and the progress card must not wait on an OS dialog, and a
      // denial stays silent by design. Every outcome is logged, so an
      // export can settle whether the dialog appeared and what was answered.
      void ensureNotificationPermission();
      // Close the preview before the fetch, not after, so the transfer card
      // is visible while the download runs rather than covered for its
      // whole duration. Errors surface through `linkError` below the link
      // input, so closing early loses no visibility.
      setPreviewVisible(false);
      try {
        // Partition the in-scope names into those already on disk under
        // this link and those needing a fetch. A file the user checked by
        // hand is honoured but still not re-fetched, so the grab cannot
        // leave a numbered duplicate beside the copy they already have.
        const allManifestNames = (openResult?.files || []).map((f) => f.name);
        const targetNames =
          fileNames && fileNames.length ? fileNames : allManifestNames;
        /**
         * One fetch/keep rule, fed by both notions of already having a file. The
         * engine skips nothing and resolves collisions by numbering, so deciding
         * this wrongly re-fetches held files. The stored record is re-read here
         * and is the only right answer offline; `heldNames` unions both sources.
         */
        const shareKeyForGrab = lastResolvedLink
          ? extractKey(lastResolvedLink)
          : null;
        let storedRecord: ReceivedShare | null = null;
        if (shareKeyForGrab) {
          try {
            storedRecord = await loadShare(shareKeyForGrab);
          } catch {
            /* the resolve-side signal below still applies */
          }
        }
        const legacyHeld: StoredFileLike[] = alreadyDownloadedNames.map((n) => ({
          name: n,
          isDownloaded: true,
          localPath: n,
        }));
        // An empty target list is passed through as an empty grab rather than
        // into `partitionGrabNames`, whose documented reading of "no requested
        // names" is "everything in the share" — right for the modal's "Grab
        // everything", wrong as a fallback for a manifest that produced none.
        const { fetch: fetchNames, keep: keepNames } = targetNames.length
          ? partitionGrabNames(
              [...(storedRecord?.files ?? []), ...legacyHeld],
              targetNames,
            )
          : { fetch: [] as string[], keep: [] as string[] };

        const isDemo = sessionDriveId === DEMO_DRIVE_ID;
        /**
         * The folder the engine actually wrote into, captured here and
         * persisted below so a later re-grab, and the row's answer about
         * where the files went, have something to read.
         */
        let grabDestDir: string | undefined;
        let fetchedFiles: { name: string; path: string; size: number }[] = [];
        /**
         * Per-file casualties from the grab. The engine continues past a
         * failed file and returns `ok: true` with the survivors, so `ok`
         * does not mean the whole share arrived, and an unqualified success
         * leaves the user unable to tell what they have. Carried out to the
         * completion toast.
         */
        let failedCount = 0;
        let wasCancelled = false;
        if (fetchNames.length > 0) {
          debugLog(
            "info",
            "rn.grab",
            `grab start drive=${sessionDriveId} demo=${isDemo} fetch=${fetchNames.length} keep=${keepNames.length}`,
          );
          const out = isDemo
            ? await materializeDemoFiles(fetchNames)
            : await startDownload({
                driveId: sessionDriveId,
                fileNames: fetchNames,
              });
          // Read on the cancelled shape as well as the ok one, so a stopped
          // grab still records where its survivors landed.
          grabDestDir = (out as { destDir?: string }).destDir || undefined;
          // A cancelled grab is reported before the failure branch and never
          // through it: the engine returns `ok: true` with whatever finished
          // first, which for an early cancel is legitimately zero files, and
          // reading that as a failure invites a retry of the thing the user
          // just stopped.
          wasCancelled = !!(out as { cancelled?: boolean }).cancelled;
          if (wasCancelled) {
            fetchedFiles = out.files ?? [];
            debugLog(
              "info",
              "rn.grab",
              `grab cancelled drive=${sessionDriveId} kept=${fetchedFiles.length}`,
            );
          } else {
            if (!out.ok || !out.files?.length) {
              logStructuredError(
                "rn.grab",
                `grab failed drive=${sessionDriveId} ok=${out.ok} files=${out.files?.length ?? 0}`,
                out.error,
              );
              setLinkError(
                // A plain fallback cannot be reached with `||` when a
                // structured error always carries a message, hence the helper.
                userFacingError(out.error, "Couldn't grab those files — give it another go?"),
              );
              return;
            }
            fetchedFiles = out.files;
            failedCount = out.failed?.length ?? 0;
          }
          // The cancelled branch logged its own line above; "grab ok" would
          // contradict it in the same export.
          if (!wasCancelled) {
            debugLog(
              "info",
              "rn.grab",
              `grab ok drive=${sessionDriveId} files=${fetchedFiles.length} ` +
                `bytes=${fetchedFiles.reduce((a, f) => a + (f.size ?? 0), 0)}`,
            );
          }
        }

        if (fetchedFiles.length > 0) {
          /**
           * Two files, so these writes cannot be atomic; what matters is which
           * store is left stale when the process dies between them.
           * `markFilesDownloaded` writes the store the rendered list is built
           * from, so it goes first; the index `appendDownloadResults` writes can
           * be rebuilt. The try/catch stays off that second write.
           */
          const sharedKey = lastResolvedLink ? extractKey(lastResolvedLink) : null;
          if (sharedKey) {
            try {
              await markFilesDownloaded(
                sharedKey,
                fetchedFiles.map((f) => ({
                  name: f.name,
                  localPath: f.path,
                  size: f.size,
                })),
              );
            } catch {
              /* persistence is best-effort */
            }
            /**
             * After `markFilesDownloaded` and deliberately its own call: the
             * two have different failure modes, and folding the session
             * facts into a reconstructed record is how a spread erases
             * fields. `rememberDriveSession` writes nothing when it has
             * nothing new to say, so a repeat grab cannot re-sort the list.
             * The demo drive is excluded, because recording it would make a
             * record claim it can be reopened by an id the engine has never
             * heard of.
             */
            try {
              await rememberDriveSession(sharedKey, {
                driveId: isDemo ? null : sessionDriveId,
                downloadFolder: grabDestDir ?? null,
              });
            } catch {
              /* persistence is best-effort */
            }
          }
          await appendDownloadResults(
            fetchedFiles,
            lastResolvedLink || undefined,
          );
          const bytes = fetchedFiles.reduce((acc, f) => acc + (f.size ?? 0), 0);
          if (bytes > 0) void addReceived(bytes);
        }

        if (keepNames.length > 0) {
          const labels = keepNames.map((n) => baseName(n));
          const msg =
            labels.length === 1
              ? `Kept your existing copy of ${labels[0]}`
              : `Kept your existing copies of ${labels.join(", ")}`;
          showToast(msg);
        }

        // One completion signal per grab, whether or not any bytes moved
        // over the wire: the tap is the trigger, so a grab of new files and
        // a re-grab of held ones are answered the same way.
        const sharedKeyAny = lastResolvedLink ? extractKey(lastResolvedLink) : null;
        const acknowledgedNames = [
          ...fetchedFiles.map((f) => baseName(f.name)),
          ...keepNames.map((n) => baseName(n)),
        ];
        // A cancel that kept nothing still produces a signal. The length
        // guard is right for the normal path, where a grab that
        // acknowledged nothing has nothing to say, but a cancel is a user
        // action and must always be answered.
        if (sharedKeyAny && (acknowledgedNames.length > 0 || wasCancelled)) {
          setLastCompletedDownload({
            shareKey: sharedKeyAny.toLowerCase(),
            names: acknowledgedNames,
            saved: acknowledgedNames.length,
            failed: failedCount,
            cancelled: wasCancelled,
            at: Date.now(),
          });
        }

        // A real download gets its success toast from the completion effect
        // that watches the transfer card. The demo path produces no
        // transfer, so it is toasted here instead; a grab that only kept
        // existing copies already had the toast above.
        if (isDemo && fetchedFiles.length > 0) {
          haptics.success();
          showToast("Got it — demo files saved", { kind: "success" });
        }
      } catch (e: unknown) {
        const raw = String((e as Error)?.message || e);
        setLinkError(
          devMode ? raw : "Something went sideways — give it another go?",
        );
      } finally {
        setDownloadAllBusy(false);
        // The smart-regrab hint has served its purpose once a grab fires.
        setPendingPreselectionState(null);
      }
    },
    [
      sessionDriveId,
      startDownload,
      lastResolvedLink,
      showToast,
      devMode,
      openResult,
      alreadyDownloadedNames,
      // Read by the no-session guard, which reports the resolve's own
      // failure rather than inventing a second message for one event.
      linkError,
    ],
  );

  /**
   * Reopen a received share's picker from what is already on disk, so the list is
   * instant while a resolve for the bytes runs alongside the picker through the
   * ordinary `runResolve`. `sessionDriveId` is left null deliberately:
   * `closePreview` only tears a drive down when it is set, and this opened none.
   */
  const openStoredSharePicker = useCallback(
    (share: ReceivedShare) => {
      // The caller already refuses an empty record, and this is repeated
      // here because a guard that holds only while its one caller remembers
      // it is not a guard.
      if (!share || share.files.length === 0) return;
      setAlreadyDownloadedNames(heldNames(share.files));
      setSessionDriveId(null);
      setLastResolvedLink(share.shareLink);
      setOpenResult(storedShareToOpenResult(share));
      setLinkError(null);
      setHighlightedDownloadedIds([]);
      setPreviewVisible(true);
      haptics.actionDone();
      void runResolve(share.shareLink);
    },
    [runResolve],
  );

  const downloadAllFromPreview = useCallback(() => runDownload(), [runDownload]);
  const downloadSelectedFromPreview = useCallback(
    (fileNames: string[]) => runDownload(fileNames),
    [runDownload]
  );

  const value = useMemo<ShareLinkFlowApi>(
    () => ({
      linkDraft,
      setLinkDraft,
      resolving,
      linkError,
      sessionDriveId,
      lastResolvedLink,
      openResult,
      previewVisible,
      closePreview,
      qrVisible,
      setQrVisible,
      manualEntryTick,
      requestManualEntry,
      openStoredSharePicker,
      downloadAllBusy,
      downloadAllFromPreview,
      downloadSelectedFromPreview,
      resolveFromScan,
      retryResolve,
      abortResolving,
      highlightedDownloadedIds,
      clearHighlights,
      alreadyDownloadedNames,
      pendingPreselection,
      setPendingPreselection,
      lastCompletedDownload,
      consumeCompletedDownload,
    }),
    [
      linkDraft,
      setLinkDraft,
      resolving,
      linkError,
      sessionDriveId,
      lastResolvedLink,
      openResult,
      previewVisible,
      closePreview,
      qrVisible,
      manualEntryTick,
      requestManualEntry,
      openStoredSharePicker,
      downloadAllBusy,
      downloadAllFromPreview,
      downloadSelectedFromPreview,
      resolveFromScan,
      retryResolve,
      abortResolving,
      highlightedDownloadedIds,
      clearHighlights,
      alreadyDownloadedNames,
      pendingPreselection,
      setPendingPreselection,
      lastCompletedDownload,
      consumeCompletedDownload,
    ]
  );

  return (
    <ShareLinkFlowContext.Provider value={value}>{children}</ShareLinkFlowContext.Provider>
  );
}

export function useShareLinkFlow(): ShareLinkFlowApi {
  const ctx = useContext(ShareLinkFlowContext);
  if (!ctx) throw new Error("useShareLinkFlow must be used inside ShareLinkFlowProvider");
  return ctx;
}
