# ShareState

The universal states of a share: **one word, one colour and one progress bar for each state**,
the same in every app and every layout (phone list, phone grid, desktop). An app works out which
state a share is in; this piece decides everything a person sees about it.

See it: `npm run storybook`, then **Components → ShareState**.

| State | Line | Colour | Bar | Button |
| --- | --- | --- | --- | --- |
| `active` | Active | green | none | |
| `sharing` | Sharing 12% | amber | moving | |
| `downloading` | Downloading 48% | amber | moving | Pause |
| `starting` | Starting | amber | moving | Pause |
| `waiting` | Waiting 23% | amber | holding (flat, faint amber) | Pause |
| `paused` | Paused 23% | amber | stopped (flat grey) | Resume |
| `inactive` | Inactive | grey, row drawn fainter | none | |
| `choose` | Choose files | amber | none | |
| `attention` | what is wrong ("Not enough space") | red | none | |

## The rules it holds

- **Green is finished, amber is not finished, grey is off, red needs you.** The three amber
  states that are not moving are told apart by the bar, not by another colour.
- **One state, never a chain.** No "Saved · Sharing", no "Paused · sender offline". Why a share
  is waiting belongs in its details window.
- **Waiting is not paused.** Waiting carries on by itself when the other side appears. Paused is
  only ever the person's own choice, and it never restarts by itself.
- **Only a share that is switched off is drawn fainter.** A file that is here is never dimmed.
- **No type word in the line.** "Picture" and "Video" are shown by the icon.

## Using it

```ts
import { describeShareState, ShareProgressBar } from '.../ShareState';

const view = describeShareState({ kind: 'downloading', percent: 48 });
// view.label "Downloading 48%", view.tone "busy", view.bar { look: 'moving', value: 0.48 },
// view.toggle "pause", view.dim false
```

`ShareProgressBar` has the look of Pearkit's `ProgressBar` and needs only react-native-svg, so
an app that copies the piece needs nothing else. `shareBarColorsFrom({ busy, good })` makes its
colours from the app's own amber and green. `FileViews` uses both: `transferStatus()` speaks
these words, and `FileExpandedRow` draws the bar from a file's `bar`.
