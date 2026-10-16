/**
 * Theme context provider — single source of truth for active palette.
 *
 * Screens declare their natural theme via useScreenTheme('light' | 'dark').
 * The provider resolves the actual palette based on user preference:
 *   - 'auto'  -> use the screen's declared theme
 *   - 'light' -> force light everywhere
 *   - 'dark'  -> force dark everywhere
 *
 * StatusBar style is controlled centrally here — not per screen.
 * Components read colors via useTheme(), never from colors.ts.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { type ThemePalette, lightPalette, darkPalette } from "./palettes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemePreference = "auto" | "light" | "dark";
export type ThemeName = "light" | "dark";

type ThemeContextValue = {
  /** Resolved theme name (after applying user preference). */
  theme: ThemeName;
  /** Active color palette — use this for all styling. */
  palette: ThemePalette;
  /** Current user preference. */
  preference: ThemePreference;
  /** Update user preference (persisted to AsyncStorage). */
  setPreference: (pref: ThemePreference) => void;
  /** Called by screens to declare their natural theme. Internal use only. */
  setScreenTheme: (name: ThemeName) => void;
};

const STORAGE_KEY = "tastelog_theme_preference";

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<ThemePreference>("auto");
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [screenTheme, setScreenTheme] = useState<ThemeName>("light");

  // Load persisted preference on mount
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (cancelled) return;
        if (value === "light" || value === "dark" || value === "auto") {
          setPreferenceState(value);
        }
        setPreferenceLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPreferenceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    AsyncStorage.setItem(STORAGE_KEY, pref).catch(() => {});
  }, []);

  // Resolve: preference overrides screen declaration
  const resolvedTheme: ThemeName =
    preference === "auto" ? screenTheme : preference;

  const palette = resolvedTheme === "light" ? lightPalette : darkPalette;

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolvedTheme,
      palette,
      preference,
      setPreference,
      setScreenTheme,
    }),
    [resolvedTheme, palette, preference, setPreference]
  );

  // Render children immediately with default palette while preference loads.
  // This avoids blocking render in tests and ensures components always have
  // a valid theme context. Once AsyncStorage resolves, the palette updates.

  return (
    <ThemeContext.Provider value={value}>
      {children}
      <StatusBar style={resolvedTheme === "light" ? "dark" : "light"} />
    </ThemeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Read the active theme and palette. Use in any component.
 *
 * @example
 * const { palette, theme } = useTheme();
 * <View style={{ backgroundColor: palette.bg }} />
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}

/**
 * Declare this screen's natural theme. Call at the top of screen components
 * (not shared components).
 *
 * Uses useFocusEffect so that only the focused screen controls the theme —
 * background screens during navigation transitions do not override it.
 *
 * When preference is 'auto', this determines the active palette.
 * When preference is 'light' or 'dark', the user override wins.
 *
 * @example
 * useScreenTheme('light');
 * const { palette } = useTheme();
 */
export function useScreenTheme(name: ThemeName): void {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useScreenTheme must be used within a ThemeProvider");
  }

  const { setScreenTheme } = ctx;

  useFocusEffect(
    useCallback(() => {
      setScreenTheme(name);
    }, [name, setScreenTheme])
  );
}
