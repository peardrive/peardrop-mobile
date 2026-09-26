/**
 * Which empty state the shares list shows. An unreadable manifest puts the
 * engine into an explicit unavailable state, and RN must show that as an
 * error: an empty list is otherwise pixel-identical to the "no shares yet"
 * state a new install shows, so every hosted share looks gone. The decision
 * is a pure function because `jest.config.js` is `testEnvironment: "node"`
 * and no `.tsx` here can be imported by a test; the screen only renders it.
 */

/**
 * Copied from the engine, not composed here.
 *
 * The one definition on the RN side. The engine's own copy is
 * `MANIFEST_UNAVAILABLE_MESSAGE` in `backend/hyperdrive-engine.mjs` (declared
 * just below `let manifestUnavailable`), which is also the `error.message` on
 * every rejected create/receive. The two realms cannot share a module — the
 * worklet bundle is packed separately — so the string is restated, verbatim,
 * and **must not be reworded on either side.**
 *
 * bans raw engine/native text as user-facing copy. This is not that: it is
 * a sentence written FOR the user that the engine happens to hold the master of,
 * carries no errno, no parser detail and no category, and says nothing about
 * networks, connectivity or expiry.
 */
export const MANIFEST_UNAVAILABLE_MESSAGE =
  "Couldn't load your shares — close and reopen PearDrop.";

/** Which view of the shares list the user is looking at. */
export type ShareListViewMode = "all" | "favorites";

export type ShareListEmptyKind =
  /** The list is empty because the engine could not read the manifest. */
  | "manifest-unavailable"
  /** Genuinely no favorites. */
  | "favorites"
  /** Genuinely no shares. */
  | "shares";

export type ShareListEmptyState = {
  kind: ShareListEmptyKind;
  /** Ionicons name for the badge. */
  icon: string;
  title: string;
  subtitle?: string;
  /**
   * True when the empty list is a FAILURE and not an absence.
   *
   * The screen keys its styling off this rather than off `kind`, so a future
   * error kind cannot be added and silently render in the calm palette.
   *
   * The field needs a reader to mean anything: a screen that takes `icon`,
   * `title` and `subtitle` and drops this one renders the manifest failure in
   * the calm palette. The readers are `MainScreen.tsx`'s `emptyState` memo,
   * which forwards it, and `src/ui/EmptyState.tsx`'s `isError` prop, which
   * selects the palette. A test reads those two files off disk, because no
   * `.tsx` in this project can be imported by a test.
   */
  isError: boolean;
};

/**
 * What an empty shares list means, and therefore what to show in its place.
 *
 * `manifestUnavailable` wins over every view filter. A user sitting in the
 * favorites tab when the manifest fails to load is in exactly the same trouble
 * as one in the all-shares tab, and "No favorites yet" would be a false
 * statement about state the app cannot currently read at all.
 *
 * Pure: no react, no react-native, no AsyncStorage. Takes the flat
 * `BackendAPI.manifestUnavailable` field (`src/state/backend.ts`) — **not**
 * `BridgeStatus`, and the `=== true` coercion is done there, once, not here.
 */
export function shareListEmptyState(args: {
  /** `BackendAPI.manifestUnavailable`, already coerced by `backend.ts`. */
  manifestUnavailable: boolean;
  viewMode: ShareListViewMode;
}): ShareListEmptyState {
  if (args.manifestUnavailable) {
    return {
      kind: "manifest-unavailable",
      icon: "alert-circle-outline",
      // The engine's sentence, whole and unsplit. Splitting it across
      // title/subtitle would be rewording it, which the ruling does not allow.
      title: MANIFEST_UNAVAILABLE_MESSAGE,
      isError: true,
    };
  }

  if (args.viewMode === "favorites") {
    return {
      kind: "favorites",
      icon: "heart-outline",
      title: "No favorites yet",
      subtitle: "Tap the heart on a share to add it.",
      isError: false,
    };
  }

  return {
    kind: "shares",
    icon: "folder-open-outline",
    title: "Nothing here yet",
    subtitle: "Pick files above or paste a link.",
    isError: false,
  };
}
