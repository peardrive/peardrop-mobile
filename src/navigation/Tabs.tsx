// Root native stack: Splash → Onboarding → Main + Settings. Named Tabs.tsx so app/index.tsx's import stays put.
import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import MainScreen from "../screens/MainScreen";
import SettingsScreen from "../screens/SettingsScreen";
import SplashScreenRoute from "../screens/SplashScreenRoute";
import OnboardingScreen from "../screens/OnboardingScreen";
import StatusRoute from "../screens/StatusRoute";
import LanguageScreen from "../screens/LanguageScreen";

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
      <Stack.Screen name="Language" component={LanguageScreen} />
      <Stack.Screen name="Status" component={StatusRoute} />
    </Stack.Navigator>
  );
}
