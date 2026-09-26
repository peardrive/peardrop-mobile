import React from "react";
import { StatusBar, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Tabs from "../src/navigation/Tabs";
import { ensureNotificationsReady } from "../src/lib/notifications";
import { BackendProvider } from "../src/state/backend";
import { ShareLinkFlowProvider } from "../src/state/ShareLinkFlowContext";
import IncomingLinkBridge from "../src/state/IncomingLinkBridge";
import { ThemeProvider, useAppTheme } from "../src/state/ThemeContext";
import SharePreviewModal from "../src/ui/SharePreviewModal";
import { ToastProvider } from "../src/ui/Toast";
import BackgroundRestrictionPrompt from "../src/ui/BackgroundRestrictionPrompt";
import { LIGHT_THEME_IDS } from "../src/ui/themes";

/**
 * A flex:1 View below ThemeProvider whose backgroundColor is theme.bg is the
 * backstop for every safe-area edge. React Navigation's Bottom Tab navigator
 * gives its scene container a platform-default background (white on iOS),
 * which otherwise shows through above the status bar and below the home
 * indicator. Tabs.tsx sets `sceneContainerStyle.backgroundColor` to cover the
 * inner scene area as well.
 */
function ThemedRoot({ children }: { children: React.ReactNode }) {
  const { theme, themeId } = useAppTheme();
  const isLightTheme = LIGHT_THEME_IDS.includes(themeId);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar
        barStyle={isLightTheme ? "dark-content" : "light-content"}
        backgroundColor="transparent"
        translucent
      />
      {children}
    </View>
  );
}

export default function App() {
  // Register the notification channel before anything can post to it. Above
  // BackendProvider deliberately, so it never queues behind worklet start;
  // idempotent and best-effort, so nothing downstream waits on the result.
  React.useEffect(() => {
    void ensureNotificationsReady();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedRoot>
          <ToastProvider>
            <BackendProvider>
              <ShareLinkFlowProvider>
                <Tabs />
                <SharePreviewModal />
                {/* Drains peardrop:// links parked by app/+native-intent.ts
                    into the resolve-and-preview flow above. Renders nothing,
                    and sits outside <Tabs /> so the splash's nav.reset()
                    can't unmount it. SharePreviewModal is a sibling rather
                    than a screen, so an incoming link needs no navigation at
                    all — the preview draws over whatever route the launch
                    flow settled on. */}
                <IncomingLinkBridge />
                {/* Offers the background-activity setting only once the OS
                    has been observed freezing the app. Mounted here rather
                    than in a screen so it can appear over whatever the user
                    returned to; renders nothing until there is something to
                    say. */}
                <BackgroundRestrictionPrompt />
              </ShareLinkFlowProvider>
            </BackendProvider>
          </ToastProvider>
        </ThemedRoot>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
