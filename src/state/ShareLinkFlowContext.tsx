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
import type { OpenLinkResult, TransferSummary } from "./types";
import {
  appendDownloadResults,
  loadDownloaded,
  type DownloadedItem,
} from "./receivedFilesStorage";
import {
  createWaitingShare,
  deleteShare,
  loadShare,
  loadShares,
  markFilesDownloaded,
  patchShare,
  rememberDriveSession,
  subscribeShares,
  upsertShare,
  type ReceivedShare,
  type ReceivedShareFile,
} from "./receivedSharesStorage";
import {
  rowLifecycle,
  type RowLifecycleEvent,
  type RowLifecycleState,
  type SelectionDiff,
} from "../lib/rowLifecycle";
import { rowLifecycleFromShare } from "../lib/rowLifecycleFromShare";
import { senderLookupFor } from "../lib/senderLookup";
import { isLiveSessionRefusal } from "../lib/liveSessionGuard";
import {
  GRAB_QUEUED_TOAST,
  GRAB_TOAST_DELAY_MS,
  shareView,
  type FlapHold,
  type ShareRecordLike,
  type ShareView,
} from "../lib/shareModel";
import { planStallRetry } from "../lib/stallRetry";
// The fetch/keep rule and the offline picker's adapter stay pure modules: this file is unreachable from the suite, and re-inlining them restores the defect they close.
import {
  heldNames,
  partitionGrabNames,
  storedShareToOpenResult,
  type StoredFileLike,
} from "../lib/receivedRegrab";
import {
  buildShareKeyDriveIndex,
  resolveReceivedTransfer,
} from "../lib/receiveProgress";
import { addReceived } from "./statsStorage";
import { runGuardedResolve, type ResolveTimerRef } from "./resolveGuard";
import { extractKey, normalizeShareLink, shouldAttemptResolve } from "../lib/links";
import { haptics } from "../lib/haptics";
import { useToast } from "../ui/Toast";
import { useDevMode } from "./devModeStorage";
import RNFS from "react-native-fs";
import { baseName } from "../lib/files";
import { healShareFiles } from "../lib/receivedFileHealth";
import { errorCause } from "../lib/errorMessage";
import { ensurePermission as ensureNotificationPermission } from "../lib/notifications";
import { log as debugLog, logStructuredError } from "../lib/debugLog";
// The verdict and the ordering live in pure modules because jest cannot import a .tsx here; inlining is what made the old guard unassertable.
import { classifyResolve } from "../lib/resolveOutcome";
import {
  isLoopStatus,
  matchSelection,
  statusAfterResolve,
} from "../lib/waitingStatus";
import {
  classifyGrabFailure,
  classifyResolveFailure,
  resumedToast,
  savesWaitingRow,
  senderAvailableToast,
  WAITING_SAVED_TOAST,
} from "../lib/waitingDisposition";
import {
  createWaitingLoop,
  TICK_MS,
  type WaitingLoop,
  type WaitingRow,
} from "../lib/waitingLoop";
import { previewHandoffFor, type ResolveHandoffKind } from "../lib/previewHandoff";
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
// Tone-tagged notices: a normal wait is muted, a real failure is red. The rule lives in a pure module so the suite reaches it.
import {
  ALREADY_HELD_MESSAGE,
  linkNotice,
  noticeForResolveFailure,
  STILL_RESOLVING_MESSAGE,
  type LinkNotice,
} from "../lib/resolveNotice";


type ShareLinkFlowApi = {
  linkDraft: string;
  setLinkDraft: (s: string) => void;
  resolving: boolean;
  linkError: LinkNotice | null;
  /** Bumped when the 30 s resolve guard fires; MainScreen closes the sheet and the message goes out as a toast. */
  resolveTimeoutTick: number;
  /** Bumped when a resolve succeeds and the picker takes over; MainScreen
   *  hides the Receive sheet on it. Not a close — the resolve succeeded. */
  previewOpenedTick: number;
  /** Bumped when a link is saved as a waiting row; MainScreen closes the
   *  Receive sheet on it, or the new row stays hidden behind it. */
  waitingSavedTick: number;
  sessionDriveId: string | null;
  lastResolvedLink: string;
  openResult: OpenLinkResult | null;
  previewVisible: boolean;
  closePreview: () => void;
  qrVisible: boolean;
  setQrVisible: (v: boolean) => void;
  /** Bumped when the scanner's manual-entry affordance is tapped; MainScreen opens Receive with the input focused. */
  manualEntryTick: number;
  requestManualEntry: () => void;
  /** Open the picker over a stored share rendered from disk, starting the resolve in parallel. No-op when empty. */
  openStoredSharePicker: (share: ReceivedShare) => void;
  downloadAllBusy: boolean;
  /** The last grab failed for a real reason, not an absent sender. */
  grabFailed: boolean;
  downloadAllFromPreview: () => Promise<void>;
  downloadSelectedFromPreview: (fileNames: string[]) => Promise<void>;
  /** Resolves a scanned link at once. `writeDraft` is opt-in: the deep-link bridge must not leave a link in a sheet nobody opened. */
  resolveFromScan: (text: string, opts?: { writeDraft?: boolean }) => Promise<void>;
  /** Re-runs the resolve against whatever's currently in linkDraft. */
  retryResolve: () => Promise<void>;
  /** Re-runs the resolve for the reopen picker against `lastResolvedLink`, which `retryResolve` never reads. */
  relookupPreview: () => Promise<void>;
  abortResolving: () => void;
  /** Manifest files already on disk, matched by link and name; the preview badges them and defaults them unchecked. */
  alreadyDownloadedNames: string[];
  /** File names the preview should pre-check; null leaves the modal to its own default selection. */
  pendingPreselection: string[] | null;
  setPendingPreselection: (names: string[] | null) => void;
  /** One-shot completion signal, cleared by `consumeCompletedDownload` so it never becomes persisted state. */
  lastCompletedDownload: {
    shareKey: string;
    names: string[];
    /** Files now on disk for this grab (newly fetched + kept existing). */
    saved: number;
    /** Files the engine skipped. Non-zero means a PARTIAL grab. */
    failed: number;
    /** Stopped part-way: `saved` counts what landed, and `failed` means nothing because the rest were never attempted. */
    cancelled?: boolean;
    at: number;
  } | null;
  consumeCompletedDownload: () => void;
  /** Look this row up right now, with its backoff reset. */
  retryWaitingRow: (shareKey: string) => Promise<void>;
  /** Leave the loop. Downloaded files stay; an empty waiting row is removed. */
  stopWaitingRow: (shareKey: string) => Promise<void>;
  /** The open picker's view: every string, tick, percentage and button it draws comes from here and nothing else, so there is no second code path to drift. */
  pickerView: ShareView | null;
  /** Is the real record still loading behind the picker? The picker holds its tick seeding while true, so a draft cannot seed off the synthesised stand-in. */
  pickerHydrating: boolean;
  /** One anti-flap hold per share key, shared by every surface: two holds are two sources of truth about the same question. */
  // A mutable map rather than state, because the hold is an output of rendering and storing it would re-render on every decision.
  flapHolds: Map<string, FlapHold>;
  /** Commit the picker's draft. The only selection write: ticks and the x are a draft until the button is tapped. */
  // `stop` is separate from `remove` because only the first should tear a pipe down.
  confirmSelection: (diff: SelectionDiff) => Promise<void>;
};

const ShareLinkFlowContext = createContext<ShareLinkFlowApi | null>(null);

export function ShareLinkFlowProvider({ children }: { children: React.ReactNode }) {
  const {
    ready,
    openLink,
    startDownload,
    abortOpen,
    /** The purging handle is in scope for exactly one caller, `rejectUnusableResolve`, which purges only a store the resolve itself created; every user-stop path here uses the non-purging one. */
    cancelTransfer,
    cancelInFlight,
    deactivateDrive,
    lookupPeers,
    appActive,
    transfers,
    drives,
  } = useBackend();
  const { show: showToast } = useToast();
  const { enabled: devMode } = useDevMode();
  const [linkDraft, setLinkDraftRaw] = useState("");
  const [resolving, setResolving] = useState(false);
  const [linkError, setLinkError] = useState<LinkNotice | null>(null);
  const [resolveTimeoutTick, setResolveTimeoutTick] = useState(0);
  const [previewOpenedTick, setPreviewOpenedTick] = useState(0);
  const [waitingSavedTick, setWaitingSavedTick] = useState(0);

  // Clear the error on any edit, or it sticks until the next resolve and the screen feels dead.
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
  /** The last grab failed for a reason that is not an absent sender. Drives the
   * picker's one error status; a missing peer queues instead and never sets it. */
  const [grabFailed, setGrabFailed] = useState(false);
  const [alreadyDownloadedNames, setAlreadyDownloadedNames] = useState<string[]>([]);
  // Survives debounced retries; cleared on explicit clear, modal close or completion.
  const [pendingPreselection, setPendingPreselectionState] = useState<string[] | null>(null);
  const setPendingPreselection = useCallback((names: string[] | null) => {
    setPendingPreselectionState(names && names.length > 0 ? names : null);
  }, []);
  // One-shot: consumers read it on change and call consumeCompletedDownload to clear.
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

  const resolveGen = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The draft a scan has already resolved itself. Re-arming the debounce would bump the generation and abort that
   *  resolve mid-flight, orphaning a driveId it had produced. One-shot, compared by value. */
  const draftWrittenByScanRef = useRef<string | null>(null);
  /** The last committed draft, mirrored so a handler can read it without taking it as a dependency. Writing an
   *  identical value is a no-op, so a one-shot armed for it would swallow the next genuine resolve of that link. */
  const linkDraftRef = useRef("");
  /** Synchronous re-entry latch for `relookupPreview` — see its comment. */
  const relookupInFlightRef = useRef(false);
  const resolveTimerRef = useRef<ResolveTimerRef["current"]>(null);
  /** Share keys with a user-started grab in flight: the loop's own per-row guard cannot see a grab the user started from the picker. */
  const busyRowsRef = useRef<Set<string>>(new Set());
  /** How the current session was obtained. A ref, not state, because the close path reads it synchronously inside a callback whose identity must not change. */
  const sessionReusedRef = useRef<"session" | "storage" | null>(null);
  /** The loop is built once and reads its deps through refs, because a loop recreated on every render would restart its own round. */
  const lookupPeersRef = useRef(lookupPeers);
  lookupPeersRef.current = lookupPeers;

  /** Dismissing a preview tears the session down. Leaving it up keeps a peer attached on the host, which mints an
   *  upload transfer there and pins its foreground service for a share that was only ever looked at. */
  const closePreview = useCallback(() => {
    setPreviewVisible(false);
    setLinkError(null);
    // Closing the preview without grabbing clears the smart-regrab hint.
    setPendingPreselectionState(null);
    // The picker resolves underneath itself, so closing must kill it: a late
    // success used to re-open this modal over whatever the user moved on to.
    resolveGen.current++;
    if (resolveTimerRef.current) {
      clearTimeout(resolveTimerRef.current);
      resolveTimerRef.current = null;
    }
    void abortOpen();
    setResolving(false);
    // Never release a session this preview did not open: `engineOpenDrive` reuses the share's own drive, so
    // `sessionDriveId` can name a live re-share, and releasing it would silently stop seeding.
    if (
      sessionDriveId &&
      sessionDriveId !== DEMO_DRIVE_ID &&
      sessionReusedRef.current !== "session"
    ) {
      void deactivateDrive(sessionDriveId).catch(() => {});
    }
  }, [abortOpen, deactivateDrive, sessionDriveId]);

  /** Classify the resolved manifest against files already on disk: full match skips the preview, partial badges
   *  the known rows unchecked, none opens normally. Keyed on link AND name, never name alone. */
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
      // Manifest names carry a leading slash and stored names do not, so both sides are keyed on baseName;
      // the original manifest name is preserved so the modal's own selection checks still match.
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

  // Refresh the stored record from a resolved manifest, preserving per-file downloaded metadata by name.
  const reconcileShareRecord = useCallback(
    async (manifest: OpenLinkResult, normalizedLink: string): Promise<ReceivedShare | null> => {
      const key = extractKey(normalizedLink);
      if (!key) return null;
      const existing = await loadShare(key);
      const existingByName = new Map(
        (existing?.files ?? []).map((f) => [baseName(f.name), f]),
      );
      const manifestFiles = manifest.files ?? [];
      /** `isDownloaded` is re-probed here rather than carried forward: a file deleted outside the app must not stay
       *  "on device" forever. A probe that throws counts as absent — a needless re-grab beats claiming a missing file. */
      const onDisk = new Map<string, boolean>();
      for (const f of existingByName.values()) {
        if (!f.isDownloaded || !f.localPath || onDisk.has(f.localPath)) continue;
        try {
          onDisk.set(f.localPath, await RNFS.exists(f.localPath));
        } catch {
          // Deliberately not `false`: a thrown probe means "could not check", and recording it as gone would strip
          // the localPath, orphaning bytes that Delete could no longer unlink.
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
        /** The engine drive id is persisted because the only other share-key mapping is an in-memory index that does
         *  not survive a restart. Falling back to the existing id stops a resolve without one from erasing it. */
        driveId: manifest.driveId ?? existing?.driveId,
        /** Carried forward explicitly because this literal is a fresh record; omitting it would rely on the merge guard. */
        downloadFolder: existing?.downloadFolder,
        shareName: manifest.shareName || existing?.shareName || "Share",
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastUpdatedAt: existing?.lastUpdatedAt ?? now,
        files: reconciledFiles,
        // A resolve carries a newer file list, never a newer intent: a row the
        // user had queued or paused keeps both its status and its selection.
        status: statusAfterResolve(existing?.status, reconciledFiles),
        selection: existing?.selection,
        missing: existing?.missing,
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

  /** A resolve that found nobody becomes a row, not an error, so the user is returned to the list with a row that says what is happening. */
  // An existing record is kept as it is, so a second paste of a link already queued cannot demote it and lose its selection.
  const saveWaitingRow = useCallback(
    async (link: string, why: string) => {
      try {
        const row = await createWaitingShare(link);
        if (!row) {
          // A link with no extractable key should have been caught by the classifier, so say so rather than fail silently.
          debugLog("warn", "rn.waiting", `no key in link, no row saved (${why})`);
          return;
        }
        debugLog("info", "rn.waiting", `row saved status=${row.status} reason=${why}`);
        // The status is checked rather than assumed: promising to keep looking for a row the loop will never pick up is a plausible-but-false line.
        if (!isLoopStatus(row.status)) {
          haptics.error();
          setLinkError(noticeForResolveFailure(RESOLVE_NO_MANIFEST_MESSAGE));
          return;
        }
        setLinkError(null);
        haptics.warning();
        showToast(WAITING_SAVED_TOAST, { kind: "info" });
        // Bumped last, after the row exists: the early returns above keep the
        // sheet open so their error is visible.
        setWaitingSavedTick((n) => n + 1);
      } catch (err: unknown) {
        logStructuredError("rn.waiting", "could not save a waiting row", err);
      }
    },
    [showToast],
  );

  /** The single rejection route for a resolve whose manifest did not replicate, called at two depths so both do the same four things. */
  // The engine's update resolves on head metadata, not on blob replication, so in that window a resolve can return no manifest and sometimes files anyway.
  const rejectUnusableResolve = useCallback(
    (manifest: OpenLinkResult, where: string) => {
      // Records what the user saw, which predicate decided it, and which branch the drive took; the file count is for diagnosis and is not what was gated on.
      debugLog(
        "warn",
        "rn.resolve",
        `no-manifest resolve rejected at ${where} drive=${manifest.driveId ?? "?"} ` +
          `hasManifest=${manifest.hasManifest} files=${manifest.files?.length ?? 0} ` +
          `- gated on hasManifest (NOT files.length); showing retry copy; ` +
          `reused=${manifest.reused ?? "?"} so the drive is ${
            manifest.reused ? "deactivated only" : "purged"
          }`,
      );
      haptics.warning();
      if (manifest.driveId) {
        /** Only a store this resolve created is purged; a reused store may hold blocks the user wants, so it is deactivated instead. */
        // The reuse field is a string or absent, and the engine encodes created-by-this-call as absent, so an equality test against false would never purge.
        if (!manifest.reused) {
          void cancelTransfer(manifest.driveId, { purge: true });
        } else {
          void deactivateDrive(manifest.driveId);
        }
      }
      // Not a claim about file count, because this guard is not keyed on file count. An exported constant, not a
      // literal, so the copy deny-list can reach it; tone is a normal wait, never red.
      setLinkError(linkNotice("no-manifest", RESOLVE_NO_MANIFEST_MESSAGE));
    },
    [cancelTransfer, deactivateDrive],
  );

  const applyDedupClassification = useCallback(
    (
      kind: "full" | "partial" | "none",
      alreadyNames: string[],
      manifest: OpenLinkResult,
      normalizedLink: string,
    ) => {
      // Recorded once here rather than at the three `setSessionDriveId` calls
      // below, so the three cannot disagree about how this session was obtained.
      sessionReusedRef.current = manifest.reused ?? null;
      // Keying on file count would be wrong both ways: a share legitimately declaring zero files would read as a
      // failure, and the engine's directory-listing fallback would read as a success. Only `hasManifest` separates them.
      if (classifyResolve(manifest) !== "usable") {
        rejectUnusableResolve(manifest, "applyDedupClassification");
        return;
      }
      // A successful resolve clears the input; failures keep it so retry has something to work with.
      const clearOnSuccess = () => {
        setLinkDraftRaw("");
        setPendingPreselectionState(null);
      };
      // The picker is taking over, so the Receive sheet has to go. Bumped for
      // `full` too, which shows a toast and no preview at all.
      const handOffToPreview = (handoffKind: ResolveHandoffKind) => {
        const handoff = previewHandoffFor(handoffKind);
        setPreviewVisible(handoff.opensPreview);
        if (handoff.closesReceiveSheet) setPreviewOpenedTick((n) => n + 1);
      };
      if (kind === "full") {
        // Every manifest file is already on disk, so the preview is skipped.
        setAlreadyDownloadedNames([]);
        setSessionDriveId(manifest.driveId ?? null);
        setLastResolvedLink(normalizedLink);
        setOpenResult(manifest);
        // A resolve only lands against an announcer that answered, so this is the sender-online signal.
        setLastResolveAt(Date.now());
        handOffToPreview("full");
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
        // A resolve only lands against an announcer that answered, so this is the sender-online signal.
        setLastResolveAt(Date.now());
        handOffToPreview("partial");
        haptics.actionDone();
        // In the preview's banner, not a toast: the preview is opening in the
        // same commit, and a toast raised under it cannot be tapped.
        setLinkError(linkNotice("already-held", ALREADY_HELD_MESSAGE));
        clearOnSuccess();
        return;
      }
      // No match — open preview normally, no badges, no dedup toast.
      setAlreadyDownloadedNames([]);
      setSessionDriveId(manifest.driveId ?? null);
      setLastResolvedLink(normalizedLink);
      setOpenResult(manifest);
      setLastResolveAt(Date.now());
      handOffToPreview("none");
      haptics.actionDone();
      clearOnSuccess();
    },
    [showToast, rejectUnusableResolve],
  );

  const runResolve = useCallback(
    async (raw: string) => {
      const normalized = normalizeShareLink(raw);
      if (!normalized) {
        setLinkError(linkNotice("malformed", "That doesn't look like a PearDrop link."));
        return;
      }
      // Report "looking" synchronously: the guarded path only fires onBegin after an RPC round trip, so the picker's
      // first paint claimed no sender had been found and offered a Look again for a lookup that had not started.
      setResolving(true);
      // Dedup candidates: entries from this link whose file still exists; loadDownloaded already drops missing ones.
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
      // Storage canonicalises by share key, so a re-paste returns the record with its downloaded flags intact.
      // The disk-based path stays as a fallback for shares predating that storage.
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
        // Fall back to disk-existing items when storage yields nothing, covering a record the migration missed.
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

      // Demo link: a synthetic manifest, still classified so partial-match badges behave as they do for real shares.
      if (isDemoLink(normalized)) {
        resolveGen.current++;
        const demoResult = getDemoOpenResult();
        setResolving(false);
        setLinkError(null);
        // The demo path never touches the engine, so the engine's no-manifest gate cannot protect it; this is one of
        // the reasons the guard here has to exist, and it holds only while the demo keeps declaring a manifest.
        await disposeResolve(demoResult, {
          persist: () => reconcileAndDedup(demoResult),
          accept: (cls) =>
            applyDedupClassification(
              cls.kind,
              cls.alreadyNames,
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
        // resolveGuard stays RN-free, so the sink is
        // injected here rather than imported there.
        onLog: (level, msg) => debugLog(level, "rn.resolve", msg),
        onBegin: () => {
          setResolving(true);
          setLinkError(null);
        },
        onSuccess: async (out) => {
          if (out.driveId) {
            // Classify BEFORE persisting. Reconciling first writes an empty-file record that nothing deletes, leaving
            // a permanent zero-byte row; no change to the guard's predicate fixes that, only the ordering does.
            await disposeResolve(out, {
              persist: () => reconcileAndDedup(out),
              accept: (cls) =>
                applyDedupClassification(
                  cls.kind,
                  cls.alreadyNames,
                  out,
                  normalized,
                ),
              reject: () => rejectUnusableResolve(out, "onSuccess"),
            });
          } else {
            // Server said ok but forgot the driveId — treat as a soft failure.
            haptics.error();
            // No connectivity diagnosis in the copy: nothing here can tell an offline host from a slow lookup.
            setLinkError(
              linkNotice("missing-drive-id", "Couldn't open that link — give it another go?"),
            );
          }
        },
        onFailure: (message, cause) => {
          // Sender absent: save the link as a row rather than show an error the user can do nothing with.
          const kind = classifyResolveFailure({ cause });
          if (savesWaitingRow(kind)) {
            void saveWaitingRow(normalized, `resolve-failed:${cause ?? "none"}`);
            return;
          }
          haptics.error();
          // The engine's no-manifest rejection carries the same sentence as the guard here, so it gets the same wait tone.
          setLinkError(noticeForResolveFailure(message));
        },
        onTimeout: () => {
          // Kick off a best-effort abort so backend state doesn't leak a
          // pending open when we time out.
          void abortOpen();
          haptics.warning();
          // The 30 s timeout leaves no inline card: the app returns to the list and the wait copy goes out as a toast.
          setLinkError(null);
          // The row replaces the wait toast, because it says the same thing
          // and keeps saying it. The sheet still closes on the same tick.
          void saveWaitingRow(normalized, "resolve-timeout");
          setResolveTimeoutTick((n) => n + 1);
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
      // The timeout's wait copy is now the saved row's toast, which
      // `saveWaitingRow` owns — so that is the dependency, not `showToast`.
      saveWaitingRow,
    ],
  );

  // Mirrors the committed draft for `resolveFromScan`. Declared before the
  // debounce effect so the value is already current when that effect runs.
  useEffect(() => {
    linkDraftRef.current = linkDraft;
  }, [linkDraft]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Position is the mechanism: above the clearTimeout this leaves a stale
    // timer armed, below the setTimeout it prevents nothing.
    if (draftWrittenByScanRef.current === linkDraft) {
      draftWrittenByScanRef.current = null;
      return;
    }
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
    async (text: string, opts?: { writeDraft?: boolean }) => {
      setQrVisible(false);
      if (opts?.writeDraft) {
        // One string for both so the guard cannot miss on normalisation; ref first, before the effect reads the draft.
        const shown = normalizeShareLink(text);
        // Arm the one-shot only when the write really changes the draft. Re-writing the value already in the input is
        // a no-op setter, so the ref is never consumed and would swallow the next resolve the user did ask for.
        if (shown !== linkDraftRef.current) {
          draftWrittenByScanRef.current = shown;
          setLinkDraftRaw(shown);
        }
      }
      await runResolve(text);
    },
    [runResolve]
  );

  const retryResolve = useCallback(async () => {
    if (!linkDraft.trim()) return;
    await runResolve(linkDraft);
  }, [linkDraft, runResolve]);

  /** Look again from the reopen picker, which `retryResolve` cannot serve because it reads a draft that path never
   *  writes. The re-entry guard is load-bearing: a second concurrent resolve aborts the first and leaks its session. */
  const relookupPreview = useCallback(async () => {
    // A ref, not the state flag: that is set a commit later, so two quick taps both passed it and stranded a drive.
    if (relookupInFlightRef.current) return;
    if (!lastResolvedLink) return;
    relookupInFlightRef.current = true;
    try {
      await runResolve(lastResolvedLink);
    } finally {
      relookupInFlightRef.current = false;
    }
  }, [lastResolvedLink, runResolve]);

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

  /** The one writer of an after-grab status, and the one place the transition is logged, so an export cannot miss one. */
  // A stall with the peer attached is the one failure the waiting loop cannot help with; one timer per share, replaced not stacked.
  const retryNowRef = useRef<(shareKey: string) => Promise<boolean>>(
    async () => false,
  );
  const stallTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const scheduleStallRetry = useCallback(
    (shareKey: string, state: RowLifecycleState) => {
      const existing = stallTimersRef.current.get(shareKey);
      if (existing) {
        clearTimeout(existing);
        stallTimersRef.current.delete(shareKey);
      }
      const plan = planStallRetry(state, Date.now());
      if (plan.at === null) return;
      const delay = Math.max(0, plan.at - Date.now());
      debugLog(
        "info",
        "rowstate",
        `rowstate retry key=${shareKey.slice(0, 6)} attempt=${plan.attempt} in=${delay}ms`,
      );
      stallTimersRef.current.set(
        shareKey,
        setTimeout(() => {
          stallTimersRef.current.delete(shareKey);
          void retryNowRef.current(shareKey);
        }, delay),
      );
    },
    [],
  );

  // Every pending timer dies with the provider, so a retry cannot fire into an
  // unmounted tree.
  useEffect(
    () => () => {
      for (const timer of stallTimersRef.current.values()) clearTimeout(timer);
      stallTimersRef.current.clear();
    },
    [],
  );

  const applyRowEvent = useCallback(
    async (shareKey: string, event: RowLifecycleEvent): Promise<void> => {
      const key = String(shareKey || "").toLowerCase();
      if (!key) return;
      try {
        const share = await loadShare(key);
        if (!share) return;
        const before = rowLifecycleFromShare(share);
        const { state, log } = rowLifecycle(before, event, { shareKey: key });
        // `log === null` is the reducer saying nothing moved. Writing anyway
        // would bump `lastUpdatedAt` and reset the seven-day clock on a no-op.
        if (!log) return;
        /** A moved percentage is not a transition: the percentage is recomputed on every read, so an event that only advanced the bar has nothing to write. */
        // Gated on the persisted set, so the log and the write agree by construction: if there is nothing to store, there is nothing to say.
        const sameSelection =
          before.selection.length === state.selection.length &&
          before.selection.every((n, i) => n === state.selection[i]);
        const movedSomethingStored =
          before.status !== state.status ||
          before.pauseReason !== state.pauseReason ||
          before.stallRetries !== state.stallRetries ||
          !sameSelection;
        if (!movedSomethingStored) return;
        debugLog("info", "rowstate", log);
        /** Expiry is never stored, because it is a function of the timestamp and a stored value would still read expired after the record moved on. */
        if (state.status === "expired") return;
        await patchShare(key, {
          status: state.status,
          selection: state.selection.length > 0 ? [...state.selection] : undefined,
          pauseReason: state.pauseReason ?? undefined,
          stallRetries: state.stallRetries,
        });
        // After the write, so the retry re-reads the row just persisted; a no-op returned above.
        scheduleStallRetry(key, state);
      } catch (err: unknown) {
        logStructuredError("rowstate", "could not record a row transition", err);
      }
    },
    [scheduleStallRetry],
  );

  /** Drive to share key, for the two paths that start a download. */
  // The derived index cannot serve here: a received drive is absent from the engine's drive list until its download has already finished.
  const driveToShareRef = useRef<Map<string, string>>(new Map());

  /** One bound drive per row. Binding supersedes, so a share has at most one drive and it is the one it is bound to now, not the newest seen. */
  // Append-only, a share accumulated a drive id per resolve and the progress driver drove one row from all of them at once, dead drives included.
  const bindDriveToShare = useCallback((driveId: string, shareKey: string) => {
    const key = String(shareKey || "").toLowerCase();
    if (!driveId || !key) return;
    for (const [id, boundKey] of driveToShareRef.current) {
      if (boundKey === key && id !== driveId) driveToShareRef.current.delete(id);
    }
    driveToShareRef.current.set(driveId, key);
  }, []);

  /** The open picker's share, re-read on every storage write, so the picker follows the same single source of truth the row does. */
  const [pickerShare, setPickerShare] = useState<ReceivedShare | null>(null);

  /** When the last resolve landed, and a one-second clock while the picker is open. */
  // The model is a pure function of the time, and a peer that leaves emits one event and then silence, so a model recomputed only on an event cannot notice silence.
  const [lastResolveAt, setLastResolveAt] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!previewVisible) return undefined;
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [previewVisible]);
  useEffect(() => {
    const key = lastResolvedLink ? extractKey(lastResolvedLink) : null;
    if (!previewVisible || !key) {
      setPickerShare(null);
      return;
    }
    let alive = true;
    const refresh = () => {
      void loadShare(key).then((s) => {
        if (alive) setPickerShare(s);
      });
    };
    refresh();
    const off = subscribeShares(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [previewVisible, lastResolvedLink]);

  /** Progress moves a row to downloading; first byte is applied first so a stray event cannot start one while queued. */
  // Landed files are tracked per share and keyed by path, because the sweep re-runs every second.
  const landedAppliedRef = useRef<Map<string, Set<string>>>(new Map());

  /** A file is marked saved only on the engine's completion event, one file at a time as it lands. */
  // The saved count derives from the record's flags, whose only writer ran after the whole grab returned, so the count sat at zero and then jumped.
  const applyFilesLanded = useCallback(
    async (shareKey: string, transfer: TransferSummary): Promise<void> => {
      const key = String(shareKey || "").toLowerCase();
      if (!key) return;
      const landed = transfer.filesLanded;
      if (!landed || landed.length === 0) return;
      let applied = landedAppliedRef.current.get(key);
      if (!applied) {
        applied = new Set<string>();
        landedAppliedRef.current.set(key, applied);
      }
      for (const file of landed) {
        if (applied.has(file.localPath)) continue;
        // Claimed before the await: the sweep can re-enter while this promise is open, and a claim made on completion would let the second pass rewrite the file.
        applied.add(file.localPath);
        try {
          await markFilesDownloaded(key, [
            { name: file.name, localPath: file.localPath, size: file.size },
          ]);
          await applyRowEvent(key, { type: "FILE_DONE", file: file.name });
        } catch (err: unknown) {
          // Released, so the next sweep retries. A file on disk that the
          // record does not know about reads to the user as a lost file.
          applied.delete(file.localPath);
          logStructuredError("rowstate", "could not record a landed file", err);
        }
      }
    },
    [applyRowEvent],
  );

  /** Bytes seen on the previous progress tick, per share. */
  const lastProgressBytesRef = useRef<Map<string, number>>(new Map());

  const applyRowProgress = useCallback(
    async (shareKey: string, transfer: TransferSummary): Promise<void> => {
      const key = String(shareKey || "").toLowerCase();
      if (!key) return;
      // FIRST_BYTE is an edge: testing a cumulative total stayed true forever and re-fired every tick, un-pausing at 1 Hz.
      const seen = Number(transfer.bytesFromPeers ?? 0);
      const prev = lastProgressBytesRef.current.get(key);
      lastProgressBytesRef.current.set(key, seen);
      // A decrease is a per-download counter reset, not lost bytes; without
      // this a resumed transfer would never un-pause.
      const grew = prev !== undefined && seen > prev;
      const restarted = prev !== undefined && seen < prev;
      const firstEver = prev === undefined;
      const advanced = seen > 0 && (grew || restarted || firstEver);
      if (!advanced) return;
      await applyRowEvent(key, { type: "FIRST_BYTE" });
      try {
        const share = await loadShare(key);
        if (!share) return;
        const derived = rowLifecycleFromShare(share, transfer);
        await applyRowEvent(key, {
          type: "BYTES",
          pct: derived.pct,
          filesDone: derived.filesDone,
        });
      } catch (err: unknown) {
        logStructuredError("rowstate", "could not record progress", err);
      }
    },
    [applyRowEvent],
  );

  /** Where a grab ends, decided from the disk and nowhere else, through the one terminal both grab paths share. */
  // The engine's reply reports what it attempted; only the record knows what survived to disk. Short of the selection is a pause, never a failure.
  const settleGrabTerminal = useCallback(
    async (shareKey: string, chosenNames: readonly string[]): Promise<void> => {
      const chosen = chosenNames.map((n) => baseName(n));
      if (chosen.length === 0) return;
      const settled = await loadShare(shareKey);
      const held = new Set(
        (settled?.files ?? [])
          .filter((f) => f.isDownloaded && f.localPath)
          .map((f) => baseName(f.name)),
      );
      const savedCount = chosen.filter((n) => held.has(n)).length;
      await applyRowEvent(
        shareKey,
        savedCount >= chosen.length
          ? { type: "ALL_DONE", filesDone: savedCount }
          : { type: "PEER_LOST" },
      );
    },
    [applyRowEvent],
  );

  /** Ask the model whether this row should be paused, and dispatch if so; the decision is the model's, so one rule lives in one place. */
  const maybePauseOnPeerLoss = useCallback(
    async (shareKey: string, transfer: TransferSummary): Promise<void> => {
      try {
        const share = await loadShare(shareKey);
        if (!share) return;
        const view = shareView({
          record: share,
          transfer,
          lookup: null,
          now: Date.now(),
        });
        if (!view.shouldPause) return;
        /** Which pause: the peer count at the moment of the silence verdict is what separates "the link went bad" from "the sender went away". */
        // The verdict fires on silence whether or not a peer still looks attached, and a peer still on the books with nothing moving is the first case.
        const peersAttached = (transfer.peersConnected ?? 0) > 0;
        // One event carrying the peer count, so the reducer keeps the stalled/offline decision in one place.
        await applyRowEvent(shareKey, { type: "STALLED", peersAttached });
      } catch (err: unknown) {
        logStructuredError("rowstate", "could not apply the peer-loss pause", err);
      }
    },
    [applyRowEvent],
  );

  /** The pause read, on the peer-loss rule, checked on the clock as well as on the event. */
  // A peer that leaves emits one event then silence, so an event-only bridge cannot notice the window passing.
  const [pauseTick, setPauseTick] = useState(0);
  useEffect(() => {
    const watching = transfers.some(
      (t) => t.origin === "received" && (t.peersConnected ?? 0) === 0,
    );
    if (!watching) return undefined;
    const id = setInterval(() => setPauseTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [transfers]);

  /** One pass per transfers update or per tick; the engine's coalescer already holds progress well below that. */
  useEffect(() => {
    for (const t of transfers) {
      if (t.origin !== "received") continue;
      const key = driveToShareRef.current.get(t.driveId);
      if (!key) continue;
      // Sequential, not raced: a file landing this pass must be written before the count is taken.
      void (async () => {
        await applyFilesLanded(key, t);
        await applyRowProgress(key, t);
      })();
      void maybePauseOnPeerLoss(key, t);
    }
  }, [
    transfers,
    applyFilesLanded,
    applyRowProgress,
    maybePauseOnPeerLoss,
    pauseTick,
  ]);

  /** The grab toast, on a two-second fuse, keyed by share so a second tap cannot leave the first tap's timer to announce a queue that has since started moving. */
  const grabToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armGrabToast = useCallback(
    (shareKey: string) => {
      if (grabToastTimerRef.current) clearTimeout(grabToastTimerRef.current);
      grabToastTimerRef.current = setTimeout(() => {
        grabToastTimerRef.current = null;
        void (async () => {
          // Re-read rather than trusting a captured value: the whole point is
          // whether a byte landed in the last two seconds.
          const fresh = await loadShare(shareKey);
          if (!fresh || fresh.status !== "queued") return;
          showToast(GRAB_QUEUED_TOAST, { kind: "info" });
        })();
      }, GRAB_TOAST_DELAY_MS);
    },
    [showToast],
  );

  const runDownload = useCallback(
    async (fileNames?: string[]) => {
      /** `queued` is written here, before anything that can take a round trip, because otherwise nothing wrote a status until the grab had already finished. */
      // Fire-and-forget on purpose: the write must not be something the user's tap waits on, and the reducer has already decided the status.
      const grabKeyAtTap = lastResolvedLink ? extractKey(lastResolvedLink) : null;
      const grabSelection =
        fileNames && fileNames.length
          ? fileNames
          : (openResult?.files || []).map((f) => f.name);
      if (grabKeyAtTap && grabSelection.length > 0) {
        // The first grab IS a confirmed selection; `add` carries all of it.
        void applyRowEvent(grabKeyAtTap, {
          type: "SELECTION_CONFIRMED",
          diff: { add: grabSelection },
        });
        // The notification ask has to precede the dismissal, and the picker now closes on the tap, so it is raised here; the order is asserted by a test.
        // Still fire-and-forget: the grab, the dismissal and the row's status must not wait on an OS dialog, and a denial stays silent by design.
        void ensureNotificationPermission();
        setPreviewVisible(false);
        setLinkError(null);
        // Only if no byte arrives in two seconds, or it announces queuing that never happened.
        armGrabToast(grabKeyAtTap);
      }
      /** Reachable: the picker opens from disk with no session while the resolve runs, so a silent return here is a dead Grab button. */
      if (!sessionDriveId) {
        // Opened from disk with no sender yet, so the selection is kept rather than refused; the toast is fused on the tap.
        if (grabKeyAtTap && grabSelection.length > 0) {
          // They have just asked for these files, so the grab that follows is the one worth announcing.
          void ensureNotificationPermission();
          return;
        }
        // Wait tone, not error: "still looking" in red is the defect this removed. Unreachable backstop — Grab is
        // disabled until the lookup reaches found — kept because a guard only its caller remembers is not a guard.
        setLinkError(linkNotice("still-resolving", STILL_RESOLVING_MESSAGE));
        return;
      }
      // The pairing the progress bridge above needs, recorded before the
      // first byte can arrive.
      if (grabKeyAtTap) bindDriveToShare(sessionDriveId, grabKeyAtTap);
      setDownloadAllBusy(true);
      setLinkError(null);
      // A new attempt is not the previous one's failure, cleared here rather than on open so a reopened picker still shows why the last grab did not start.
      setGrabFailed(false);
      let grabErrored = false;
      // The receive path's own permission ask: without it a receive-only user is never prompted in the foreground.
      // Fire-and-forget, because the grab must not wait on an OS dialog and a denial stays silent by design.
      void ensureNotificationPermission();
      // Close the preview before starting, or the modal covers the screen for the whole fetch with no progress shown.
      setPreviewVisible(false);
      // Claimed for the whole grab so the loop cannot start a second download for this share; released in the finally.
      const busyKey = lastResolvedLink ? extractKey(lastResolvedLink) : null;
      if (busyKey) busyRowsRef.current.add(busyKey);
      try {
        // Split into already-held and needs-fetching: re-fetching a held file would write `name (1)` beside it.
        const allManifestNames = (openResult?.files || []).map((f) => f.name);
        const targetNames =
          fileNames && fileNames.length ? fileNames : allManifestNames;
        /** One fetch/keep rule fed by both notions of "already held". The resolve-populated set alone is not enough:
         *  a grab that skipped a resolve would re-fetch everything and leave `name (1)` duplicates by construction. */
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
        // An empty target list is an empty grab: `partitionGrabNames` reads "no names" as "everything in the share".
        const { fetch: fetchNames, keep: keepNames } = targetNames.length
          ? partitionGrabNames(
              [...(storedRecord?.files ?? []), ...legacyHeld],
              targetNames,
            )
          : { fetch: [] as string[], keep: [] as string[] };

        const isDemo = sessionDriveId === DEMO_DRIVE_ID;
        /** The folder the engine wrote into, persisted so a re-grab and the row's "where did these go" can read it. */
        let grabDestDir: string | undefined;
        let fetchedFiles: { name: string; path: string; size: number }[] = [];
        /** Per-file casualties: the engine continues past a failed file and still returns ok, so ok does not mean the
         *  whole share arrived. Carried out to the completion toast. */
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
          // reported on the cancelled shape as well as the ok one, so a
          // stopped grab still records where its survivors landed.
          grabDestDir = (out as { destDir?: string }).destDir || undefined;
          // A cancel is reported before the failure branch: it returns ok with zero files, and treating that as a
          // failure raised an error the user never had and invited them to retry what they just stopped.
          if (isLiveSessionRefusal(out)) {
            debugLog(
              "info",
              "rn.grab",
              `grab skipped drive=${sessionDriveId} - a session is already running for it`,
            );
            grabErrored = true;
            return;
          }
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
              // Found nobody is a wait, not an error: a grab whose files all stalled returns ok with no top-level error.
              const grabKind = classifyGrabFailure({
                cause: errorCause(out.error),
                fileCauses: (out.failed ?? []).map(
                  (f) => (f as { cause?: string }).cause,
                ),
                peersConnected: (out as { peersConnected?: number }).peersConnected ?? 0,
              });
              /** Every failure is a pause, and the classifier decides only which reason the row names, never whether the row survives. */
              // A stall against a peer that is right there is not something waiting for a sender will fix, so it takes the short retry rather than the loop's cadence.
              const peersAttached =
                ((out as { peersConnected?: number }).peersConnected ?? 0) > 0;
              if (grabKeyAtTap) {
                await applyRowEvent(grabKeyAtTap, {
                  type: "STALLED",
                  peersAttached,
                });
                debugLog(
                  "info",
                  "rn.waiting",
                  `grab paused - ${errorCause(out.error) ?? "no-peer"} kind=${grabKind} ` +
                    `peers=${peersAttached ? "yes" : "no"}`,
                );
              }
              haptics.warning();
              // Kept so reopening the picker shows what was asked for.
              grabErrored = true;
              setPendingPreselectionState(
                targetNames.length > 0 ? [...targetNames] : null,
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
          /** The order is the fix: two files cannot be written atomically, so the store the rendered list is built from goes first. */
          // The try/catch stays off the results append, because that throw must escape into the outer handler rather than be swallowed here.
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
            /** Its own call, after the record write: folding session facts into a reconstructed record is how the
             *  spread erases fields. The demo drive is excluded, having no engine id to be reopened by. */
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

        /** Where the row lands once the grab is over. A cancel clears the selection; per-file casualties are a pause. */
        // The engine carries on past a stalled file and returns success with the survivors, so a non-empty failure list is the only in-band signal the sender went away.
        const terminalKey = lastResolvedLink ? extractKey(lastResolvedLink) : null;
        if (terminalKey) {
          // A cancel drops the selection and leaves the after-grab cycle.
          if (wasCancelled) {
            // A user stop keeps the selection and the percentage so the picker can offer Resume.
            await applyRowEvent(terminalKey, { type: "USER_STOP" });
          } else if (failedCount > 0) {
            // Per-file casualties are the only in-band signal that the sender went away mid-transfer.
            await applyRowEvent(terminalKey, { type: "PEER_LOST" });
          } else {
            // `done` is claimed from the record, never from the request, and through the one terminal both grab paths share.
            await settleGrabTerminal(terminalKey, targetNames);
          }
        }

        if (keepNames.length > 0) {
          const labels = keepNames.map((n) => baseName(n));
          const msg =
            labels.length === 1
              ? `Kept your existing copy of ${labels[0]}`
              : `Kept your existing copies of ${labels.join(", ")}`;
          showToast(msg);
        }

        // One completion signal per grab whether or not bytes moved, so re-grabbing held files still answers the tap.
        const sharedKeyAny = lastResolvedLink ? extractKey(lastResolvedLink) : null;
        const acknowledgedNames = [
          ...fetchedFiles.map((f) => baseName(f.name)),
          ...keepNames.map((n) => baseName(n)),
        ];
        // A cancel must always be answered, even when it beat the first file, so it bypasses the length guard.
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

        // Real grabs get their toast from the completion effect; the demo never produces a transfer, so it toasts here.
        if (isDemo && fetchedFiles.length > 0) {
          haptics.success();
          showToast("Got it — demo files saved", { kind: "success" });
        }
      } catch (e: unknown) {
        const raw = String((e as Error)?.message || e);
        setLinkError(
          linkNotice(
            "generic-throw",
            devMode ? raw : "Something went sideways — give it another go?",
          ),
        );
      } finally {
        setDownloadAllBusy(false);
        if (busyKey) busyRowsRef.current.delete(busyKey);
        // The regrab hint is spent once a grab fires, unless it failed and is still carrying the wanted selection.
        if (!grabErrored) setPendingPreselectionState(null);
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
      applyRowEvent,
      armGrabToast,
      bindDriveToShare,
      // `linkError` was here solely for the no-session guard's `if (!linkError)`.
      // That read is gone, so the dep is too.
    ],
  );

  /** Reopens a received share's picker from what is already on disk, because the open result was only ever produced after a live resolve. */
  // The bytes still come from the peer, so a resolve runs alongside and upgrades in place; the session id stays null so dismissing cannot tear down a drive it never opened.
  const openStoredSharePicker = useCallback(
    (share: ReceivedShare) => {
      // Repeated here because a guard that only holds while its one caller remembers it is not a guard.
      if (!share || share.files.length === 0) return;
      setAlreadyDownloadedNames(heldNames(share.files));
      setSessionDriveId(null);
      // No session yet, so there is nothing reused to protect; the parallel
      // resolve below sets this for real when it lands.
      sessionReusedRef.current = null;
      setLastResolvedLink(share.shareLink);
      setOpenResult(storedShareToOpenResult(share));
      // The stored list is not a sender signal - no announcer was reached to
      // produce it. The parallel `runResolve` below stamps the real one.
      setLastResolveAt(0);
      setLinkError(null);
      setPreviewVisible(true);
      haptics.actionDone();
      void runResolve(share.shareLink);
    },
    [runResolve],
  );

  /** A queued or paused row, resumed because the sender turned up. */
  // It bypasses the picker's own resolve and download paths deliberately: those carry the picker's React state, and a loop-driven grab that wrote them would change what the user is looking at.
  const resumeWaitingRow = useCallback(
    async (share: ReceivedShare) => {
      const selection = share.selection ?? [];
      if (selection.length === 0) return;
      const out = await openLink(share.shareLink);
      if (!out?.ok || !out.driveId) {
        debugLog("warn", "rn.waiting", `resume resolve failed for ${share.shareKey.slice(0, 8)}`);
        return;
      }
      const latestPaths = (out.files ?? []).map((f) => f.name);
      /** An empty manifest is inconclusive, never evidence the files went away: classifying against it drops the selection for good. */
      // Returning leaves the row as it is; the loop tries again.
      if (latestPaths.length === 0) {
        debugLog(
          "info",
          "rn.waiting",
          `resume inconclusive for ${share.shareKey.slice(0, 8)} - no file list, selection kept`,
        );
        return;
      }
      const { present, missing } = matchSelection(selection, latestPaths);
      if (missing.length > 0) {
        debugLog(
          "info",
          "rn.waiting",
          `${missing.length} selected file(s) are gone from the latest version`,
        );
      }
      if (present.length === 0) {
        // Nothing left to fetch, so the status settles rather than staying queued against a selection it cannot meet.
        await patchShare(share.shareKey, { status: "ready", selection: undefined, missing });
        return;
      }
      // `downloading` is not written here. Written before a byte moved, the row fell through to a stale transfer carrying the previous attempt's failure.
      // The row stays queued or paused until the progress bridge sees a byte, which is the reducer's rule and the honest one.
      bindDriveToShare(out.driveId, share.shareKey);
      await applyRowEvent(share.shareKey, { type: "LOOKUP_FOUND" });
      if (missing.length > 0) await patchShare(share.shareKey, { missing });
      showToast(resumedToast(out.shareName || share.shareName), { kind: "info" });

      /** The same fetch-and-keep split the user-started grab does. */
      // Handing the whole surviving selection over on every resumed round re-fetched files already on disk, which collide into suffixed names and a new record entry each time.
      const { fetch: resumeFetch, keep: resumeKeep } = partitionGrabNames(
        share.files,
        present,
      );
      if (resumeFetch.length === 0) {
        // Everything selected is held, so settle here rather than call the engine and re-fetch what is on disk.
        await settleGrabTerminal(share.shareKey, present);
        return;
      }
      const dl = await startDownload({ driveId: out.driveId, fileNames: resumeFetch });
      /** The common case after a stall, and the one that was writing `paused` over a live download. */
      // The previous session is still alive and waiting for blocks, so this download is refused; returning leaves the status exactly as it is.
      if (isLiveSessionRefusal(dl)) {
        debugLog(
          "info",
          "rn.waiting",
          `resume skipped ${share.shareKey.slice(0, 8)} - its session is already live`,
        );
        return;
      }
      const got = dl?.files ?? [];
      if (got.length > 0) {
        try {
          await markFilesDownloaded(
            share.shareKey,
            got.map((f) => ({ name: f.name, localPath: f.path, size: f.size })),
          );
          await rememberDriveSession(share.shareKey, {
            driveId: out.driveId,
            downloadFolder: (dl as { destDir?: string }).destDir ?? null,
          });
          await appendDownloadResults(got, share.shareLink);
          const bytes = got.reduce((acc, f) => acc + (f.size ?? 0), 0);
          if (bytes > 0) void addReceived(bytes);
        } catch (err: unknown) {
          logStructuredError("rn.waiting", "could not record a resumed grab", err);
        }
      }
      /** The one terminal, measured against the whole selection rather than the engine's reply, which reports what was attempted and not what reached disk. */
      // The kept files are part of the answer to "do I hold everything the user chose", even though this round did not request them.
      await settleGrabTerminal(share.shareKey, present);
    },
    [
      openLink,
      showToast,
      startDownload,
      applyRowEvent,
      settleGrabTerminal,
      bindDriveToShare,
    ],
  );

  /** The loop's per-row action: a row with no file list resolves and stops there, because choosing stays the user's move; a row carrying the decision resumes. */
  const onSenderFound = useCallback(
    async (row: WaitingRow) => {
      const share = await loadShare(row.shareKey);
      if (!share) return;
      if (share.status === "waiting") {
        const out = await openLink(share.shareLink);
        if (!out?.ok) {
          debugLog("warn", "rn.waiting", `lookup found a peer but the resolve did not land`);
          return;
        }
        await reconcileShareRecord(out, share.shareLink);
        showToast(senderAvailableToast(out.shareName || share.shareName), { kind: "info" });
        haptics.actionDone();
        return;
      }
      await resumeWaitingRow(share);
    },
    [openLink, reconcileShareRecord, resumeWaitingRow, showToast],
  );

  const onSenderFoundRef = useRef(onSenderFound);
  onSenderFoundRef.current = onSenderFound;

  const waitingLoopRef = useRef<WaitingLoop | null>(null);
  if (!waitingLoopRef.current) {
    waitingLoopRef.current = createWaitingLoop({
      now: () => Date.now(),
      loadRows: async () =>
        (await loadShares()).map((s) => ({
          shareKey: s.shareKey,
          status: s.status,
          lastUpdatedAt: s.lastUpdatedAt,
          lastCheckedAt: s.lastCheckedAt,
          emptyChecks: s.emptyChecks,
          // The user's confirmed instruction, carried to the loop so a row
          // holding one is never backed off. See COMMITTED_INTERVAL_MS.
          committed: (s.selection?.length ?? 0) > 0,
        })),
      lookup: (keys) => lookupPeersRef.current(keys),
      onFound: (row) => onSenderFoundRef.current(row),
      // `touch: false` is the whole of "a lookup is not progress": bumping it here would stop anything ever expiring.
      onChecked: async (shareKey, found, at) => {
        const prev = await loadShare(shareKey);
        await patchShare(shareKey, {
          lastCheckedAt: at,
          emptyChecks: found ? 0 : (prev?.emptyChecks ?? 0) + 1,
          touch: false,
        });
      },
      onExpired: async (row) => {
        // Terminal, and the row's line comes from the expiry check, which reads `lastUpdatedAt` directly.
        debugLog("info", "rn.waiting", `row ${row.shareKey.slice(0, 8)} stopped waiting`);
        await applyRowEvent(row.shareKey, { type: "STOP_WAITING" });
      },
      onBackoffReset: async (shareKey) => {
        await patchShare(shareKey, { emptyChecks: 0, lastCheckedAt: undefined, touch: false });
      },
      isBusy: (shareKey) => busyRowsRef.current.has(shareKey),
      log: (level, msg) => debugLog(level, "rn.waiting", msg),
    });
  }

  // The loop runs only while the app is visible — mode A. `releaseLookup` on
  // the background transition is the engine half of the same rule.
  useEffect(() => {
    const loop = waitingLoopRef.current;
    if (!loop) return;
    if (ready && appActive) loop.start();
    else loop.stop();
    return () => loop.stop();
  }, [ready, appActive]);

  /** A record stored in flight when the process died is paused as a restart, not blamed on the sender. */
  // Once per process, gated through a ref, or a second sweep re-pauses a row that had legitimately resumed.
  const restartSweptRef = useRef(false);
  useEffect(() => {
    if (!ready || restartSweptRef.current) return;
    restartSweptRef.current = true;
    void (async () => {
      try {
        const rows = await loadShares();
        const inFlight = rows.filter(
          (s) => s.status === "downloading" || s.status === "queued",
        );
        if (inFlight.length === 0) return;
        debugLog(
          "info",
          "rowstate",
          `restart sweep: ${inFlight.length} row(s) were in flight`,
        );
        // Sequential, not parallel: these are read-modify-writes against one JSON file and concurrent writers lose updates.
        for (const row of inFlight) {
          await applyRowEvent(row.shareKey, { type: "APP_RESTARTED" });
        }
      } catch (err: unknown) {
        logStructuredError("rowstate", "could not sweep rows after a restart", err);
      }
    })();
  }, [ready, applyRowEvent]);

  /** A row downloading with no live session for more than one loop tick is paused as reconnecting. */
  // Two consecutive misses, not one: the gap between sessions is a normal part of a resume, and pausing inside it flaps.
  const sessionMissRef = useRef<Map<string, number>>(new Map());
  // The interval callback is created once and would otherwise close over the
  // first render's `transfers`. Assigned every render, read inside the tick.
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        try {
          const rows = await loadShares();
          const live = new Set<string>();
          for (const t of transfersRef.current) {
            if (t.origin !== "received") continue;
            const key = driveToShareRef.current.get(t.driveId);
            if (key) live.add(key);
          }
          const misses = sessionMissRef.current;
          // A row that is not downloading must not keep a count, or a row that finishes and downloads again inherits the first run's misses and pauses on its first tick.
          for (const key of [...misses.keys()]) {
            if (!rows.some((s) => s.shareKey === key && s.status === "downloading")) {
              misses.delete(key);
            }
          }
          for (const row of rows) {
            if (row.status !== "downloading") continue;
            if (live.has(row.shareKey)) {
              misses.delete(row.shareKey);
              continue;
            }
            const n = (misses.get(row.shareKey) ?? 0) + 1;
            misses.set(row.shareKey, n);
            if (n < 2) continue;
            misses.delete(row.shareKey);
            debugLog(
              "warn",
              "rowstate",
              `reconcile: ${row.shareKey} claims downloading with no engine session ` +
                `for ${n} ticks - pausing as reconnecting`,
            );
            await applyRowEvent(row.shareKey, { type: "SESSION_LOST" });
          }
        } catch (err: unknown) {
          logStructuredError("rowstate", "could not reconcile a stranded row", err);
        }
      })();
      // The loop's own tick, imported not repeated, or "more than one tick" means whatever this file last guessed.
    }, TICK_MS);
    return () => clearInterval(id);
  }, [applyRowEvent]);

  const retryWaitingRow = useCallback(async (shareKey: string) => {
    await waitingLoopRef.current?.retryNow(shareKey);
  }, []);

  // Closes the ref `scheduleStallRetry` reaches the loop through. Assigned on
  // every render so it can never point at a torn-down loop.
  retryNowRef.current = async (shareKey: string) =>
    (await waitingLoopRef.current?.retryNow(shareKey)) ?? false;

  /** Stop waiting. Downloaded files stay; a waiting row has nothing downloaded by construction, so it is removed rather than left as a row that does nothing. */
  const stopWaitingRow = useCallback(async (shareKey: string) => {
    const share = await loadShare(shareKey);
    if (!share) return;
    if (share.status === "waiting" && share.files.length === 0) {
      await deleteShare(shareKey);
      return;
    }
    await applyRowEvent(shareKey, { type: "STOP_WAITING" });
  }, [applyRowEvent]);

  /** Every surface reads one percentage, from held bytes, so the picker resolves the transfer exactly as the row does. */
  // The index cannot see a received drive before its first completion, so the session id stays a live overlay.
  const pickerTransfer = useMemo(() => {
    const key = lastResolvedLink ? extractKey(lastResolvedLink) : null;
    if (!key) return null;
    const byDriveId = new Map(transfers.map((t) => [t.driveId, t]));
    const index = buildShareKeyDriveIndex(drives, {
      shareKey: key,
      driveId: sessionDriveId,
    });
    return resolveReceivedTransfer(key, index, byDriveId) ?? null;
  }, [transfers, drives, sessionDriveId, lastResolvedLink]);

  /** The record the model reads, synthesised when the share is not on disk yet. */
  // Giving that case its own rendering path is how the picker acquired a second source of truth, so it gets a `ready` record and goes through the same model.
  const pickerRecord = useMemo((): ShareRecordLike | null => {
    if (pickerShare) return pickerShare;
    if (!previewVisible || !openResult) return null;
    /** Synthesised only for a share with no record on disk, because the stand-in says nothing is chosen and the draft seeds its ticks exactly once. */
    // Without the guard a queued share opened with every box empty and the wrong button, since the real record arrives a frame later.
    return {
      status: "ready",
      files: (openResult.files ?? []).map((f) => ({
        name: f.name,
        size: f.size ?? 0,
        isDownloaded: alreadyDownloadedNames.includes(f.name),
        // No record on disk yet, so no path to open. The real record carries
        // one and replaces this the moment `loadShare` lands.
        localPath: null,
      })),
      selection: undefined,
      lastUpdatedAt: Date.now(),
    };
  }, [pickerShare, previewVisible, openResult, alreadyDownloadedNames]);

  /** Is the real record still in flight? The picker holds its tick seeding until this is false, which stops a draft seeding off the synthesised record above. */
  const pickerHydrating = previewVisible && pickerShare === null && !!lastResolvedLink;

  /** The sender signal, from the same function the row uses. */
  // Reading it off the mere presence of a file list was the disagreement: a list is also built from disk and reaches no announcer, so it never implied the sender was there.
  const pickerLookup = useMemo(
    () => senderLookupFor(pickerShare) ?? (lastResolveAt > 0 ? { found: true, at: lastResolveAt } : null),
    [pickerShare, lastResolveAt],
  );

  /** The anti-flap hold, carried across renders in a ref and keyed by share so reopening on a different share starts clean. */
  // A ref rather than state, because a hold that re-rendered on every decision would be a second clock.
  const flapHoldsRef = useRef<Map<string, FlapHold>>(new Map());

  const pickerView = useMemo(() => {
    if (!pickerRecord) return null;
    const key = lastResolvedLink ? extractKey(lastResolvedLink) : null;
    const view = shareView({
      record: pickerRecord,
      transfer: pickerTransfer,
      lookup: pickerLookup,
      now: nowTick,
      hold: key ? (flapHoldsRef.current.get(key) ?? null) : null,
    });
    if (key) flapHoldsRef.current.set(key, view.hold);
    return view;
  }, [pickerRecord, pickerTransfer, pickerLookup, nowTick, lastResolvedLink]);

  // The guessed active key is gone: inferring the first selected file not on disk is right only while the engine fetches in manifest order and skips nothing.

  /** The one selection write, on confirm: writing a tick straight through stopped the in-flight file with no way back. */
  // The draft arrives as a diff, because unticking the downloading file is a different instruction from dropping it.
  const confirmSelection = useCallback(
    async (diff: SelectionDiff) => {
      const key = lastResolvedLink ? extractKey(lastResolvedLink) : null;
      if (!key) return;
      const stop = diff.stop ?? [];
      /** A user stop never deletes data; only deleting the row purges. The stopped file's blocks stay, which is what makes re-ticking a resume. */
      // The non-purging handle: the purging one, called with no options, destroyed every other file in the share.
      if (stop.length > 0 && sessionDriveId) {
        try {
          await cancelInFlight(sessionDriveId);
        } catch (err: unknown) {
          logStructuredError("rowstate", "could not stop the in-flight file", err);
        }
      }
      await applyRowEvent(key, { type: "SELECTION_CONFIRMED", diff });
      // Confirming re-arms the row; the single-flight guard is what keeps this from disturbing a running session.
      const fresh = await loadShare(key);
      /** The argument is mandatory: omitting it means "grab the whole share", which re-added every file just removed. */
      // Passing the persisted selection makes the re-dispatch a no-op and still reaches the terminal that settles the row.
      const remaining = fresh?.selection ?? [];
      if (remaining.length > 0) void runDownloadRef.current?.([...remaining]);
    },
    [lastResolvedLink, sessionDriveId, cancelInFlight, applyRowEvent],
  );

  /** The download reached through a ref, because the callbacks declared above it need to start the engine and taking it as a dependency would be a cycle. */
  const runDownloadRef = useRef<((fileNames?: string[]) => Promise<void>) | null>(
    null,
  );
  runDownloadRef.current = runDownload;

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
      resolveTimeoutTick,
      previewOpenedTick,
      waitingSavedTick,
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
      grabFailed,
      downloadAllFromPreview,
      downloadSelectedFromPreview,
      resolveFromScan,
      retryResolve,
      relookupPreview,
      abortResolving,
      alreadyDownloadedNames,
      pendingPreselection,
      setPendingPreselection,
      lastCompletedDownload,
      consumeCompletedDownload,
      retryWaitingRow,
      stopWaitingRow,
      pickerView,
      pickerHydrating,
      flapHolds: flapHoldsRef.current,
      confirmSelection,
    }),
    [
      linkDraft,
      setLinkDraft,
      resolving,
      linkError,
      resolveTimeoutTick,
      previewOpenedTick,
      waitingSavedTick,
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
      grabFailed,
      downloadAllFromPreview,
      downloadSelectedFromPreview,
      resolveFromScan,
      retryResolve,
      relookupPreview,
      abortResolving,
      alreadyDownloadedNames,
      pendingPreselection,
      setPendingPreselection,
      lastCompletedDownload,
      consumeCompletedDownload,
      retryWaitingRow,
      stopWaitingRow,
      pickerView,
      pickerHydrating,
      // The Map identity is stable for the provider's lifetime, so it never
      // re-triggers this memo; listed for completeness.
      flapHoldsRef,
      confirmSelection,
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
