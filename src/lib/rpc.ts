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
  RPC_HYPERDRIVE_STATUS,
  RPC_DRIVES_LIST,
  RPC_DRIVES_PAUSE,
  RPC_DRIVES_RESUME,
  RPC_TEST_FAKE_UPLOAD,
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
   * Defer the whole simulation by this many ms, so the tester
   * has time to background the app before `upload-complete` fires. The
   * RPC still returns immediately, carrying the driveId. Timer lives in
   * the worklet — RN's own timers are frozen while backgrounded.
   */
  startDelayMs?: number;
};

export type RpcResultFor = {
  [RPC_HYPERDRIVE_SHARE]: SharePathsResult;
  [RPC_HYPERDRIVE_OPEN]: OpenLinkResult;
  [RPC_HYPERDRIVE_DOWNLOAD]: DownloadResult;
  [RPC_HYPERDRIVE_ABORT]: { ok: boolean; aborted?: number; error?: string };
  [RPC_HYPERDRIVE_STOP]: { ok: boolean; error?: string };
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
  [RPC_REFRESH_SWARM]: { ok: boolean; refreshed?: number; rejoined?: number; error?: string };
  [RPC_SET_DEBUG_LOGGING]: { ok: boolean; enabled?: boolean; error?: string };
};

export type RpcPayloadFor = {
  [RPC_HYPERDRIVE_SHARE]: { paths: string[]; relPaths?: string[] };
  [RPC_HYPERDRIVE_OPEN]: { link: string };
  [RPC_HYPERDRIVE_DOWNLOAD]: {
    driveId: string;
    destDir?: string;
    fileName?: string;
    fileNames?: string[];
  };
  [RPC_HYPERDRIVE_ABORT]: { driveId?: string };
  [RPC_HYPERDRIVE_STOP]: { driveId: string; purge?: boolean };
  [RPC_HYPERDRIVE_STATUS]: Record<string, never>;
  [RPC_DRIVES_LIST]: Record<string, never>;
  [RPC_DRIVES_PAUSE]: { driveId: string };
  [RPC_DRIVES_RESUME]: { driveId: string };
  [RPC_TEST_FAKE_UPLOAD]: FakeUploadOpts;
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
