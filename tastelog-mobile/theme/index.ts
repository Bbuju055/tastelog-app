export { fonts, fontSize, lineHeight } from "./typography";
export { spacing } from "./spacing";
export { radius } from "./radius";
export { shadows } from "./shadows";
export { motion } from "./motion";
export type { MotionTokens } from "./motion";
export { lightPalette, darkPalette } from "./palettes";
export type { ThemePalette } from "./palettes";

// ThemeProvider, useTheme, useScreenTheme are NOT re-exported here.
// They depend on react-navigation and expo-status-bar which break the
// Jest module graph when pulled through the barrel.
// Import directly: import { ThemeProvider, useTheme, useScreenTheme } from "@/theme/ThemeProvider";
// Types can be imported from the provider module as well.
