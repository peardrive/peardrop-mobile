/**
 * The rules of the media player.
 *
 * They live in Pearkit, the library every app shares, and this app keeps a copy made by
 * `npm run pearkit:sync` (see `src/vendor/pearkit/MediaPlayer/README.md`). This file only gives
 * them the address the rest of the app already uses; the rules, and their tests, are in the copy.
 */
export * from "../vendor/pearkit/MediaPlayer/playerLogic";
