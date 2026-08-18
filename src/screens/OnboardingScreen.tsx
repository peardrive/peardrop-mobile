import React, { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import OnboardingCarousel, {
  type OnboardingSlide,
} from "../ui/OnboardingCarousel";
import { markOnboardingComplete } from "../state/onboardingStorage";
import { useAppTheme } from "../state/ThemeContext";

type Nav = NativeStackNavigationProp<{
  Main: undefined;
  Onboarding: undefined;
  Splash: undefined;
  Settings: undefined;
}>;

const SLIDES: OnboardingSlide[] = [
  {
    key: "share",
    icon: "share-social-outline",
    title: "Share anything",
    body: "Send files directly to anyone — no servers, no accounts, no limits.",
  },
  {
    key: "private",
    icon: "shield-checkmark-outline",
    title: "Fully private",
    body: "End-to-end encrypted. Your files go directly to the recipient.",
  },
  {
    key: "ready",
    icon: "checkmark-circle-outline",
    title: "You're all set",
    body: "Your identity is ready. Share your link with anyone to start transferring files.",
  },
];

export default function OnboardingScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();

  const onFinish = useCallback(() => {
    void markOnboardingComplete();
    nav.reset({ index: 0, routes: [{ name: "Main" }] });
  }, [nav]);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.bg,
          paddingTop: insets.top,
        },
      ]}
    >
      <OnboardingCarousel slides={SLIDES} onFinish={onFinish} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
