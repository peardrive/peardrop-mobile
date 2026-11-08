/** Foreground re-announce cadence, and the one extra refresh a network change earns. */

/** Hyperdht's own announcer cycle; a network change is covered by the debounced refresh below. */
export const FOREGROUND_REFRESH_MS = 5 * 60_000;

/** Longer than the spread between swarms noticing one change, so a Wi-Fi switch costs one refresh. */
export const NETWORK_REFRESH_DEBOUNCE_MS = 8_000;

export type NetworkRefresh = {
  /** Records a change; the refresh runs once the burst has been quiet for the debounce. */
  note: () => void;
  cancel: () => void;
};

export function createNetworkRefresh(
  run: () => void,
  debounceMs: number = NETWORK_REFRESH_DEBOUNCE_MS
): NetworkRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    note: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, debounceMs);
    },
    cancel,
  };
}
