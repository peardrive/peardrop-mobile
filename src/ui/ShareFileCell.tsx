import React from "react";

import { useVideoThumbnail } from "../lib/videoThumbnail";
import {
  FileGridCell,
  FileListRow,
  type FileViewColors,
} from "../vendor/pearkit/FileViews/FileRows";
import type { FileViewItem } from "../vendor/pearkit/FileViews/fileViewLogic";

export type ShareFileCellProps = {
  /** Which of the two small shapes to draw. The expanded view is `ShareRow`. */
  view: "list" | "grid";
  item: FileViewItem;
  /** A video on this phone, to take one frame from when the share has no picture. */
  videoUri?: string | null;
  /** The row's place in the list, for the list view's shading. */
  index: number;
  /** The side of a grid picture. */
  tile: number;
  colors: FileViewColors;
  onPress: () => void;
  onLongPress: () => void;
};

/**
 * One share in the list view or the grid view. The shapes come from Pearkit; this adds the
 * one thing only the app can do, a frame from a video saved on the phone.
 */
export default function ShareFileCell({
  view,
  item,
  videoUri,
  index,
  tile,
  colors,
  onPress,
  onLongPress,
}: ShareFileCellProps) {
  const frame = useVideoThumbnail(item.thumbnail ? null : videoUri);
  const shown = !item.thumbnail && frame ? { ...item, thumbnail: frame } : item;
  return view === "grid" ? (
    <FileGridCell item={shown} tile={tile} colors={colors} onPress={onPress} onLongPress={onLongPress} />
  ) : (
    <FileListRow item={shown} index={index} colors={colors} onPress={onPress} onLongPress={onLongPress} />
  );
}
