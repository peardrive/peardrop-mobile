/** The share-target intake's effects: the native event, the parked files and the cache sweep. */
// The decision is `shareIntakePayload.ts`; this file is the only part that touches react-native.

import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

import { log as debugLog } from "./debugLog";
import { enqueueIntent } from "./pendingIntents";
import {
  readShareIntakePayload,
  type ShareIntakeDropped,
  type ShareIntakeFile,
  type ShareIntakeState,
} from "./shareIntakePayload";

/** Must match `EVENT` in `PeardropShareIntentModule.kt`: no module spans the boundary. */
export const EVENT_SHARE_INTENT = "PeardropShareIntent";

const TAG = "rn.shareintent";

type NativeShareIntent = {
  drainShareIntent: () => Promise<string | null>;
  sweepShareCopies: (keep: string[]) => Promise<number>;
};

const native: NativeShareIntent | undefined = (
  NativeModules as { PeardropShareIntent?: NativeShareIntent }
).PeardropShareIntent;

export function isShareIntentAvailable(): boolean {
  return Platform.OS === "android" && !!native;
}

/** Copied files, parked by share id until a handler takes them. */
const parked = new Map<string, { files: ShareIntakeFile[]; dropped: ShareIntakeDropped[] }>();

/** The newest copy-progress reading, for the sheet that renders it. */
let liveState: ShareIntakeState = { kind: "idle" };
const listeners = new Set<(state: ShareIntakeState) => void>();

export function shareIntakeState(): ShareIntakeState {
  return liveState;
}

export function subscribeShareIntake(
  listener: (state: ShareIntakeState) => void,
): () => void {
  listeners.add(listener);
  listener(liveState);
  return () => {
    listeners.delete(listener);
  };
}

/** Take the copied files for a share id. Returns null when nothing is parked under it. */
export function takeShareIntake(
  shareId: string,
): { files: ShareIntakeFile[]; dropped: ShareIntakeDropped[] } | null {
  const held = parked.get(shareId);
  if (!held) return null;
  parked.delete(shareId);
  return held;
}

/** The paths a parked share still owns, so a cache sweep cannot take them. */
export function parkedSharePaths(): string[] {
  const out: string[] = [];
  for (const held of parked.values()) for (const f of held.files) out.push(f.path);
  return out;
}

/** Apply one payload: the parsed state, the parked files and the intents it asks for. */
export function applyShareIntentPayload(raw: string | null | undefined): void {
  const outcome = readShareIntakePayload(raw);
  if (outcome.log) debugLog(outcome.log.level, TAG, outcome.log.message);
  if (outcome.park) {
    parked.set(outcome.park.shareId, {
      files: outcome.park.files,
      dropped: outcome.park.dropped,
    });
  }
  if (outcome.state) {
    liveState = outcome.state;
    for (const listener of Array.from(listeners)) {
      try {
        listener(liveState);
      } catch {
        // One bad subscriber must not strand the rest.
      }
    }
  }
  for (const intent of outcome.intents) enqueueIntent(intent);
}

let wired = false;

/** Wire the native event and read anything the module held before this process had a JS context. */
export function startShareIntake(): () => void {
  if (!isShareIntentAvailable() || wired) return () => {};
  wired = true;
  const sub = DeviceEventEmitter.addListener(EVENT_SHARE_INTENT, (payload: unknown) => {
    applyShareIntentPayload(typeof payload === "string" ? payload : null);
  });
  void native?.drainShareIntent().then(applyShareIntentPayload).catch(() => {});
  return () => {
    sub.remove();
    wired = false;
  };
}

/** Delete this module's cache copies, keeping everything a live share still points at. */
export async function sweepShareCopies(keep: readonly string[]): Promise<number> {
  if (!native?.sweepShareCopies) return 0;
  try {
    return await native.sweepShareCopies([...keep, ...parkedSharePaths()]);
  } catch {
    return 0;
  }
}

/** Reset module state. Test-only. */
export function resetShareIntake(): void {
  parked.clear();
  listeners.clear();
  liveState = { kind: "idle" };
  wired = false;
}
