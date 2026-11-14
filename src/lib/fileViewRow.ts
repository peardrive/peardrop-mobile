/**
 * What one row of the list says about its share, in every view. One state at a time, from the
 * universal list in Pearkit (`ShareState`): the same word in the same colour on the phone and
 * on the desktop.
 * No react-native imports: jest runs this under `testEnvironment: "node"`.
 */

import {
  fileViewKindOf,
  type FileTone,
  type FileViewKind,
} from "../vendor/pearkit/FileViews/fileViewLogic";
import {
  describeShareState,
  type ShareBar,
  type ShareStateInput,
  type ShareStateKind,
  type ShareStateTone,
  type ShareStateView,
} from "../vendor/pearkit/ShareState/shareState";
import { hostedShareState, type HostedTransferLike } from "./hostedRowStatus";
import { clampReceivePercent, type ReceiveRowStatus } from "./receiveProgress";

/** The theme colours a row's words can take. */
export type RowTone = "warning" | "primary" | "danger" | "muted";

/** Green is finished, amber is not finished yet, grey is switched off, red needs the person. */
export function rowTone(tone: ShareStateTone): RowTone {
  if (tone === "good") return "primary";
  if (tone === "busy") return "warning";
  if (tone === "bad") return "danger";
  return "muted";
}

/**
 * A received copy the engine holds with no record of its own (an old install). The engine's
 * reading of the transfer is all there is to go on.
 */
export function engineReceiveState(
  receive: ReceiveRowStatus,
  opts: { isActive: boolean; percent: number | null | undefined },
): ShareStateInput {
  switch (receive.state) {
    case "starting":
      return { kind: "starting" };
    case "receiving":
      return { kind: "downloading", percent: clampReceivePercent(opts.percent) };
    case "finishing":
      return { kind: "downloading", percent: 100 };
    case "stalled":
      return { kind: "waiting" };
    case "partial":
    case "failed":
      return { kind: "attention", note: receive.label };
    case "saved":
      return { kind: "active" };
    case "cancelled":
      return { kind: "inactive" };
    case "idle":
      return { kind: opts.isActive ? "active" : "inactive" };
  }
}

/** The one state a row shows. Every view of the list reads this and nothing else. */
export function rowState(input: {
  /** The engine could not bring this share back at launch. */
  failed: boolean;
  /** A received share with a record: the state its model decided. */
  received: ShareStateView | null;
  /** A received copy with no record: the engine's reading. Null for a share of this phone's own. */
  engineReceive: { status: ReceiveRowStatus; percent: number | null | undefined } | null;
  /** A share of this phone's own: its upload, if one is running. */
  hosted: HostedTransferLike | null | undefined;
  isActive: boolean;
}): ShareStateView {
  if (input.failed) return describeShareState({ kind: "attention", note: "Couldn't restore" });
  if (input.received) return input.received;
  if (input.engineReceive) {
    return describeShareState(
      engineReceiveState(input.engineReceive.status, {
        isActive: input.isActive,
        percent: input.engineReceive.percent,
      }),
    );
  }
  return describeShareState(hostedShareState(input.hosted, { isActive: input.isActive }));
}

/**
 * The small light on a row's picture. Lit for a share other people can get from this phone,
 * brighter while someone is taking it; nothing for a download or a share that is switched off.
 */
export function rowIndicator(
  kind: ShareStateKind,
  peers: number,
): "inactive" | "active-idle" | "active-broadcasting" {
  if (kind === "sharing") return "active-broadcasting";
  if (kind === "active") return peers > 0 ? "active-broadcasting" : "active-idle";
  return "inactive";
}

/** What a download that needs the person says under a grid picture, where a line holds about a dozen letters. */
function gridWord(state: ShareStateView): string {
  if (state.kind !== "attention") return state.shortLabel;
  if (state.label === "Not enough space") return "No space";
  if (state.label === "Can't save files") return "Can't save";
  if (state.label === "Couldn't restore") return "Not restored";
  if (/no longer shared$/.test(state.label)) return "Files gone";
  return state.shortLabel;
}

export type CompactRow = {
  status: string;
  /** The same state for the grid, where a line holds about a dozen letters. */
  shortStatus: string;
  tone: FileTone;
  /** How much has arrived, 0 to 1, for a download that is not finished: this draws the pie. */
  download: number | null;
  /** The progress bar, for a view that draws one. */
  bar: ShareBar | null;
};

/** The list and grid views: the state, its colour, and how far a download is. */
export function compactRow(state: ShareStateView): CompactRow {
  return {
    status: state.label,
    shortStatus: gridWord(state),
    tone: state.tone,
    // An upload keeps its number in the words and has no pie.
    download: state.bar && state.kind !== "sharing" ? state.bar.value : null,
    bar: state.bar,
  };
}

/** The kind of picture a share gets when it has none of its own. */
export function shareKind(name: string, isBundle: boolean): FileViewKind {
  return isBundle ? "folder" : fileViewKindOf(name);
}
