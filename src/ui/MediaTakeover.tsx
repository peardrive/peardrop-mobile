import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import { formatClock } from "../lib/format";

export type MediaTakeoverMode = "image" | "video" | "audio" | "text";

export type MediaTakeoverProps = {
  visible: boolean;
  onClose: () => void;
  mode: MediaTakeoverMode;
  /** Playable URI for image/video/audio. */
  uri?: string | null;
  /** Body text for `mode === "text"`. */
  textBody?: string;
  /** Title shown in accessibility labels and audio caption. */
  title?: string;
  /**
   * Optional overflow ("three dots") menu handler. When omitted, the
   * top-right menu button is hidden.
   */
  onMenu?: () => void;
};

const CHROME_HIDE_MS = 3000;

/**
 * Fullscreen media takeover. Renders on a pure-black backdrop with
 * translucent chrome (back arrow top-left, optional overflow top-right,
 * translucent bottom bar for video). Chrome auto-hides ~3 s during video
 * playback; other modes keep chrome pinned. Reduce-motion disables the
 * auto-hide fade so controls remain visible.
 */
export default function MediaTakeover({
  visible,
  onClose,
  mode,
  uri,
  textBody,
  title,
  onMenu,
}: MediaTakeoverProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const audioPlayer = useAudioPlayer(mode === "audio" && uri ? uri : null);
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const videoPlayer = useVideoPlayer(
    mode === "video" && uri ? uri : null,
    (player) => {
      try {
        player.loop = false;
      } catch {}
    },
  );

  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [scrubWidth, setScrubWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduceMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (v) => {
        if (mounted) setReduceMotion(v);
      },
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // Poll audio position at 4 Hz while open.
  useEffect(() => {
    if (mode !== "audio" || !audioPlayer) {
      setAudioPosition(0);
      setAudioDuration(0);
      return;
    }
    const tick = () => {
      try {
        const pos = Number(audioPlayer.currentTime || 0);
        const dur = Number(audioPlayer.duration || 0);
        if (Number.isFinite(pos)) setAudioPosition(pos);
        if (Number.isFinite(dur) && dur > 0) setAudioDuration(dur);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [mode, audioPlayer]);

  // Poll video playing state at 4 Hz while open.
  useEffect(() => {
    if (mode !== "video" || !videoPlayer) {
      setVideoIsPlaying(false);
      return;
    }
    const tick = () => {
      try {
        setVideoIsPlaying(!!videoPlayer.playing);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [mode, videoPlayer]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const showChrome = useCallback(() => {
    clearHideTimer();
    setChromeVisible(true);
    Animated.timing(chromeOpacity, {
      toValue: 1,
      duration: reduceMotion ? 0 : 150,
      useNativeDriver: true,
    }).start();
  }, [chromeOpacity, clearHideTimer, reduceMotion]);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    if (mode !== "video" || !videoIsPlaying || reduceMotion) return;
    hideTimerRef.current = setTimeout(() => {
      Animated.timing(chromeOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setChromeVisible(false);
      });
    }, CHROME_HIDE_MS);
  }, [chromeOpacity, clearHideTimer, mode, reduceMotion, videoIsPlaying]);

  useEffect(() => {
    if (!visible) {
      clearHideTimer();
      return;
    }
    showChrome();
    scheduleHide();
    return clearHideTimer;
  }, [visible, videoIsPlaying, mode, clearHideTimer, scheduleHide, showChrome]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  const onVideoTap = useCallback(() => {
    if (!videoPlayer) return;
    try {
      if (videoPlayer.playing) videoPlayer.pause();
      else videoPlayer.play();
    } catch {}
    showChrome();
    scheduleHide();
  }, [scheduleHide, showChrome, videoPlayer]);

  const onAudioSkip = useCallback(
    (deltaSec: number) => {
      if (!audioPlayer) return;
      try {
        const dur = Number(audioPlayer.duration || 0);
        const cur = Number(audioPlayer.currentTime || 0);
        const next = Math.max(0, Math.min(dur, cur + deltaSec));
        audioPlayer.seekTo(next);
      } catch {}
    },
    [audioPlayer],
  );

  const onAudioSeekToFraction = useCallback(
    (fraction: number) => {
      if (!audioPlayer) return;
      try {
        const dur = Number(audioPlayer.duration || 0);
        if (dur > 0) audioPlayer.seekTo(dur * fraction);
      } catch {}
    },
    [audioPlayer],
  );

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
    >
      {mode === "text" ? (
        <View style={styles.textRoot}>
          <ScrollView style={styles.textScroll}>
            <Text style={styles.textBody}>{textBody || "(Empty file)"}</Text>
          </ScrollView>
          <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
            <Pressable
              style={styles.topBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={16}
            >
              <Ionicons name="arrow-back" size={24} color={theme.text} />
            </Pressable>
            {onMenu ? (
              <Pressable
                style={styles.topBtn}
                onPress={onMenu}
                accessibilityRole="button"
                accessibilityLabel="More"
                hitSlop={16}
              >
                <Ionicons
                  name="ellipsis-horizontal"
                  size={22}
                  color={theme.text}
                />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : (
        <View style={styles.root}>
          <View style={styles.mediaWrap}>
            {mode === "image" && uri ? (
              <Image
                source={{ uri }}
                style={styles.image}
                resizeMode="contain"
              />
            ) : null}
            {mode === "video" && uri ? (
              <VideoView
                player={videoPlayer}
                style={styles.video}
                allowsFullscreen={false}
                nativeControls={false}
                contentFit="contain"
              />
            ) : null}
            {mode === "audio" && uri ? (
              <View style={styles.audioShell}>
                <View style={styles.audioCover}>
                  <Ionicons
                    name="musical-notes-outline"
                    size={72}
                    color="rgba(255,255,255,0.55)"
                  />
                </View>
                {title ? (
                  <Text style={styles.audioTitle} numberOfLines={1}>
                    {title}
                  </Text>
                ) : null}
                <View style={styles.audioControls}>
                  <Pressable
                    style={styles.audioCtrl}
                    onPress={() => onAudioSkip(-15)}
                    accessibilityRole="button"
                    accessibilityLabel="Skip back 15 seconds"
                  >
                    <Ionicons name="play-back" size={22} color="#fff" />
                  </Pressable>
                  <Pressable
                    style={styles.audioPlay}
                    onPress={() => {
                      if (!audioPlayer) return;
                      if (audioPlayer.playing) audioPlayer.pause();
                      else {
                        if (
                          audioStatus.didJustFinish ||
                          audioPlayer.currentTime >= audioPlayer.duration
                        ) {
                          audioPlayer.seekTo(0);
                        }
                        audioPlayer.play();
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={audioPlayer?.playing ? "Pause" : "Play"}
                  >
                    <Ionicons
                      name={audioPlayer?.playing ? "pause" : "play"}
                      size={28}
                      color="#000"
                    />
                  </Pressable>
                  <Pressable
                    style={styles.audioCtrl}
                    onPress={() => onAudioSkip(15)}
                    accessibilityRole="button"
                    accessibilityLabel="Skip forward 15 seconds"
                  >
                    <Ionicons name="play-forward" size={22} color="#fff" />
                  </Pressable>
                </View>
                <View style={styles.scrubWrap}>
                  <Pressable
                    style={styles.scrubber}
                    onLayout={(e) => setScrubWidth(e.nativeEvent.layout.width)}
                    onPress={(e) => {
                      if (scrubWidth <= 0) return;
                      const x = e.nativeEvent.locationX;
                      onAudioSeekToFraction(
                        Math.max(0, Math.min(1, x / scrubWidth)),
                      );
                    }}
                    accessibilityRole="adjustable"
                    accessibilityLabel="Audio progress"
                  >
                    <View style={styles.scrubTrack}>
                      <View
                        style={[
                          styles.scrubFill,
                          {
                            width: `${
                              audioDuration > 0
                                ? Math.max(
                                    0,
                                    Math.min(
                                      100,
                                      (audioPosition / audioDuration) * 100,
                                    ),
                                  )
                                : 0
                            }%`,
                          },
                        ]}
                      />
                    </View>
                  </Pressable>
                  <View style={styles.timeRow}>
                    <Text style={styles.timeText}>
                      {formatClock(audioPosition)}
                    </Text>
                    <Text style={styles.timeText}>
                      {audioDuration > 0 ? formatClock(audioDuration) : "—:—"}
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}
          </View>

          {mode === "video" ? (
            <Pressable
              style={styles.tapLayer}
              onPress={onVideoTap}
              accessibilityRole="button"
              accessibilityLabel={videoIsPlaying ? "Pause video" : "Play video"}
            />
          ) : null}

          {mode === "video" && !videoIsPlaying ? (
            <View pointerEvents="box-none" style={styles.centerPlay}>
              <Pressable
                style={styles.centerPlayBtn}
                onPress={onVideoTap}
                accessibilityRole="button"
                accessibilityLabel="Play"
                hitSlop={8}
              >
                <Ionicons name="play" size={36} color="rgba(255,255,255,0.92)" />
              </Pressable>
            </View>
          ) : null}

          <Animated.View
            pointerEvents={chromeVisible ? "box-none" : "none"}
            style={[
              styles.topBar,
              { opacity: chromeOpacity, paddingTop: insets.top + 4 },
            ]}
          >
            <Pressable
              style={styles.topBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={16}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </Pressable>
            {onMenu ? (
              <Pressable
                style={styles.topBtn}
                onPress={onMenu}
                accessibilityRole="button"
                accessibilityLabel="More"
                hitSlop={16}
              >
                <Ionicons
                  name="ellipsis-horizontal"
                  size={22}
                  color="#fff"
                />
              </Pressable>
            ) : null}
          </Animated.View>
        </View>
      )}
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: "#000",
    },
    mediaWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
    image: { width: "100%", height: "100%" },
    video: { width: "100%", height: "100%" },
    audioShell: {
      flex: 1,
      alignSelf: "stretch",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      gap: 24,
    },
    audioCover: {
      width: 168,
      height: 168,
      borderRadius: 20,
      backgroundColor: "rgba(255,255,255,0.08)",
      alignItems: "center",
      justifyContent: "center",
    },
    audioTitle: {
      color: "#fff",
      fontSize: 16,
      fontWeight: "600",
      textAlign: "center",
    },
    audioControls: {
      flexDirection: "row",
      alignItems: "center",
      gap: 24,
    },
    audioCtrl: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    audioPlay: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: "#fff",
      alignItems: "center",
      justifyContent: "center",
    },
    scrubWrap: { alignSelf: "stretch", gap: 6 },
    scrubber: { paddingVertical: 8 },
    scrubTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: "rgba(255,255,255,0.2)",
      overflow: "hidden",
    },
    scrubFill: { height: "100%", backgroundColor: "#fff" },
    timeRow: { flexDirection: "row", justifyContent: "space-between" },
    timeText: { color: "rgba(255,255,255,0.7)", fontSize: 12 },
    tapLayer: {
      position: "absolute",
      inset: 0,
    },
    centerPlay: {
      position: "absolute",
      inset: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    centerPlayBtn: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: "rgba(0,0,0,0.45)",
      alignItems: "center",
      justifyContent: "center",
    },
    topBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 8,
      paddingBottom: 8,
    },
    topBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.35)",
    },
    textRoot: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    textScroll: {
      flex: 1,
      paddingTop: 60,
      paddingHorizontal: 20,
    },
    textBody: {
      color: theme.text,
      fontSize: 14,
      lineHeight: 22,
      paddingBottom: 40,
    },
  });
}
