import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance, type ColorSchemeName } from "react-native";

import {
  DEFAULT_THEME_ID,
  type AppTheme,
  type ThemeId,
  themes,
} from "../ui/themes";

const STORAGE_KEY_ID = "peardrop.themeId";
const STORAGE_KEY_MODE = "peardrop.themeMode";

/**
 * Theme strategy:
 *   - "manual": use the theme the user picked explicitly.
 *   - "system": follow the OS color scheme. We map to our default dark
 *     ("void") when the system is dark and our flagship light ("paper")
 *     when the system is light. If the user picks specific light/dark
 *     themes later this will be extended to remember both.
 */
export type ThemeMode = "manual" | "system";

type ThemeContextValue = {
  theme: AppTheme;
  themeId: ThemeId;
  /** The user's chosen theme when mode === "manual". Retained across mode flips. */
  preferredThemeId: ThemeId;
  mode: ThemeMode;
  setThemeId: (id: ThemeId) => void;
  setMode: (mode: ThemeMode) => void;
  hydrated: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const SYSTEM_DARK_ID: ThemeId = "void";
const SYSTEM_LIGHT_ID: ThemeId = "paper";

function parseStoredId(value: string | null): ThemeId {
  if (value && value in themes) return value as ThemeId;
  return DEFAULT_THEME_ID;
}

function parseStoredMode(value: string | null): ThemeMode {
  return value === "system" ? "system" : "manual";
}

function systemThemeId(scheme: ColorSchemeName): ThemeId {
  return scheme === "light" ? SYSTEM_LIGHT_ID : SYSTEM_DARK_ID;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preferredThemeId, setPreferredThemeId] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [mode, setModeState] = useState<ThemeMode>("manual");
  const [systemScheme, setSystemScheme] = useState<ColorSchemeName>(Appearance.getColorScheme());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([AsyncStorage.getItem(STORAGE_KEY_ID), AsyncStorage.getItem(STORAGE_KEY_MODE)])
      .then(([rawId, rawMode]) => {
        if (cancelled) return;
        setPreferredThemeId(parseStoredId(rawId));
        setModeState(parseStoredMode(rawMode));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only subscribe to Appearance while we're actually following it.
  useEffect(() => {
    if (mode !== "system") return;
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme);
    });
    // Sync once on (re)entry in case the OS changed while we were manual.
    setSystemScheme(Appearance.getColorScheme());
    return () => sub.remove();
  }, [mode]);

  const setThemeId = useCallback((id: ThemeId) => {
    setPreferredThemeId(id);
    setModeState("manual");
    void AsyncStorage.setItem(STORAGE_KEY_ID, id);
    void AsyncStorage.setItem(STORAGE_KEY_MODE, "manual");
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    void AsyncStorage.setItem(STORAGE_KEY_MODE, nextMode);
  }, []);

  const themeId: ThemeId = mode === "system" ? systemThemeId(systemScheme) : preferredThemeId;
  const theme = themes[themeId];

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId,
      preferredThemeId,
      mode,
      setThemeId,
      setMode,
      hydrated,
    }),
    [theme, themeId, preferredThemeId, mode, setThemeId, setMode, hydrated]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: themes[DEFAULT_THEME_ID],
      themeId: DEFAULT_THEME_ID,
      preferredThemeId: DEFAULT_THEME_ID,
      mode: "manual",
      setThemeId: () => {},
      setMode: () => {},
      hydrated: true,
    };
  }
  return context;
}
