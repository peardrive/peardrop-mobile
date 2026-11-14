# FileViews

The same files shown three ways, with one switcher to choose: a tight **list**, the roomy
**expanded** list, and a **grid**. Made for PearDrop first, and shaped so PearDrive, pearcast,
GenBuddy, MediaMeta and every later app use the same piece.

See it: `npm run storybook`, then **Components → FileViews**.

## What it is

| Part | What it is |
| --- | --- |
| `ViewSwitcher` | The three icon buttons (or one button that steps through the views). |
| `ViewMenu` | One button showing the view in use; a press drops a short list of the views under it. For a toolbar that needs its width. The list opens in the app's own pop-up window, passed as `cover`. |
| `FileListRow` | The list view: one 40-point line, like a folder in Finder. Small picture, name, state at the right, every other line shaded. |
| `FileExpandedRow` | The expanded view: larger picture, name, a line under it. An app with a row of its own keeps it (PearDrop does). |
| `FileGridCell` | The grid view: four pictures across, then two small lines, the name (cut in the middle so its ending shows) and the state. |
| `FileThumb` | The square picture of a file: its thumbnail, or an icon for its kind, with the pie and the selection tick. |
| `DownloadPie` | The pie laid over a picture while the file is arriving, as an iPhone shows an app downloading. |
| `FileViews` | A ready-made scrolling list that lays the three shapes out, for an app with no list of its own. |
| `useFileItems` | Keeps a list of files from a place (a folder, a network key) up to date. |
| `FileViewIcon` | The icons: `view-list`, `view-expanded`, `view-grid`, the `kind-` icons, `tick`, `more`. |
| `fileViewLogic.ts` | Every rule with no screen in it: the views, the status words, the grid sizes, the pie. Tested in `fileViewLogic.test.ts`. |

## The rules it holds

- **One file record, three views.** Every view draws from `FileViewItem` (`id`, `name`, `kind`,
  `status`, `tone`, `download`, `detail`, `thumbnail`, `dim`, `selected`, and the app's own
  record in `extra`). Switching views never changes what is known about a file.
- **The status is one state, never a chain.** `transferStatus()` speaks the universal words of
  `ShareState`: "Sharing 12%" or "Downloading 12%" while it moves, then "Active". Nothing like
  "Saved · Sharing · 12%". `transferTone()` and `transferBar()` give the colour and the bar.
- **The pie is for downloads only.** `downloadPie()` gives a file its `download` (0 to 1) while it
  is arriving and nothing otherwise. An upload shows how far it is in its status line.
- **Four across, in three sizes.** `gridMetrics(width)` fits four square tiles to any width; the
  two lines of text under a tile grow with it (`gridText`). `GRID_SIZES` are the three a person
  chooses between: Large (3 across), Medium (4), Small (5).
- **The view icons share one gap**, so each reads as separate things: four thin lines, three
  solid blocks, four solid squares. They are drawn by `scripts/draw-own-icons.mjs`.

## Using it

An app with a list of its own (PearDrop: pull to refresh, swipe to delete, its own header)
uses the shapes inside it:

```tsx
<ViewSwitcher value={mode} onChange={setMode} accent={theme.primary} />
// or one button with a drop-down list, opening in the app's own pop-up window:
// `base` is only for an app whose surface colour is see-through: a solid colour painted under it.
<ViewMenu value={mode} onChange={setMode} cover={AppModal} accent={theme.primary} base={theme.bg} />

// list:   <FileListRow item={item} index={index} onPress={open} onLongPress={menu} />
// grid:   <FileGridCell item={item} tile={gridMetrics(width).tile} onPress={open} onLongPress={menu} />
// expanded: the app's own row, or <FileExpandedRow item={item} onPress={open} onMore={menu} />
```

An app with no list of its own uses the whole thing:

```tsx
<FileViews items={items} mode={mode} onOpen={open} onMore={menu} />
```

Colours come from the app (`colors`, a `FileViewColors`); the dark defaults are only a start.
The app's own picture for a file (a video frame, a cover) goes in through `renderThumb`.

## Where the files come from

The views never read a disk or a network. An app writes one **reader** for each kind of place
it can list, and the views draw what it returns:

```ts
type FileSource =
  | { from: 'disk'; folder: string }
  | { from: 'key'; key: string; network: 'hyperdrive' | 'pearcore' };

const reader: FileReader = {
  list: async (source) => /* the files of that folder, drive or space, as FileViewItem[] */,
  watch: (source, onChange) => /* call onChange when it changes; return a function that stops */,
};

const { items, loading, error, reload } = useFileItems(reader, source);
```

So a folder on the phone, a Hyperdrive key and a pearcore space are shown by the same views,
and a new kind of place is a new reader, never a change to a view. PearDrop does not need a
reader yet: it already holds its list of shares and hands them over as `FileViewItem`s.

## How this grows without disturbing an app that already uses it

This is the scaffolding for every app, so the rule is fixed now:

1. **Anything new is optional and off by default.** A new ability is a new optional prop or a new
   optional field of `FileViewItem`. An app that does not pass it looks and behaves exactly as it
   did. Nothing existing changes meaning.
2. **A new view is a new name in `FileViewMode`**, with its own row shape. An app only shows the
   views it lists in `modes`, so a social view or a wall of pictures built for one app never
   appears in another by itself. PearDrop lists `list`, `expanded`, `grid`.
3. **Looks are shared, on purpose.** A change to how a row, a tile, an icon or the pie is drawn
   reaches every app the next time it takes a copy. That is the point of having one.
4. **Words and sizes live in `fileViewLogic.ts`** and are tested there, so a change to them is
   seen in a failing test before it is seen in an app.

Not here yet, and where each would go: a social view and a wall view (new modes), sorting and
column headers for the list (optional props of `FileListRow`), choosing several files by
dragging (optional prop of `FileViews`), readers for Hyperdrive and pearcore (in the apps, or a
`FileViews/readers/` folder once two apps share one).

## A note on styling

Like `MediaPlayer`, this piece uses plain `StyleSheet` styles, not class names, so the phone
apps (which have no NativeWind) can take it as it is.
