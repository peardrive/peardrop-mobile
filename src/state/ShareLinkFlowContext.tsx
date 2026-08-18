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
  upsertShare,
  type ReceivedShare,
  type ReceivedShareFile,
} from "./receivedSharesStorage";
import { addReceived } from "./statsStorage";
import { runGuardedResolve, type ResolveTimerRef } from "./resolveGuard";
import { extractKey, normalizeShareLink, shouldAttemptResolve } from "../lib/links";
import { haptics } from "../lib/haptics";
import { useToast } from "../ui/Toast";
import { useDevMode } from "./devModeStorage";
import { baseName } from "../lib/files";
import { errorMessage } from "../lib/errorMessage";
import { log as debugLog, logStructuredError } from "../lib/debugLog";
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
   * v5 polish: bumped when the QR scanner's "Enter link manually" affordance
   * is tapped. MainScreen watches this and opens the Receive sheet with the
   * paste input auto-focused. One-shot signal — consumers read the number,
   * open on change, no explicit clear needed.
   */
  manualEntryTick: number;
  requestManualEntry: () => void;
  downloadAllBusy: boolean;
  downloadAllFromPreview: () => Promise<void>;
  downloadSelectedFromPreview: (fileNames: string[]) => Promise<void>;
  resolveFromScan: (text: string) => Promise<void>;
  /** Re-runs the resolve against whatever's currently in linkDraft. */
  retryResolve: () => Promise<void>;
  abortResolving: () => void;
  /**
   * IDs of already-downloaded files matching the most recent paste/scan.
   * ReceiveScreen highlights these and calls `clearHighlights` when the
   * flash animation finishes.
   */
  highlightedDownloadedIds: string[];
  clearHighlights: () => void;
  /**
   * Names of files in the currently-resolved manifest that the user
   * already has on disk (matched by `(shareLink, fileName)` AND the
   * underlying file still exists). SharePreviewModal uses this to badge
   * those rows, default them unchecked, and reduce their opacity.
   * Empty array when the resolve isn't a partial-match case.
   */
  alreadyDownloadedNames: string[];
  /**
   * File names the preview modal should pre-check on open, typically from
   * the "tap a missing child file" re-grab flow. null means no preselection
   * and the modal applies its default rules.
   */
  pendingPreselection: string[] | null;
  setPendingPreselection: (names: string[] | null) => void;
  /**
   * Moment-of-completion signal for a download, set immediately after
   * `markFilesDownloaded` fires. Consumers read it once and call
   * `consumeCompletedDownload` to clear, making it a one-shot trigger rather
   * than persisted state.
   */
  lastCompletedDownload: { shareKey: string; names: string[]; at: number } | null;
  consumeCompletedDownload: () => void;
};

const ShareLinkFlowContext = createContext<ShareLinkFlowApi | null>(null);

export function ShareLinkFlowProvider({ children }: { children: React.ReactNode }) {
  const { ready, openLink, startDownload, abortOpen, cancelTransfer } = useBackend();
  const { show: showToast } = useToast();
  const { enabled: devMode } = useDevMode();
  const [linkDraft, setLinkDraftRaw] = useState("");
  const [resolving, setResolving] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Wrap setLinkDraft so any input edit immediately clears the error.
  // Without this the previous error sticks until the next resolve completes,
  // which makes the screen feel unresponsive after a failure.
  const setLinkDraft = useCallback((next: string) => {
    setLinkDraftRaw(next);
    setLinkError(null);
    // Manual clear (empty input) wipes any pending preselection — the user
    // explicitly walked away from the smart-regrab they kicked off.
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
  // Survives across debounced resolve attempts so retries preserve it, but
  // clears on explicit clear, modal close, or download completion.
  const [pendingPreselection, setPendingPreselectionState] = useState<string[] | null>(null);
  const setPendingPreselection = useCallback((names: string[] | null) => {
    setPendingPreselectionState(names && names.length > 0 ? names : null);
  }, []);
  // One-shot completion signal: "what's the just-completed download?", not
  // "did this share have a recent download?". Consumers read once on state
  // change and call consumeCompletedDownload to clear.
  const [lastCompletedDownload, setLastCompletedDownload] =
    useState<{ shareKey: string; names: string[]; at: number } | null>(null);
  const consumeCompletedDownload = useCallback(() => {
    setLastCompletedDownload(null);
  }, []);

  const clearHighlights = useCallback(() => {
    setHighlightedDownloadedIds([]);
  }, []);

  const resolveGen = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveTimerRef = useRef<ResolveTimerRef["current"]>(null);

  const closePreview = useCallback(() => {
    setPreviewVisible(false);
    setLinkError(null);
    // Closing the preview without grabbing clears the smart-regrab hint.
    setPendingPreselectionState(null);
  }, []);

  /**
   * Classify the dedup match between the resolved manifest and the user's
   * existing downloaded files. Three outcomes:
   *
   * - "full":    every manifest file is already on disk under this link →
   *              skip the preview, highlight the rows, toast.
   * - "partial": some manifest files match, others don't → open the preview
   *              with `alreadyDownloadedNames` populated; new files default
   *              checked, already-downloaded default unchecked + badged.
   * - "none":    no overlap (or all stored entries deleted from disk) →
   *              open the preview normally, no badges.
   *
   * Match key is `(shareLink, fileName)` — never `fileName` alone (so two
   * files with the same name from different shares are never conflated).
   * `loadDownloaded()` already filters out entries whose underlying file
   * is missing from disk, so the candidates list is implicitly on-disk.
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
      // Manifest entries carry leading-slash paths ("/welcome.txt") while
      // stored DownloadedItem.name is stripped via baseName(). Both sides must
      // be keyed on baseName() or the lookup always misses and every file
      // reads as new. `alreadyNames` keeps the original manifest name so
      // SharePreviewModal's `selected.has(f.name)` checks still match.
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

  // Persist / refresh the per-share record from a resolved manifest. The file
  // list comes from the engine (canonical); per-file `isDownloaded` /
  // `localPath` metadata already held is preserved by name match.
  const reconcileShareRecord = useCallback(
    async (manifest: OpenLinkResult, normalizedLink: string): Promise<ReceivedShare | null> => {
      const key = extractKey(normalizedLink);
      if (!key) return null;
      const existing = await loadShare(key);
      const existingByName = new Map(
        (existing?.files ?? []).map((f) => [baseName(f.name), f]),
      );
      const manifestFiles = manifest.files ?? [];
      const reconciledFiles: ReceivedShareFile[] = manifestFiles.map((m) => {
        const prior = existingByName.get(baseName(m.name));
        if (prior?.isDownloaded && prior.localPath) {
          return {
            name: m.name,
            size: m.size ?? prior.size ?? 0,
            isDownloaded: true,
            localPath: prior.localPath,
            downloadedAt: prior.downloadedAt,
          };
        }
        return {
          name: m.name,
          size: m.size ?? 0,
          isDownloaded: false,
        };
      });
      // Files the user has locally that the engine's current manifest
      // doesn't list anymore (rare — share got new manifest blob): keep
      // them in the record. They're still on disk.
      const manifestNames = new Set(manifestFiles.map((m) => baseName(m.name)));
      for (const [name, file] of existingByName) {
        if (!manifestNames.has(name) && file.isDownloaded) {
          reconciledFiles.push(file);
        }
      }
      const now = Date.now();
      const next: ReceivedShare = {
        shareKey: key,
        shareLink: normalizedLink,
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

  const applyDedupClassification = useCallback(
    (
      kind: "full" | "partial" | "none",
      alreadyNames: string[],
      matchedIds: string[],
      manifest: OpenLinkResult,
      normalizedLink: string,
    ) => {
      // Empty-manifest defense. drive.update({wait:true}) resolves on head
      // metadata, not blob replication, so both the manifest blob read and the
      // drive.list("/") fallback can come back empty in the window between
      // connection-established and blobs-replicated — an `ok: true` resolve
      // with zero files, which renders as "0 files in here" plus a "Grab
      // everything" button.
      //
      // Treated as transient: friendly error, fire-and-forget purge of the
      // half-formed drive so retries don't accumulate stale activeDrives
      // entries, and the user retries against a now-warm connection.
      if (!manifest.files || manifest.files.length === 0) {
        // The engine logs why the manifest was empty; this records what the
        // user saw and that the half-formed drive was purged.
        debugLog(
          "warn",
          "rn.resolve",
          `empty manifest defense drive=${manifest.driveId ?? "?"} hasManifest=${manifest.hasManifest} ` +
            `- showing retry copy and purging the half-formed drive`,
        );
        haptics.warning();
        if (manifest.driveId) {
          void cancelTransfer(manifest.driveId, { purge: true });
        }
        setLinkError(
          "Couldn't find any files at this link. The connection might still be syncing — give it another go in a moment.",
        );
        return;
      }
      // A successful resolve clears the link input; failures leave it in place
      // so retry has something to work with. The preselection is about to be
      // consumed by the modal, so clearing it here is harmless.
      const clearOnSuccess = () => {
        setLinkDraftRaw("");
        setPendingPreselectionState(null);
      };
      if (kind === "full") {
        // Every manifest file is already on disk: skip the preview entirely
        // and let the Receive screen flash the matching rows.
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
        // Some manifest files match — show the preview with badges + a
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
    [showToast, cancelTransfer],
  );

  const runResolve = useCallback(
    async (raw: string) => {
      const normalized = normalizeShareLink(raw);
      if (!normalized) {
        setLinkError("That doesn't look like a PearDrop link.");
        return;
      }
      // Find candidate dedup matches: downloaded entries that came from
      // THIS link AND whose underlying file still exists on disk.
      // loadDownloaded() filters out missing files for us, so this list is
      // already on-disk-only.
      let candidates: DownloadedItem[] = [];
      try {
        const downloaded = await loadDownloaded();
        candidates = downloaded.filter(
          (it) =>
            !!it.shareLink && normalizeShareLink(it.shareLink) === normalized,
        );
      } catch {
        // If the probe fails we fall through to a normal resolve with no
        // dedup behavior (better than blocking the share over a JSON read).
      }
      // Per-share dedup. Storage canonicalizes by share key, so re-pasting a
      // previously-grabbed link returns an existing record with the right
      // `isDownloaded` flags. Disk-based dedup remains a fallback for older
      // shares that predate that storage.
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
        // Fall back to the disk-existing legacy items if the new storage
        // didn't yield matches (covers any edge case where the migration
        // didn't capture a record but the user still has the file).
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

      // Magic demo link: synthetic manifest from the bundled assets module.
      // We still run the dedup classification so partial-match badges work
      // for the demo (e.g., user added demo files via Settings then pastes
      // peardrop://demo).
      if (isDemoLink(normalized)) {
        resolveGen.current++;
        const demoResult = getDemoOpenResult();
        setResolving(false);
        setLinkError(null);
        const cls = await reconcileAndDedup(demoResult);
        applyDedupClassification(
          cls.kind,
          cls.alreadyNames,
          cls.matchedIds,
          demoResult,
          normalized,
        );
        return;
      }
      await runGuardedResolve(normalized, resolveGen, {
        openLink,
        abortOpen,
        timerRef: resolveTimerRef,
        // resolveGuard stays RN-free, so the sink is injected here.
        onLog: (level, msg) => debugLog(level, "rn.resolve", msg),
        onBegin: () => {
          setResolving(true);
          setLinkError(null);
        },
        onSuccess: async (out) => {
          if (out.driveId) {
            const cls = await reconcileAndDedup(out);
            applyDedupClassification(
              cls.kind,
              cls.alreadyNames,
              cls.matchedIds,
              out,
              normalized,
            );
            // Keep the draft so the user can re-paste, copy, or edit. They can
            // clear it explicitly with the × button on the input.
          } else {
            // Server said ok but forgot the driveId — treat as a soft failure.
            haptics.error();
            setLinkError("Couldn't open that link — check your Wi-Fi?");
          }
        },
        onFailure: (message) => {
          haptics.error();
          setLinkError(message);
        },
        onTimeout: () => {
          // Kick off a best-effort abort so backend state doesn't leak a
          // pending open when we time out.
          void abortOpen();
          haptics.warning();
          setLinkError("Couldn't reach the other pear — check your Wi-Fi?");
        },
        onFinally: () => setResolving(false),
      });
    },
    [abortOpen, openLink, classifyDedup, applyDedupClassification, reconcileShareRecord],
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
    // Cancel the 30 s timeout directly so it doesn't outlive the resolve.
    // If runGuardedResolve has already cleared it, this is a no-op.
    if (resolveTimerRef.current) {
      clearTimeout(resolveTimerRef.current);
      resolveTimerRef.current = null;
    }
    void abortOpen();
    setResolving(false);
  }, [abortOpen]);

  const runDownload = useCallback(
    async (fileNames?: string[]) => {
      if (!sessionDriveId) return;
      setDownloadAllBusy(true);
      setLinkError(null);
      // Closed before awaiting startDownload, not after, so the transfer card
      // is visible while the download runs. Errors surface via linkError below
      // the link input rather than in the modal, so closing early doesn't lose
      // error visibility.
      setPreviewVisible(false);
      try {
        // Partition the in-scope names into "already on disk under this link"
        // and "needs fetching". An already-downloaded file the user manually
        // checked stays in fileNames but is still skipped for re-fetch —
        // otherwise uniquePath creates `filename (1)` duplicates.
        const allManifestNames = (openResult?.files || []).map((f) => f.name);
        const targetNames =
          fileNames && fileNames.length ? fileNames : allManifestNames;
        const alreadySet = new Set(alreadyDownloadedNames);
        const keepNames = targetNames.filter((n) => alreadySet.has(n));
        const fetchNames = targetNames.filter((n) => !alreadySet.has(n));

        const isDemo = sessionDriveId === DEMO_DRIVE_ID;
        let fetchedFiles: { name: string; path: string; size: number }[] = [];
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
          if (!out.ok || !out.files?.length) {
            logStructuredError(
              "rn.grab",
              `grab failed drive=${sessionDriveId} ok=${out.ok} files=${out.files?.length ?? 0}`,
              out.error,
            );
            setLinkError(
              errorMessage(out.error) || "Couldn't grab those files — give it another go?",
            );
            return;
          }
          fetchedFiles = out.files;
          debugLog(
            "info",
            "rn.grab",
            `grab ok drive=${sessionDriveId} files=${fetchedFiles.length} ` +
              `bytes=${fetchedFiles.reduce((a, f) => a + (f.size ?? 0), 0)}`,
          );
        }

        if (fetchedFiles.length > 0) {
          await appendDownloadResults(
            fetchedFiles,
            lastResolvedLink || undefined,
          );
          // Flip the per-share file flags too, so the bundle row updates in
          // place instead of a fresh row appearing. The record was upserted
          // during the resolve, so the entry exists.
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
          }
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

        // One completion signal per grab, whether or not bytes moved: tapping
        // Grab is the trigger, so "downloaded new files" and "re-grabbed
        // existing files" both land here.
        const sharedKeyAny = lastResolvedLink ? extractKey(lastResolvedLink) : null;
        const acknowledgedNames = [
          ...fetchedFiles.map((f) => baseName(f.name)),
          ...keepNames.map((n) => baseName(n)),
        ];
        if (sharedKeyAny && acknowledgedNames.length > 0) {
          setLastCompletedDownload({
            shareKey: sharedKeyAny.toLowerCase(),
            names: acknowledgedNames,
            at: Date.now(),
          });
        }

        // Modal was already closed at the start of this function (Phase
        // DD). Real downloads get their success toast via the Receive
        // tab's completion effect (which watches the transfer card). The
        // demo path never produces a real transfer, so surface a friendly
        // toast here for the demo. If we only kept existing copies (no
        // actual fetch), the kept-copy toast above is the success signal.
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
    ],
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
