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
      // a link tapped from another app can be delivered before
      // this reset runs, and the reset would discard anything acted on
      // earlier. So incoming intents are held (see lib/pendingIntents)
      // and released here, after the reset — but only for a returning
      // user, who lands on Main. A first-run user is being sent to
      // Onboarding instead; the gate stays shut so the link waits rather
      // than interrupting, and OnboardingScreen opens it on completion.
      if (done) openIntentGate();
    });
  }, [nav]);

  return <SplashScreen onFinish={onFinish} />;
}
