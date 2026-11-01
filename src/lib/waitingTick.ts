/** The worklet's waiting wake, from the realm that receives it to the one that owns the loop. */

/** A wake, with the engine tick that produced it. */
export type WaitingTickListener = (tick: number) => void;

const listeners = new Set<WaitingTickListener>();

/**
 * A module value cannot drive an effect, so the tick notifies rather than
 * being polled: the subscriber is built where the loop is, two contexts down.
 */
export function subscribeWaitingTick(listener: WaitingTickListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called from the engine-event handler. A throwing subscriber must not take the event pump down. */
export function notifyWaitingTick(tick: number): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(tick);
    } catch {}
  }
}

export function waitingTickListenerCount(): number {
  return listeners.size;
}
