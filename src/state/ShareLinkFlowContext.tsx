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
// The fetch/keep rule and the offline picker's
// adapter are pure modules because this whole file is
// unreachable from the suite. Do NOT re-inline either one here — the
// hand-rolled split these replaced is the defect they exist to close.
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
// The verdict and the ordering both live in pure
// modules under src/lib because a .tsx cannot be imported by jest in this
// project (`jest.config.js` is testEnvironment: "node", no react-native
// transform). Do NOT re-inline either one here; inlining is
// exactly what made the old `files.length` guard unassertable.
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
// tone-tagged notices — "wait" (normal wait, muted) vs
// "error" (real failure, red). Tone rule and timeout copy live in src/lib so
// the suite reaches them.
import {
  linkNotice,
  noticeForResolveFailure,
  RESOLVE_TIMEOUT_MESSAGE,
  type LinkNotice,
} from "../lib/resolveNotice";


type ShareLinkFlowApi = {
  linkDraft: string;
  setLinkDraft: (s: string) => void;
  resolving: boolean;
  linkError: LinkNotice | null;
  /**
   * bumped when the 30 s resolve guard fires. MainScreen
   * watches this and closes the Receive sheet — the timeout's message goes out
   * as a top-level info toast instead of an inline card, so the user lands
   * back on the list rather than staring at a dead sheet. One-shot signal,
   * same pattern as `manualEntryTick`.
   */
  resolveTimeoutTick: number;
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
  /**
   * open the file picker over a stored received share,
   * rendered from disk, without waiting for the sender to be found. Kicks off
   * the resolve the grab will need in parallel. No-op for an empty record.
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
   * file names the preview modal should pre-check when it
   * opens — typically populated by the "tap a missing child file"
   * smart re-grab flow. null = no preselection (modal applies its
   * default selection rules).
   */
  pendingPreselection: string[] | null;
  setPendingPreselection: (names: string[] | null) => void;
  /**
   * the moment-of-completion signal for a download. Set to
   * `{ shareKey, names, at }` immediately after `markFilesDownloaded`
   * fires. Consumers (MainScreen) read it once and call
   * `consumeCompletedDownload` to clear, which makes it a one-shot
   * trigger rather than persisting state.
   */
  lastCompletedDownload: {
    shareKey: string;
    names: string[];
    /** Files now on disk for this grab (newly fetched + kept existing). */
    saved: number;
    /** Files the engine skipped. Non-zero means a PARTIAL grab. */
    failed: number;
    /**
     * the user stopped this grab part-way. `saved` still counts
     * what landed; `failed` is meaningless here because the remaining files
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
  const [linkError, setLinkError] = useState<LinkNotice | null>(null);
  const [resolveTimeoutTick, setResolveTimeoutTick] = useState(0);

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
  // pendingPreselection survives across debounced resolve attempts
  // (so retries preserve it) but clears on explicit clear, modal close, or
  // download completion. See ZZZZZ.1.
  const [pendingPreselection, setPendingPreselectionState] = useState<string[] | null>(null);
  const setPendingPreselection = useCallback((names: string[] | null) => {
    setPendingPreselectionState(names && names.length > 0 ? names : null);
  }, []);
  // one-shot completion signal — instead of "did this share have a recent
  // download?", the model is "what's the just-completed download?" Consumers
  // read once on state change and call consumeCompletedDownload to clear.
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
   * F4 — dismissing a preview now TEARS THE SESSION DOWN.
   *
   * ## What it cost to be three state setters
   *
   * `engineOpenDrive` leaves a live session behind on a successful resolve: a
   * Hyperswarm, a Hyperdrive and a Corestore, registered in `activeDrives`
   * (`hyperdrive-engine.mjs`, the `activeDrives.set(driveId, session)` at the
   * end of `engineOpenDrive`) with download tracking bound to it. Dismissing
   * the preview touched none of it — the engine's own comment above that
   * `swarm.join` says so: *"the dismissal path is three RN state setters and
   * touches the engine not at all … the window is exactly the
   * previewed-and-never-grabbed session, which is the ordinary case rather
   * than an exotic one."*
   *
   * The consequence is a transfer on BOTH phones. The receiver's connection
   * makes the host emit `peer-connected`, which mints a transfer row there
   * with `peersConnected > 0`, which `classifyTransfer` calls `upload` — so
   * merely LOOKING at someone's link pins their foreground service up, and
   * keeps it pinned, because the peer never goes away.
   *
   * ## Why this is safe, and the one fact the safety rests on
   *
   * A successful grab does NOT come through here. `runDownload` closes the
   * modal with its own direct `setPreviewVisible(false)` (see the comment
   * in that function), for its own reason — it wants the transfer
   * card visible while the fetch runs. So this teardown cannot fire under a
   * running download. **If anyone ever routes `runDownload` through
   * `closePreview`, this must move.** `engineDeactivateDrive` does guard
   * itself against a live `_dlRunning` loop, but that guard is a
   * backstop, not the reason this is safe.
   *
   * Storage is preserved: deactivate tears down the swarm and closes the
   * drive, it does not purge. A re-resolve of the same link re-opens it.
   *
   * Fire-and-forget on purpose — dismissing a modal must not await the DHT.
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
   * Classify the dedup match between the resolved manifest and
   * the user's existing downloaded files. Three outcomes:
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
      // Manifest entries from Hyperdrive (and the demo
      // synthetic manifest) carry leading-slash paths like "/welcome.txt",
      // but appendDownloadResults strips paths via baseName() — stored
      // DownloadedItem.name is "welcome.txt" without the slash. Without
      // normalizing both sides, the lookup would always miss → the modal
      // would show every file as new even when some were already on disk.
      // Key the map on baseName() so prefixes don't matter; preserve the
      // original manifest name in `alreadyNames` so SharePreviewModal's
      // existing `selected.has(f.name)` checks still match.
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

  // persist / refresh the per-share record from a resolved
  // manifest. The new record's file list comes from the engine (canonical
  // current state of the share); any per-file `isDownloaded` / `localPath`
  // metadata the user already had is preserved by name match.
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
       * `isDownloaded: true` cannot simply carry forward whenever a prior
       * record has a `localPath` — a file deleted outside the app must not
       * stay "on device" for the life of the install: the row's re-grab
       * affordance is gated on `isMissing`, and a re-paste must not answer
       * *"You've already got these"* for a file that is gone.
       *
       * The stat happens here, at resolve time, inside the user's paste
       * gesture and in the foreground — deliberately not on a timer, which in
       * this app would have nowhere to run. One `RNFS.exists` per file that
       * claims to be downloaded; files that never were are not probed.
       *
       * A probe that throws counts as **absent**. Demoting a file that is
       * really there costs one re-grab; keeping one that is gone is the defect.
       */
      const onDisk = new Map<string, boolean>();
      for (const f of existingByName.values()) {
        if (!f.isDownloaded || !f.localPath || onDisk.has(f.localPath)) continue;
        try {
          onDisk.set(f.localPath, await RNFS.exists(f.localPath));
        } catch {
          // Deliberately NOT `false`. A
          // thrown `RNFS.exists` means "could not check", not "gone" — and
          // recording it as `false` would demote the entry and strip its
          // `localPath`, orphaning bytes that Delete could then no longer
          // unlink. Leaving it unset makes the probe return `undefined`, which
          // `healShareFiles` treats as "hold the record".
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
         * The engine drive id, persisted here.
         *
         * It already crosses the RPC on every resolve. Without persisting it,
         * the only share-key → driveId mapping in the app is
         * `buildShareKeyDriveIndex`'s in-memory `Map`, rebuilt from
         * `engineListDrives`, which **does not survive a restart** — so a share
         * the user walked away from would have no id to be re-opened by.
         *
         * `?? existing?.driveId` and not a bare `manifest.driveId`: a resolve
         * that somehow answers without one must not be the thing that erases
         * the id a previous resolve earned. `upsertShare`'s merge guard would
         * also catch that, and this is the belt to its braces — the guard is
         * deliberately narrow and a second caller could be written tomorrow.
         */
        driveId: manifest.driveId ?? existing?.driveId,
        /**
         * Not news at resolve time — `rememberDriveSession` owns writing
         * it after a grab — but it is carried forward explicitly because this
         * literal is a FRESH record: omitting the key relies on the merge
         * guard, and stating it does not.
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
   * The single rejection route for a resolve whose manifest did not
   * replicate.
   *
   * Extracted out of `applyDedupClassification` because it is needed at
   * **two** points that are deliberately at different depths: `runResolve`
   * calls it *before* anything is persisted, and
   * `applyDedupClassification` keeps it as a second line of defence for any
   * future call site that reaches the classifier directly. Both must do the
   * same four things, so there is one copy of them.
   *
   * What this branch is for: the engine's `drive.update({ wait: true })`
   * resolves on head metadata, NOT on content-blob replication. After it
   * resolves, the engine tries `/.peardrop.json` (whose blob may not have
   * streamed yet) and falls back to `drive.list("/")`, which only sees
   * locally-replicated entries. In that window a resolve can come back with no
   * manifest — and, because of the fallback, sometimes with files anyway.
   * Treat it as a transient failure: friendly error, fire-and-forget cleanup of
   * the half-formed drive engine-side so retries don't accumulate stale
   * `activeDrives` entries, and let the user hit "Try again" once the
   * connection is warm.
   */
  const rejectUnusableResolve = useCallback(
    (manifest: OpenLinkResult, where: string) => {
      // The engine logs why the manifest was
      // unavailable; this records what the user actually saw, WHICH PREDICATE
      // decided it, and that we purged the half-formed drive. `files` is
      // reported for diagnosis only — it is explicitly not what was gated on.
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
      // This must not be the literal "Couldn't find
      // any files at this link…" — that is a claim about file COUNT, and the
      // guard here is not keyed on file count and cannot make that
      // claim. It is an EXPORTED CONSTANT rather than a literal so
      // that the copy deny-list applies to it mechanically — a string in a .tsx
      // cannot be reached by a test in this project. See
      // `src/lib/resolveDisposition.ts` and its `__tests__`.
      // tone "wait" — the manifest not having replicated yet
      // is one of the two normal-wait cases, not a failure. Rendered muted
      // with an info icon, never red.
      setLinkError(linkNotice("no-manifest", RESOLVE_NO_MANIFEST_MESSAGE));
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
      // A guard keyed on
      // `!manifest.files || manifest.files.length === 0` would be wrong
      // in BOTH directions:
      //
      //  - a share whose manifest legitimately declares zero files RESOLVED,
      //    and file-count keying would report it as a failure (the destructive
      //    direction — `reconcileShareRecord`'s keep-loop would then drop every
      //    not-yet-downloaded entry of a share the user already held);
      //  - files produced by the engine's `drive.list("/")` fallback with no
      //    manifest at all would be reported as a success.
      //
      // `hasManifest` is the only value that separates those, and it already
      // crosses the RPC. `classifyResolve` gates on `=== true` and fails closed.
      //
      // NOTE this is now the SECOND line of defence: `runResolve` classifies
      // before it persists, so in the ordinary flow control never reaches here
      // with an unusable result. It is kept because a guard that only runs
      // when the caller remembered to call it is not a guard.
      if (classifyResolve(manifest) !== "usable") {
        rejectUnusableResolve(manifest, "applyDedupClassification");
        return;
      }
      // LLLLLL: a successful resolve clears the link input — the
      // user has moved past "I'm typing a link" into "I'm looking at what's
      // in the share." Failures leave the link in place so retry has
      // something to work with. Same for the smart-regrab preselection:
      // the modal is about to consume it, so wiping it here is harmless.
      const clearOnSuccess = () => {
        setLinkDraftRaw("");
        setPendingPreselectionState(null);
      };
      if (kind === "full") {
        // Every manifest file is already on disk. Skip
        // the preview entirely; the Receive screen flashes the matching
        // rows via highlightedDownloadedIds.
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
    [showToast, rejectUnusableResolve],
  );

  const runResolve = useCallback(
    async (raw: string) => {
      const normalized = normalizeShareLink(raw);
      if (!normalized) {
        setLinkError(linkNotice("malformed", "That doesn't look like a PearDrop link."));
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
      // per-share dedup. The new storage canonicalizes by share
      // key, so a paste of a previously-grabbed link returns an existing
      // record with the right `isDownloaded` flags. Legacy disk-based
      // dedup stays as a fallback for shares that predate the new storage.
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
        // the demo path goes through the SAME
        // classify-then-persist order as the real one. It never touches the
        // engine, so the engine's `receive.no-manifest` gate cannot protect it
        // — this call site is one of the three reasons the RN guard has to
        // exist at all (see `src/lib/resolveDisposition.ts`). Today
        // `getDemoOpenResult()` sets `hasManifest: true` (`src/lib/demo.ts`),
        // so behaviour here is unchanged; the point is that it stays unchanged
        // only while that stays true, and now that is enforced rather than
        // assumed.
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
        // resolveGuard stays RN-free, so the sink is
        // injected here rather than imported there.
        onLog: (level, msg) => debugLog(level, "rn.resolve", msg),
        onBegin: () => {
          setResolving(true);
          setLinkError(null);
        },
        onSuccess: async (out) => {
          if (out.driveId) {
            // Calling `reconcileAndDedup(out)` before classification would put
            // the classification guard after the decision has already been
            // made: `reconcileAndDedup` reaches
            // `reconcileShareRecord` → `await upsertShare(next)`, so a
            // manifest-less resolve would ALREADY have written a `files: []`
            // `ReceivedShare` to peardrop-received-shares.json by the time the
            // guard ran — and nothing deletes it. That persisted row would be a
            // permanent `Share · 0 B` entry the user sees, so no change to the
            // guard's predicate alone can fix it — the ordering itself has to
            // classify first.
            //
            // `disposeResolve` classifies FIRST and calls `persist` only on a
            // good resolve. Its ordering is unit-tested in
            // `src/lib/__tests__/resolveDisposition.test.ts`; the order here is
            // not expressible as a test because this file is a .tsx.
            //
            // The draft is deliberately kept on both routes so the user can
            // re-paste, copy or edit; they clear it with the × on the input.
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
            // Server said ok but forgot the driveId — treat as a soft failure.
            haptics.error();
            // The copy must not suggest "check your Wi-Fi?" — that is a
            // diagnosis nothing in this app can make — there is no connectivity
            // detection anywhere in the tree. A resolve that has not completed
            // cannot distinguish "the host is offline" from "DHT discovery is
            // still running", so it must claim neither.
            setLinkError(
              linkNotice("missing-drive-id", "Couldn't open that link — give it another go?"),
            );
          }
        },
        onFailure: (message) => {
          haptics.error();
          // the engine's `receive.no-manifest` rejection
          // arrives here carrying the SAME sentence as the RN-side guard
          // ("Two routes, one sentence" — resolveDisposition.ts), so it gets
          // the same "wait" tone. Every other message stays an error.
          setLinkError(noticeForResolveFailure(message));
        },
        onTimeout: () => {
          // Kick off a best-effort abort so backend state doesn't leak a
          // pending open when we time out.
          void abortOpen();
          haptics.warning();
          // the 30 s timeout is the other normal-wait case,
          // and it does not leave an inline card at all — the app returns
          // to the list. No linkError is set; the muted wait copy goes out as
          // a top-level info toast, and the tick tells MainScreen to close
          // the Receive sheet. The copy claims nothing about connectivity.
          setLinkError(null);
          showToast(RESOLVE_TIMEOUT_MESSAGE, { kind: "info" });
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
      // the timeout's wait copy is a toast now.
      showToast,
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
      /**
       * This guard is REACHABLE BY A USER.
       *
       * `openStoredSharePicker` opens the
       * modal from disk with `sessionDriveId === null` on purpose — that is the
       * `closePreview` seam — and the resolve that will supply a session runs
       * in parallel. Tap Grab inside that window and a silent `return` would be
       * a dead button.
       *
       * `engineDownload` cannot be made to work here: it answers
       * `receive.no-session` without a live `activeDrives` entry
       * (`hyperdrive-engine.mjs`), so there is genuinely nothing to download
       * from yet. What changes is that the user is told which of the two
       * things happened — still looking, or already failed.
       */
      if (!sessionDriveId) {
        // a wait-tone notice keeps its info kind here too —
        // "still looking" reported through an error toast would be the same
        // red-for-normal-wait defect this item removed.
        showToast(linkError?.text || "Still finding the sender — give it a moment.", {
          kind: linkError && linkError.tone === "error" ? "error" : "info",
        });
        return;
      }
      setDownloadAllBusy(true);
      setLinkError(null);
      // The receive path's own permission ask.
      //
      // Without this line the ONLY product ask is on the send path
      // (`MainScreen.tsx`, after `sharePaths` returns ok), so someone who only
      // ever receives would never be asked in the foreground at all — their
      // first and only prompt would come from the backstop inside
      // `notifyTransferComplete`, which its own `AppState === "active"` guard
      // confines to the background.
      //
      // This is the mirror of the send-path site: the user's own Grab tap, app
      // in front of them, the first moment they have something worth being
      // notified about. Fire-and-forget for the same reason — the grab, the
      // modal dismissal below and the progress card must not wait on an OS
      // dialog, and a denial stays silent by design. `ensurePermission` logs
      // every outcome to `debugLog`, so the export can settle whether the
      // dialog was shown and what was answered.
      void ensureNotificationPermission();
      // Close the preview modal IMMEDIATELY so the transfer
      // card on the Receive screen (driven by upload-progress events)
      // becomes visible while the download runs. Awaiting
      // startDownload before closing would leave the modal sitting there,
      // covering the screen for the entire duration of the fetch with
      // no progress feedback. Errors surface via the linkError that
      // ReceiveScreen renders below the link input, so closing the
      // modal early doesn't lose error visibility.
      setPreviewVisible(false);
      try {
        // Partition the in-scope file names into "already on
        // disk under this link" and "needs fetching from the peer". The
        // alreadyDownloadedNames set was populated during runResolve from
        // the (shareLink, name) intersection. If the user manually
        // checked an already-downloaded file in the modal, we honour that
        // by including its name in fileNames here — but we still skip the
        // re-fetch so we don't create `filename (1)` duplicates via
        // uniquePath, and we surface a "kept your existing copy" toast.
        const allManifestNames = (openResult?.files || []).map((f) => f.name);
        const targetNames =
          fileNames && fileNames.length ? fileNames : allManifestNames;
        /**
         * ONE fetch/keep rule, fed by BOTH notions
         * of "the user already has this".
         *
         * Two separate `targetNames.filter` calls over just
         * `alreadyDownloadedNames` would not be enough, because that set is
         * populated *exclusively* by a successful resolve. The engine skips
         * nothing — it selects by
         * `wantedSet` and collides through `uniquePath`, which writes
         * `` `${stem} (${i})${ext}` `` — so any grab that did not come through
         * a resolve would re-fetch every file the user already held and leave
         * `photo (1).jpg` next to `photo.jpg`, by construction. That is the
         * whole reason `partitionGrabNames` exists.
         *
         * Two lists go in, concatenated, because the two sources are not
         * interchangeable and neither subsumes the other:
         *
         * - **the stored record** carries the `isDownloaded`/`localPath` pair
         *   `healShareFiles`'s healing keeps honest, and is the only source that is right
         *   on the offline path. It is re-read here rather than captured at
         *   picker-open time so a resolve that demoted a file in between is
         *   respected.
         * - **`alreadyDownloadedNames`** is the resolve's own answer, and on
         *   the legacy-dedup fallback (`classifyDedup`, for shares that predate
         *   the per-share store) it is the ONLY answer. Dropping it would
         *   reintroduce the duplicates for exactly those shares.
         *
         * `heldNames` unions over the whole list, so an entry held by either
         * source is kept. The synthetic `localPath` below is not a path and is
         * never read: `loadDownloaded()` has already confirmed those files
         * exist on disk, the path itself is not carried across the resolve, and
         * `isHeld` asks only whether there is one.
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
         * The folder the engine actually wrote into.
         *
         * `DownloadResult.destDir` crosses the RPC from the engine's
         * `_downloadRoot`. Captured here and
         * persisted below so a later re-grab, and the row's "where did these
         * go" answer, have something to read.
         */
        let grabDestDir: string | undefined;
        let fetchedFiles: { name: string; path: string; size: number }[] = [];
        /**
         * per-file casualties from the grab.
         *
         * `engineDownload` continues past a failed file — it unlinks the
         * partial, pushes the key onto `failed`, and carries on with the
         * next entry — then returns `ok: true` with the survivors. So
         * `ok` does NOT mean "you have the whole share", and reporting an
         * unqualified success for a partial grab is the same defect as
         * showing no progress: the user cannot tell what they actually
         * have. Carried out to the completion toast.
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
          // reported on the cancelled shape as well as the ok one, so a
          // stopped grab still records where its survivors landed.
          grabDestDir = (out as { destDir?: string }).destDir || undefined;
          // a cancelled grab is reported BEFORE the failure
          // branch, and never through it.
          //
          // `engineDownload` returns `ok: true` with `cancelled: true` and
          // whatever finished first — which for an early cancel is legitimately
          // zero files. The old condition treats "ok but no files" as a
          // failure and raises "Couldn't grab those files — give it another
          // go?", which is both an error the user did not have and an
          // invitation to retry the thing they just stopped.
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
                linkNotice(
                  "grab-failure",
                  // A plain `||` here would always let the raw engine message
                  // win over this fallback, because `||` can never reach the right
                  // operand when a structured error always has a `message`.
                  userFacingError(out.error, "Couldn't grab those files — give it another go?"),
                ),
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
           * THE ORDER IS THE FIX.
           *
           * These two writes cannot be made atomic with each other: they are
           * two files, and the engine has *already* durably merged
           * `meta.localFiles` and saved its manifest before `startDownload`
           * even returns (`engineDownload`, after the download loop). **The
           * window is a whole transfer, not the ~100 ms RN-to-RN gap** that
           * would make this a race.
           *
           * What can be fixed is which store is left stale when the process
           * dies between them. `markFilesDownloaded` writes
           * `receivedSharesStorage` — **the store the rendered list is built
           * from**. `appendDownloadResults` writes `receivedFilesStorage`,
           * which is read only by the dedup probe and the reconcile diff, and
           * which `runReceivedReconcile` can rebuild from the engine's
           * manifest on the next foreground.
           *
           * So the visible store goes first. A kill between them leaves a
           * row that correctly shows what the user has, plus an index the
           * reconcile repairs. The reverse order would produce files on disk
           * and a row saying nothing was downloaded.
           *
           * The `try/catch` stays on the share write and stays off
           * `appendDownloadResults` — that throw must escape
           * into the outer handler; swallowing it here would erase the
           * signal it carries.
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
             * THE call the contracts are written for.
             *
             * Deliberately AFTER `markFilesDownloaded` and deliberately its own
             * call: the two have different failure modes, and folding the
             * session facts into a reconstructed `ReceivedShare` is exactly how
             * `upsertShare`'s spread erases fields (see the comment on that spread).
             * `rememberDriveSession` writes nothing when it has nothing new to
             * say, so it cannot re-sort the user's list on a repeat grab.
             *
             * The demo drive is excluded: `DEMO_DRIVE_ID` is not an engine
             * drive, and recording it would make a record claim it can be
             * reopened by an id the engine has never heard of.
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

        // one completion signal per grab, regardless of whether
        // any bytes actually moved over the wire. The user's act of tapping
        // Grab is the trigger — the routing effect in MainScreen expands
        // the bundle if needed and blinks the selected rows. This covers
        // both "downloaded new files" and "re-grabbed already-downloaded
        // files" with one signal.
        const sharedKeyAny = lastResolvedLink ? extractKey(lastResolvedLink) : null;
        const acknowledgedNames = [
          ...fetchedFiles.map((f) => baseName(f.name)),
          ...keepNames.map((n) => baseName(n)),
        ];
        // `|| wasCancelled` so a cancel that kept nothing still
        // produces a signal. The `length > 0` guard is right for the normal
        // path — a grab that acknowledged nothing has nothing to say — but a
        // cancel is a user action that must always be answered, and
        // "Stopped — nothing saved." is the answer when the cancel beat the
        // first file.
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

        // Modal was already closed at the start of this function.
        // Real downloads get their success toast via the Receive
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
          linkNotice(
            "generic-throw",
            devMode ? raw : "Something went sideways — give it another go?",
          ),
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
      // read by the no-session guard, which reports the resolve's own
      // failure rather than inventing a second message for the same event.
      linkError,
    ],
  );

  /**
   * Reopen a received share's picker from what is already on disk.
   *
   * `openResult` had exactly one producer, `applyDedupClassification`, reached
   * only after a **live** `engineOpenDrive`. A share whose whole file list was
   * already sitting in `peardrop-received-shares.json` could not show its
   * picker again without the sender being found first.
   *
   * Two things happen here, and the split is the point.
   *
   * **The LIST is instant, from disk.** `storedShareToOpenResult` is the
   * adapter; no engine call, no network, no wait.
   *
   * **The BYTES still come from the peer.** `engineDownload` answers
   * `receive.no-session` without a live `activeDrives` entry, so a resolve is
   * kicked off alongside the modal rather than in front of it. It goes through
   * the ordinary `runResolve`, so the 30 s guard, the error copy and the
   * classify-before-persist ordering all still apply, and when it lands
   * `applyDedupClassification` upgrades this already-open modal in place.
   *
   * `closePreview` only calls `deactivateDrive` when `sessionDriveId` is set.
   * Leaving it null means dismissing this picker cannot tear down a drive it
   * never opened — the same seam `DEMO_DRIVE_ID` uses. **No new flag and no
   * second close path.** Once the parallel resolve lands, `sessionDriveId` is
   * a real id again and dismissal tears down correctly.
   */
  const openStoredSharePicker = useCallback(
    (share: ReceivedShare) => {
      // `rowTapRoute` already refuses an empty record — `describeHoldings([])`
      // answers `allHeld: false`, which is right for a label and wrong as a
      // re-grab trigger. Repeated here because a guard that only holds while
      // its one caller remembers it is not a guard.
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
      resolveTimeoutTick,
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
      resolveTimeoutTick,
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
