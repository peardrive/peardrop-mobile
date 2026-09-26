import b4a from "b4a";
import type RPC from "bare-rpc";

import type {
  BridgeStatus,
  DownloadResult,
  DriveRecord,
  OpenLinkResult,
  SharePathsResult,
} from "../state/types";

import {
  RPC_HYPERDRIVE_SHARE,
  RPC_HYPERDRIVE_STOP,
  RPC_HYPERDRIVE_OPEN,
  RPC_HYPERDRIVE_ABORT,
  RPC_HYPERDRIVE_DOWNLOAD,
  RPC_HYPERDRIVE_CANCEL,
  RPC_HYPERDRIVE_STATUS,
  RPC_DRIVES_LIST,
  RPC_DRIVES_PAUSE,
  RPC_DRIVES_RESUME,
  RPC_TEST_FAKE_UPLOAD,
  RPC_TEST_FAKE_DOWNLOAD,
  RPC_REFRESH_SWARM,
  RPC_SET_DEBUG_LOGGING,
} from "../../rpc-commands.mjs";

export type FakeUploadOpts = {
  durationMs?: number;
  tickMs?: number;
  peers?: number;
  totalBytes?: number;
  peerPrefix?: string;
  forceSelfPeer?: boolean;
  flapPeer?: boolean;
  outOfOrderStart?: boolean;
  malformedEvent?: boolean;
  stallAtMs?: number;
  stallDurationMs?: number;
  earlyCompletePeers?: number;
  /**
   * Defer the whole simulation by this many ms, leaving time to background
   * the app before `upload-complete` fires. The
   * RPC still returns immediately, carrying the driveId. Timer lives in
   * the worklet — RN's own timers are frozen while backgrounded.
   */
  startDelayMs?: number;
};

/**
 * options for the simulated DOWNLOAD.
 *
 * Deliberately not a superset of `FakeUploadOpts`: `earlyCompletePeers`,
 * `flapPeer` and `malformedEvent` have no receive analogue and carrying
 * them across would suggest behaviour that does not exist.
 */
export type FakeDownloadOpts = {
  durationMs?: number;
  tickMs?: number;
  totalBytes?: number;
  shareName?: string;
  fileCount?: number;
  peerPrefix?: string;
  startDelayMs?: number;
  /**
   * Pin progress at this percent and NEVER complete. `100` is the headline
   * case: it is the only way to prove, without a second device, that a
   * download stuck at 100 % and a finished one look different — the
   * `Finishing…` vs `Saved` split. 0 means no hold.
   */
  holdAtPercent?: number;
  /**
   * Go silent at this offset — no events at all — so RN's watchdog flips
   * `stalled` after 30 s. A stalled download must stop holding the
   * foreground service (`classifyTransfer`'s `!stalled` clause).
   */
  stallAtMs?: number;
  /** Resume after this long. 0 means the stall is permanent. */
  stallDurationMs?: number;
  /** Sender vanishes at this offset without a resume. 0 disables. */
  peerDropAtMs?: number;
};

export type FakeDownloadResult = {
  ok: boolean;
  error?: string;
  driveId?: string;
  /** Synthesized 64-hex key. Resolves through `extractKey` like a real one. */
  shareKey?: string;
  shareLink?: string;
  durationMs?: number;
  tickMs?: number;
  totalBytes?: number;
  holdAtPercent?: number;
  files?: { name: string; size: number }[];
};

export type RpcResultFor = {
  [RPC_HYPERDRIVE_SHARE]: SharePathsResult;
  [RPC_HYPERDRIVE_OPEN]: OpenLinkResult;
  [RPC_HYPERDRIVE_DOWNLOAD]: DownloadResult;
  [RPC_HYPERDRIVE_ABORT]: { ok: boolean; aborted?: number; error?: string };
  [RPC_HYPERDRIVE_STOP]: { ok: boolean; error?: string };
  /**
   * `unwinding` means a download loop observed the flag and will
   * emit `transfer-cancelled` itself; `alreadyInactive` means nothing was in
   * flight and NO event follows. A caller that waits for an event must treat
   * the second as terminal on its own.
   */
  [RPC_HYPERDRIVE_CANCEL]: {
    ok: boolean;
    error?: string;
    unwinding?: boolean;
    alreadyInactive?: boolean;
  };
  [RPC_HYPERDRIVE_STATUS]: { ok?: boolean; status?: BridgeStatus };
  [RPC_DRIVES_LIST]: { ok?: boolean; drives?: DriveRecord[] };
  [RPC_DRIVES_PAUSE]: { ok: boolean; error?: string; alreadyInactive?: boolean };
  [RPC_DRIVES_RESUME]: {
    ok: boolean;
    error?: string;
    driveId?: string;
    shareLink?: string;
    key?: string;
    already?: boolean;
  };
  [RPC_TEST_FAKE_UPLOAD]: { ok: boolean; driveId?: string; error?: string };
  [RPC_TEST_FAKE_DOWNLOAD]: FakeDownloadResult;
  [RPC_REFRESH_SWARM]: { ok: boolean; refreshed?: number; rejoined?: number; error?: string };
  [RPC_SET_DEBUG_LOGGING]: { ok: boolean; enabled?: boolean; error?: string };
};

export type RpcPayloadFor = {
  /**
   * `shareName` is the name the user chose, and it travels to the
   * receiver. For a single file the engine makes it the drive entry key — the
   * thing the receiver actually writes — and for a bundle it becomes the
   * share title. Absent means "use the engine's generated default", which is
   * what every share created before this build did.
   */
  [RPC_HYPERDRIVE_SHARE]: { paths: string[]; relPaths?: string[]; shareName?: string };
  [RPC_HYPERDRIVE_OPEN]: { link: string };
  [RPC_HYPERDRIVE_DOWNLOAD]: {
    driveId: string;
    destDir?: string;
    fileName?: string;
    fileNames?: string[];
  };
  [RPC_HYPERDRIVE_ABORT]: { driveId?: string };
  [RPC_HYPERDRIVE_STOP]: { driveId: string; purge?: boolean };
  /** No `purge`. Cancelling never destroys storage — that is opcode 21. */
  [RPC_HYPERDRIVE_CANCEL]: { driveId: string };
  [RPC_HYPERDRIVE_STATUS]: Record<string, never>;
  [RPC_DRIVES_LIST]: Record<string, never>;
  [RPC_DRIVES_PAUSE]: { driveId: string };
  [RPC_DRIVES_RESUME]: { driveId: string };
  [RPC_TEST_FAKE_UPLOAD]: FakeUploadOpts;
  [RPC_TEST_FAKE_DOWNLOAD]: FakeDownloadOpts;
  [RPC_REFRESH_SWARM]: Record<string, never>;
  /**
   * `heartbeat` gates the worklet's 2 s liveness tick, separately from
   * `enabled`: Debugging ships to users, the heartbeat is dev-only, and the
   * worklet realm has no build-type constant of its own. Absent means off.
   */
  [RPC_SET_DEBUG_LOGGING]: { enabled: boolean; heartbeat?: boolean };
};

export type RpcCommand = keyof RpcResultFor;

// bare-rpc's Request.send typing advertises a Node-style Buffer, but the
// runtime in practice handles any Uint8Array (which is what b4a produces
// on React Native). We wrap the call in a tiny helper to contain the cast.
type BufferLike = Parameters<ReturnType<InstanceType<typeof RPC>["request"]>["send"]>[0];

function sendBytes(req: ReturnType<InstanceType<typeof RPC>["request"]>, body: Uint8Array): void {
  req.send(body as unknown as BufferLike);
}

export async function invoke<C extends RpcCommand>(
  rpc: InstanceType<typeof RPC> | null,
  command: C,
  payload?: RpcPayloadFor[C]
): Promise<RpcResultFor[C]> {
  if (!rpc) throw new Error("Backend not ready");
  const req = rpc.request(command);
  const body = payload == null ? b4a.alloc(0) : b4a.from(JSON.stringify(payload), "utf8");
  sendBytes(req, body);
  const raw = (await req.reply()) as Uint8Array | null;
  if (!raw) return {} as RpcResultFor[C];
  const text = b4a.toString(raw, "utf8");
  if (!text) return {} as RpcResultFor[C];
  return JSON.parse(text) as RpcResultFor[C];
}

export function sendOneWay(
  rpc: InstanceType<typeof RPC> | null,
  command: number,
  payload?: unknown
): void {
  if (!rpc) return;
  const req = rpc.request(command);
  const body =
    payload == null
      ? b4a.alloc(0)
      : payload instanceof Uint8Array
        ? payload
        : b4a.from(JSON.stringify(payload), "utf8");
  sendBytes(req, body);
}
