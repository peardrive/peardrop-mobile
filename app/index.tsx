import React from "react";
import { StatusBar, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Tabs from "../src/navigation/Tabs";
import { BackendProvider } from "../src/state/backend";
import { ShareLinkFlowProvider } from "../src/state/ShareLinkFlowContext";
import { ThemeProvider, useAppTheme } from "../src/state/ThemeContext";
import SharePreviewModal from "../src/ui/SharePreviewModal";
import { ToastProvider } from "../src/ui/Toast";
import { LIGHT_THEME_IDS } from "../src/ui/themes";

/**
 * Theme backstop for the safe-area edges. React Navigation gives its scene
 * container a platform-default background — white on iOS — which shows
 * through above the status bar / Dynamic Island and below the home indicator,
 * wherever a screen's own padding has inset the content away. Wrapping the
 * tree in a flex:1 View painted with theme.bg means anything that doesn't
 * draw its own background falls through to the theme colour.
 *
 * Screens handle their own content insets; only the background is set here.
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
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedRoot>
          <ToastProvider>
            <BackendProvider>
              <ShareLinkFlowProvider>
                <Tabs />
                <SharePreviewModal />
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
