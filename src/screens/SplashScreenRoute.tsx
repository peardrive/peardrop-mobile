import React, { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import SplashScreen from "../ui/SplashScreen";
import { isOnboardingComplete } from "../state/onboardingStorage";
import { openIntentGate } from "../lib/pendingIntents";

type Nav = NativeStackNavigationProp<{
  Splash: undefined;
  Onboarding: undefined;
  Main: undefined;
  Settings: undefined;
}>;

/**
 * Plays the splash animation and then routes to Onboarding or Main,
 * replacing the stack so the splash cannot be back-navigated to.
 */
export default function SplashScreenRoute() {
  const nav = useNavigation<Nav>();

  const onFinish = useCallback(() => {
    void isOnboardingComplete().then((done) => {
      nav.reset({
        index: 0,
        routes: [{ name: done ? "Main" : "Onboarding" }],
      });
      // A link can arrive before this reset runs and would be discarded, so intents are held and
      // released here — only for a returning user; Onboarding opens the gate for a first run.
      if (done) openIntentGate();
    });
  }, [nav]);

  return <SplashScreen onFinish={onFinish} />;
}
