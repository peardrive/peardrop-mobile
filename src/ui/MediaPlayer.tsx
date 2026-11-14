import React, { useMemo } from "react";
import { Image, Platform, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import { useAudioPlayer, type AudioPlayer } from "expo-audio";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";

import type { MediaEngine, PlayerKind } from "../lib/playerLogic";
import { getPlayerSettings, setPlayerSettings, usePlayerSettings } from "../state/playerSettingsStorage";
import { useAppTheme } from "../state/ThemeContext";
import {
  MediaPlayer as PearkitPlayer,
  type MediaPlayerProps as PearkitPlayerProps,
} from "../vendor/pearkit/MediaPlayer/MediaPlayer";
import type { PlayerGlass } from "../vendor/pearkit/MediaPlayer/PlayerMenu";
import { useScreenInsets } from "./useScreenInsets";

/**
 * The media player in this app: video, sound and pictures.
 *
 * The player itself (the controls, the options menu, the swipes) is the Pearkit piece copied into
 * `src/vendor/pearkit/MediaPlayer/`; it is the same in every app and is changed there, never
 * here. This file is the part only this app can supply: what plays a file on a phone
 * (expo-video, expo-audio), the saved Loop and Orientation, the edges of this screen, the app's
 * colour and the frosted glass.
 *
 * It is drawn inside the app's preview modal and never opens a modal of its own. Turning the
 * screen is done by the host (`usePlayerRotation`), because the modal that holds the player has
 * to allow it.
 */

export type MediaPlayerProps = {
  kind: PlayerKind;
  /** A `file://` address. */
  uri: string;
  title: string;
  onClose: () => void;
  /** Hand the file to another app. */
  onOpenElsewhere: () => void;
  /** Swipe left / right: given only when there is a file that way. */
  onNext?: PearkitPlayerProps["onNext"];
  onPrevious?: PearkitPlayerProps["onPrevious"];
  /** Start playing at once: the file before it was playing when the user swiped. */
  autoPlay?: boolean;
  /** The side this file arrives from, when it was reached by a swipe. */
  enterFrom?: "left" | "right" | null;
  /** An extra row under the bar, such as the share button of a file the user is sharing. */
  footer?: React.ReactNode;
};

export function MediaPlayer(props: MediaPlayerProps) {
  if (props.kind === "video") return <VideoStage {...props} />;
  if (props.kind === "audio") return <AudioStage {...props} />;
  return <ImageStage {...props} />;
}

function videoEngine(player: VideoPlayer): MediaEngine {
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seekTo: (seconds) => {
      player.currentTime = seconds;
    },
    setRate: (rate) => {
      player.preservesPitch = true;
      player.playbackRate = rate;
    },
    setLoop: (loop) => {
      player.loop = loop;
    },
    read: () => ({
      position: Number(player.currentTime),
      duration: Number(player.duration),
      playing: player.playing === true,
      // A format the phone cannot play (mkv, avi, webm on iPhone) ends up here.
      failed: player.status === "error",
    }),
    captions: () => ({
      tracks: player.availableSubtitleTracks ?? [],
      current: player.subtitleTrack ?? null,
    }),
    chooseCaption: (index) => {
      const tracks = player.availableSubtitleTracks ?? [];
      player.subtitleTrack = index >= 0 ? (tracks[index] ?? null) : null;
    },
  };
}

function audioEngine(player: AudioPlayer): MediaEngine {
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seekTo: (seconds) => {
      void Promise.resolve(player.seekTo(seconds)).catch(() => {});
    },
    setRate: (rate) => {
      player.shouldCorrectPitch = true;
      player.setPlaybackRate(rate);
    },
    setLoop: (loop) => {
      player.loop = loop;
    },
    read: () => ({
      position: Number(player.currentTime),
      duration: Number(player.duration),
      playing: player.playing === true,
      failed: false,
    }),
    captions: () => ({ tracks: [], current: null }),
    chooseCaption: () => {},
  };
}

// iPhone has real frosted glass. Android's blur is unreliable inside a modal, so there the menu
// is the player's own dark panel.
const Glass: PlayerGlass | undefined =
  Platform.OS === "ios"
    ? ({ style, children }) => (
        <BlurView intensity={55} tint="dark" style={style}>
          {children}
        </BlurView>
      )
    : undefined;

/** What every kind of file gives the Pearkit player from this app. */
function useShared(props: MediaPlayerProps) {
  const { theme } = useAppTheme();
  const settings = usePlayerSettings();
  const insets = useScreenInsets();
  return {
    title: props.title,
    settings,
    onSettingsChange: setPlayerSettings,
    onClose: props.onClose,
    onShare: props.onOpenElsewhere,
    onNext: props.onNext,
    onPrevious: props.onPrevious,
    autoPlay: props.autoPlay,
    enterFrom: props.enterFrom,
    insets,
    footer: props.footer,
    accent: theme.primary,
    glass: Glass,
    failedText: "PearDrop can't display this file.",
  } satisfies Omit<PearkitPlayerProps, "kind" | "engine" | "children">;
}

function VideoStage(props: MediaPlayerProps) {
  const shared = useShared(props);
  const player = useVideoPlayer(props.uri, (p) => {
    p.loop = getPlayerSettings().loop;
  });
  const engine = useMemo(() => videoEngine(player), [player]);
  return (
    <PearkitPlayer kind="video" engine={engine} {...shared}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        allowsFullscreen={false}
        nativeControls={false}
        // iPhone otherwise puts its own "scan the text" button on a paused picture.
        allowsVideoFrameAnalysis={false}
        // Android: a picture drawn this way moves with the player when it is swiped away.
        surfaceType="textureView"
        contentFit="contain"
      />
    </PearkitPlayer>
  );
}

function AudioStage(props: MediaPlayerProps) {
  const shared = useShared(props);
  const player = useAudioPlayer(props.uri);
  const engine = useMemo(() => audioEngine(player), [player]);
  return <PearkitPlayer kind="audio" engine={engine} {...shared} />;
}

function ImageStage(props: MediaPlayerProps) {
  const shared = useShared(props);
  return (
    <PearkitPlayer kind="image" {...shared}>
      <Image source={{ uri: props.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
    </PearkitPlayer>
  );
}
