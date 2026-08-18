// A native stack, not a tab navigator: the app collapsed to a single unified
// main page. The launch flow (Splash → Onboarding) leads into Main + Settings.
// The `Tabs.tsx` filename is retained to avoid import churn.
import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import MainScreen from "../screens/MainScreen";
import SettingsScreen from "../screens/SettingsScreen";
import SplashScreenRoute from "../screens/SplashScreenRoute";
import OnboardingScreen from "../screens/OnboardingScreen";
import StatusRoute from "../screens/StatusRoute";
import ReportBugScreen from "../screens/ReportBugScreen";

const Stack = createNativeStackNavigator();

export default function RootNav() {
  return (
    <Stack.Navigator
      initialRouteName="Splash"
      screenOptions={{ headerShown: false, animation: "slide_from_right" }}
    >
      <Stack.Screen
        name="Splash"
        component={SplashScreenRoute}
        options={{ animation: "fade" }}
      />
      <Stack.Screen
        name="Onboarding"
        component={OnboardingScreen}
        options={{ animation: "fade" }}
      />
      <Stack.Screen name="Main" component={MainScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="ReportBug" component={ReportBugScreen} />
      <Stack.Screen name="Status" component={StatusRoute} />
    </Stack.Navigator>
  );
}
