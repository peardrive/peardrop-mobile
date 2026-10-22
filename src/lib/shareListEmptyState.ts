/**
 * Which empty state the shares list shows. An unreadable manifest must render as an error — an
 * empty list is otherwise pixel-identical to a new install, so every hosted share looks gone.
 */

/**
 * Restated verbatim from the engine's `MANIFEST_UNAVAILABLE_MESSAGE`; the two realms cannot share
 * a module because the worklet is packed separately. **Must not be reworded on either side.**
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
   * True when the empty list is a FAILURE, not an absence. The screen keys styling off this rather
   * than off `kind`, so a new error kind cannot be added and silently render in the calm palette.
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
