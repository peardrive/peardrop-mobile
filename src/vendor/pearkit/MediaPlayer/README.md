# MediaPlayer

One player for video, sound and pictures, the same on iPhone, Android and the web.

See it: `npm run storybook`, then **Components → MediaPlayer**. Use the mouse as a finger.

## What it does

- Play and pause, 15 seconds back and forward, a bar to drag.
- An options box that drops down from its button (top right), one line per setting:
  **Speed** (minus, value, plus), **Loop** (switch), **Orientation** (auto, upright, sideways),
  **Captions** (language and a switch). Sound shows Speed and Loop; a picture has no options.
- Swipe **up** to put the player away. Swipe **left or right** to move to the next or previous file.
- A file that cannot be shown says "Cannot display this file." (one message for every kind of file) and offers the share button; it never leaves a blank screen.

## How it is put together

| File | What it is |
| --- | --- |
| `playerLogic.ts` | Every rule, as plain functions with no screen: what a button does, how far a swipe must go, how a caption track is named, how big the menu is. Tested in `playerLogic.test.ts`. |
| `MediaPlayer.tsx` | The player: draws the controls and turns touches into calls on the rules. |
| `PlayerMenu.tsx` | The options box. |
| `PlayerIcon.tsx` | The player's own filled icons (shapes from Phosphor Icons, MIT, plus four drawn for it). |
| `web/WebMedia.tsx` | The engine for a browser (`<video>`, `<audio>`), used by Storybook and desktop apps. |

The player does not play anything itself. The app gives it an **engine**: eight small calls
(`play`, `pause`, `seekTo`, `setRate`, `setLoop`, `read`, `captions`, `chooseCaption`) onto
whatever plays files there, such as expo-video on a phone or a `<video>` element in a browser. That is
what lets one player run everywhere, and what lets the rules be tested without a device.

```tsx
const { engine, attach } = useWebMedia();

<MediaPlayer
  kind="video"
  title="Holiday.mp4"
  engine={engine}
  settings={settings}                       // { loop, rotation }: the app stores these
  onSettingsChange={(change) => save(change)}
  onClose={close}
  onShare={share}
  onNext={next ? (state) => open(next, state.playing) : undefined}
  onPrevious={previous ? (state) => open(previous, state.playing) : undefined}
>
  <WebVideo src={url} attach={attach} />
</MediaPlayer>
```

Three things stay with the app, because only the app can do them:

1. **Turning the screen.** The window that holds the player has to allow it. Use
   `screenRotationFor` and `windowOrientationsFor` from the rules to decide.
2. **Remembering Loop and Orientation.** The player reports changes; the app saves them.
3. **The list of files.** Give `onNext` / `onPrevious` only when there is a file that way, and
   answer by showing a new player (a new `key`) with `enterFrom` set to the side it arrives from.

## One exception to the library's rules

Everything else in Pearkit is styled with class names (NativeWind). This folder uses plain
React Native styles and imports only `react`, `react-native` and `react-native-svg`. That is on
purpose: an app can take a copy of this folder without setting up NativeWind first.

## Using it in an app today

Until Pearkit is published as a package, an app keeps a copy made by a script, never by hand
(PearDrop mobile: `npm run pearkit:sync`, and `npm run pearkit:check` to prove the copy is
untouched and current). Change the player here, look at it in Storybook, then sync the apps.

## Not yet proven

- Android on a real device (it compiles; nobody has held it).
- Tablets.
