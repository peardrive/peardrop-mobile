import React, { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import SplashScreen from "../ui/SplashScreen";
import { isOnboardingComplete } from "../state/onboardingStorage";

type Nav = NativeStackNavigationProp<{
  Splash: undefined;
  Onboarding: undefined;
  Main: undefined;
  Settings: undefined;
}>;

/**
 * Route wrapper that plays the two-beat splash animation and then routes to
 * Onboarding (first-run) or Main (returning user), replacing the stack so
 * the splash cannot be back-navigated to.
 */
export default function SplashScreenRoute() {
  const nav = useNavigation<Nav>();

  const onFinish = useCallback(() => {
    void isOnboardingComplete().then((done) => {
      nav.reset({
        index: 0,
        routes: [{ name: done ? "Main" : "Onboarding" }],
      });
    });
  }, [nav]);

  return <SplashScreen onFinish={onFinish} />;
}
