/** What one native share-intake payload means. Pure, so the routing and the copy are assertable. */
// Decision here, effects in `shareIntent.ts` — the same split `freezeDetect` and `transferStall` use.

import { INTENT_SHARE_LINK_REJECTED, parseIncomingShareLink } from "./links";
import { INTENT_SHARE_LINK } from "./pendingIntents";

/** Files copied out of a share-sheet intent and ready to become a share. */
export const INTENT_SHARE_FILES = "share-files";

/** A share that produced nothing to share. The value is the notice, already worded. */
export const INTENT_SHARE_NOTICE = "share-notice";

export type ShareIntakeFile = {
  readonly displayName: string;
  readonly size: number;
  readonly mimeType: string;
  readonly path: string;
};

export type ShareIntakeDropped = {
  readonly displayName: string;
  readonly reason: string;
};

export type ShareIntakeState =
  | { kind: "start"; shareId: string; count: number; totalBytes: number }
  | {
      kind: "progress";
      shareId: string;
      copiedBytes: number;
      totalBytes: number;
      index: number;
      count: number;
      displayName: string;
    }
  | { kind: "idle" };

export type ShareIntakeOutcome = {
  /** The new live state, or null to leave the current one alone. */
  readonly state: ShareIntakeState | null;
  /** Intents to enqueue, in order. */
  readonly intents: readonly { kind: string; value: string }[];
  /** Copied files to park under their share id, for the handler that takes them. */
  readonly park: { shareId: string; files: ShareIntakeFile[]; dropped: ShareIntakeDropped[] } | null;
  readonly log: { level: "info" | "warn"; message: string } | null;
};

const NOTHING: ShareIntakeOutcome = { state: null, intents: [], park: null, log: null };

/** What a share that produced no files should say. House voice: no "failed", no red. */
export function noticeForDropped(dropped: readonly ShareIntakeDropped[]): string {
  return dropped.length === 1 ? "Couldn't read that file." : "Couldn't read those files.";
}

export const NOTICE_NO_SPACE = "Not enough space on this phone for that share.";
export const NOTICE_TEXT_ONLY = "PearDrop shares files. There are no files here.";

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readFiles(raw: unknown): ShareIntakeFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ShareIntakeFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const path = stringOf(r.path);
    if (!path) continue;
    out.push({
      displayName: stringOf(r.displayName),
      size: Math.max(0, numberOf(r.size)),
      mimeType: stringOf(r.mimeType),
      path,
    });
  }
  return out;
}

function readDropped(raw: unknown): ShareIntakeDropped[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((r) => ({ displayName: stringOf(r.displayName), reason: stringOf(r.reason) }));
}

/** Read one payload. An unparseable or unknown one changes nothing, which is why it returns a
 *  state of null rather than `idle`: a damaged event must not cancel a copy that is running. */
export function readShareIntakePayload(raw: string | null | undefined): ShareIntakeOutcome {
  if (!raw) return NOTHING;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...NOTHING, log: { level: "warn", message: "payload was not JSON" } };
  }
  const shareId = stringOf(parsed.shareId);
  const phase = stringOf(parsed.phase);
  if (!shareId) return NOTHING;

  if (phase === "start") {
    const count = Array.isArray(parsed.items) ? parsed.items.length : 0;
    return {
      state: { kind: "start", shareId, count, totalBytes: numberOf(parsed.totalBytes) },
      intents: [],
      park: null,
      log: { level: "info", message: `intake start id=${shareId} items=${count}` },
    };
  }

  if (phase === "progress") {
    return {
      state: {
        kind: "progress",
        shareId,
        copiedBytes: numberOf(parsed.copiedBytes),
        totalBytes: numberOf(parsed.totalBytes),
        index: numberOf(parsed.index),
        count: numberOf(parsed.count, 1),
        displayName: stringOf(parsed.displayName),
      },
      intents: [],
      park: null,
      log: null,
    };
  }

  if (phase === "error") {
    return {
      state: { kind: "idle" },
      intents: [{ kind: INTENT_SHARE_NOTICE, value: NOTICE_NO_SPACE }],
      park: null,
      log: {
        level: "warn",
        message: `intake refused id=${shareId} code=${stringOf(parsed.code)}`,
      },
    };
  }

  if (phase === "text") {
    // A forwarded share link is a link, not a text share, and gets the confirm-first preview.
    const text = stringOf(parsed.text).trim();
    const result = parseIncomingShareLink(text);
    if (result.ok) {
      return {
        state: { kind: "idle" },
        intents: [{ kind: INTENT_SHARE_LINK, value: result.link }],
        park: null,
        log: { level: "info", message: `intake text id=${shareId} is a share link` },
      };
    }
    if (/^peardrop:\/\//i.test(text)) {
      return {
        state: { kind: "idle" },
        intents: [{ kind: INTENT_SHARE_LINK_REJECTED, value: text }],
        park: null,
        log: { level: "info", message: `intake text id=${shareId} is a damaged share link` },
      };
    }
    return {
      state: { kind: "idle" },
      intents: [{ kind: INTENT_SHARE_NOTICE, value: NOTICE_TEXT_ONLY }],
      park: null,
      log: { level: "info", message: `intake text id=${shareId} is not a link` },
    };
  }

  if (phase === "done") {
    const files = readFiles(parsed.files);
    const dropped = readDropped(parsed.dropped);
    const log = {
      level: "info" as const,
      message: `intake done id=${shareId} files=${files.length} dropped=${dropped.length}`,
    };
    if (files.length === 0) {
      return {
        state: { kind: "idle" },
        intents: [{ kind: INTENT_SHARE_NOTICE, value: noticeForDropped(dropped) }],
        park: null,
        log,
      };
    }
    return {
      state: { kind: "idle" },
      intents: [{ kind: INTENT_SHARE_FILES, value: shareId }],
      park: { shareId, files, dropped },
      log,
    };
  }

  return NOTHING;
}
