import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import DotPager from "./DotPager";

export type OnboardingSlide = {
  key: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  body: string;
};

export type OnboardingCarouselProps = {
  slides: OnboardingSlide[];
  /** Label for the button on non-final pages ("Next"). */
  advanceLabel?: string;
  /** Label for the final page's button ("Get Started"). */
  finishLabel?: string;
  /** Fired when the user completes the final slide. */
  onFinish: () => void;
};

export default function OnboardingCarousel({
  slides,
  advanceLabel = "Next",
  finishLabel = "Get Started",
  onFinish,
}: OnboardingCarouselProps) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme, width), [theme, width]);
  const listRef = useRef<FlatList<OnboardingSlide>>(null);
  const [index, setIndex] = useState(0);

  const isLast = index === slides.length - 1;

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(e.nativeEvent.contentOffset.x / width);
      if (next !== index) setIndex(next);
    },
    [index, width],
  );

  const goNext = useCallback(() => {
    if (isLast) {
      onFinish();
      return;
    }
    const next = index + 1;
    listRef.current?.scrollToOffset({ offset: next * width, animated: true });
    setIndex(next);
  }, [index, isLast, onFinish, width]);

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={slides}
        keyExtractor={(s) => s.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        renderItem={({ item }) => (
          <View style={styles.slide}>
            <View style={styles.iconBadge}>
              <Ionicons name={item.icon} size={64} color={theme.primary} />
            </View>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
          </View>
        )}
      />
      <View style={styles.footer}>
        <DotPager count={slides.length} activeIndex={index} />
        <Pressable
          onPress={goNext}
          style={styles.cta}
          accessibilityRole="button"
          accessibilityLabel={isLast ? finishLabel : advanceLabel}
        >
          <Text style={styles.ctaLabel}>
            {isLast ? finishLabel : advanceLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme, width: number) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    // Slide content is centered vertically on the page. Reserving
    // `minHeight` on title + body (below) keeps the group's overall
    // height constant across all three slides, so centering lands the
    // icon/title/body at the same y-coordinate on each page — no
    // top-anchor padding needed.
    slide: {
      width,
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.pad * 1.5,
      gap: 20,
    },
    iconBadge: {
      width: 128,
      height: 128,
      borderRadius: 64,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8,
    },
    title: {
      color: theme.text,
      fontSize: 26,
      fontWeight: "800",
      textAlign: "center",
      minHeight: 32,
    },
    body: {
      color: theme.muted,
      fontSize: 15,
      lineHeight: 22,
      textAlign: "center",
      paddingHorizontal: 12,
      // Reserve 3 lines' worth so shorter copy on slide 2 doesn't pull
      // the visual weight of the slide upward compared to slide 1/3.
      minHeight: 66,
    },
    footer: {
      paddingHorizontal: theme.pad * 1.5,
      paddingTop: 16,
      paddingBottom: 32,
      gap: 20,
    },
    cta: {
      backgroundColor: theme.primary,
      borderRadius: theme.radius,
      paddingVertical: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    ctaLabel: {
      color: theme.onPrimary,
      fontSize: 16,
      fontWeight: "700",
    },
  });
}
