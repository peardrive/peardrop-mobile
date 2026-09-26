export const RPC_EVENT = 0;
export const RPC_LISTEN = 1;

export const RPC_HYPERDRIVE_SHARE = 20;
export const RPC_HYPERDRIVE_STOP = 21;
export const RPC_HYPERDRIVE_OPEN = 22;
export const RPC_HYPERDRIVE_ABORT = 23;
export const RPC_HYPERDRIVE_DOWNLOAD = 24;
export const RPC_HYPERDRIVE_STATUS = 25;
export const RPC_DRIVES_LIST = 26;
export const RPC_DRIVES_PAUSE = 27;
/**
 * `serve` has three states, not two: `true` announces, `false` is client-only, and
 * absent means the engine applies its origin-derived default, which keeps a received
 * drive client-only. An absent flag reads as the default and never as `false`.
 * `already` is true only when the swarm is already in the mode asked for.
 */
export const RPC_DRIVES_RESUME = 28;
export const RPC_DRIVES_REMOVE = 29;
export const RPC_DRIVES_CHECK_FILES = 30;
export const RPC_TEST_FAKE_UPLOAD = 31;
export const RPC_REFRESH_SWARM = 32;
/** push the RN-side debugging flag down into the Bare worklet. */
export const RPC_SET_DEBUG_LOGGING = 33;
/**
 * Receive-side counterpart to RPC_TEST_FAKE_UPLOAD. A separate opcode rather
 * than a flag on 31, because the two simulations produce different engine
 * state: the upload one creates no drive at all, while this one writes a real
 * `origin: "received"` manifest entry so the share-key index resolves it
 * exactly as a real grab does.
 */
export const RPC_TEST_FAKE_DOWNLOAD = 34;
/**
 * Stop a transfer in flight without destroying the drive. A separate opcode
 * rather than a flag on 21 (STOP), because 21 means Delete: it closes the
 * store and `fs.rm`s the corestore. A cancel that shares an opcode with a
 * delete is one `purge` flag away from being a delete again.
 */
export const RPC_HYPERDRIVE_CANCEL = 35;
