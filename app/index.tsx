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
 * iOS visual SafeArea fix. Guy's first
 * iOS build showed white strips above the status bar / Dynamic Island and
 * below the home indicator — the dark theme wasn't reaching those zones.
 *
 * Root cause: React Navigation's Bottom Tab navigator gives its scene
 * container a platform-default background (white on iOS, system default
 * on Android). On Android we never noticed because the OEM defaults are
 * usually black-or-near-black; on iOS the white shines through every
 * safe-area edge that the screen view's `paddingTop`/`paddingBottom`
 * inset away from.
 *
 * Fix is three small things inside this file + one in Tabs:
 *   1. Wrap the entire tree (below ThemeProvider) in a flex:1 View whose
 *      backgroundColor is theme.bg. Becomes the absolute backstop —
 *      anywhere in the tree that doesn't draw its own bg now falls
 *      through to the theme color.
 *   2. Set Tab.Navigator's `sceneContainerStyle.backgroundColor` so the
 *      inner scene area also fills with theme.bg (handled in Tabs.tsx).
 *   3. <StatusBar> with the right barStyle for the current theme (light
 *      text on dark themes, dark text on light themes). Uses react-
 *      native's built-in (already in the dep graph) — no new package.
 *
 * Content (HomeScreen, ReceiveScreen, etc.) already uses `useSafeAreaInsets`
 * for paddingTop/paddingBottom, so content stays clear of the notch /
 * home indicator. Only the *background* is what's changing.
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
  // Register the notification channel before anything can post to it.
  // Deliberately above BackendProvider: the channel and the worklet share
  // no state, so this must not queue behind worklet start. Fire-and-forget
  // — it is idempotent and internally best-effort, and nothing downstream
  // waits on the result.
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
                {/* drains peardrop:// links parked by
                    app/+native-intent.ts into the resolve-and-preview
                    flow above. Renders nothing, and sits outside <Tabs />
                    so the splash's nav.reset() can't unmount it. Note
                    SharePreviewModal is a sibling here rather than a
                    screen, which is why an incoming link needs no
                    navigation at all — the preview draws over whatever
                    route the launch flow settled on. */}
                <IncomingLinkBridge />
                {/* Offers the background-activity setting after the OS has
                    actually been observed freezing the app. Mounted here
                    rather than in a screen so it can appear over whatever
                    the user returned to; renders nothing until there is
                    something to say. */}
                <BackgroundRestrictionPrompt />
                {/* v5: QR scanner is embedded directly in ReceiveSheet;
                    the standalone QrScanModal is no longer mounted. */}
              </ShareLinkFlowProvider>
            </BackendProvider>
          </ToastProvider>
        </ThemedRoot>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
