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
 * `serve` has three states: `true` announces, `false` is client-only, and absent lets the engine
 * apply its origin default. An absent flag reads as the default and never as `false`.
 */
export const RPC_DRIVES_RESUME = 28;
export const RPC_DRIVES_REMOVE = 29;
export const RPC_DRIVES_CHECK_FILES = 30;
export const RPC_TEST_FAKE_UPLOAD = 31;
export const RPC_REFRESH_SWARM = 32;
/** push the RN-side debugging flag down into the Bare worklet. */
export const RPC_SET_DEBUG_LOGGING = 33;
/**
 * A separate opcode rather than a flag on 31, because the two simulations produce different state:
 * this one writes a real `origin: "received"` entry so the share-key index resolves it.
 */
export const RPC_TEST_FAKE_DOWNLOAD = 34;
/**
 * Stop a transfer without destroying the drive. Separate from 21, which means Delete — a cancel
 * sharing an opcode with a delete is one `purge` flag away from being a delete again.
 */
export const RPC_HYPERDRIVE_CANCEL = 35;
/** Is anyone announcing these shares right now? Takes share keys, not discovery keys, because the sender's half of the app has no crypto and the engine derives them. */
// An empty key list is not a no-op: it destroys the shared node and reports it released, which is how the waiting loop stops paying for a list that has emptied.
export const RPC_PEERS_LOOKUP = 36;
export const RPC_LOOKUP_RELEASE = 37;
