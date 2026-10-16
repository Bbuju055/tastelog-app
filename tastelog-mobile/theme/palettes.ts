/**
 * Dual-theme palette system — light and dark.
 *
 * ThemePalette is the single source of truth for all color tokens.
 * Both palettes have identical keys — components read from the active
 * palette via useTheme(), never from colors.ts directly.
 *
 * Color roles:
 *   Sage  = passive / decorative (pills, tags, borders)
 *   Fern  = action / CTA (buttons, active navigation)
 *   Gold  = reward / delight (stars, ratings)
 *   Neutrals = warmth + readability (surfaces, text)
 */

/** Complete set of color tokens — no optional keys, no TODOs. */
export type ThemePalette = {
  // Surfaces (depth progression: bg -> surface -> card -> elevated)
  bg: string;
  surface: string;
  card: string;
  elevated: string;

  // Borders & dividers
  border: string;
  divider: string;

  // Text hierarchy
  text1: string;
  text2: string;
  text3: string;
  text4: string;

  // Accent — sage green (passive / decorative)
  accent: string;
  accentDark: string;
  accentSoft: string;
  accentWash: string;

  // Primary — fern green (action / CTA)
  primary: string;
  primarySoft: string;
  /** Label/loader color on primary & destructive fills — contrast-safe in both themes. */
  onPrimary: string;

  // Disabled controls (fills + labels) — never reuse surface tokens for these
  disabledBg: string;
  disabledText: string;

  // Pills
  pillBg: string;
  pillText: string;

  // Selection
  selected: string;
  selectedBorder: string;

  // Star / rating
  star: string;
  starEmpty: string;

  // Reward / progress — cooking progress fill + completion beat mark.
  // Graphical element; the light value holds >=3:1 contrast on bg.
  reward: string;

  // Semantic — error
  error: string;
  errorSoft: string;

  // Semantic — success
  success: string;
  successSoft: string;

  // Semantic — warning
  warning: string;
  warningSoft: string;

  // Toast
  toastBg: string;
  toastBorder: string;
  toastText: string;
  toastSuccessBg: string;
  toastSuccessText: string;

  // Tab bar chrome
  tabBarBg: string;
  tabBarBorder: string;
};

// ---------------------------------------------------------------------------
// Light palette — warm, welcoming, readable
// ---------------------------------------------------------------------------

export const lightPalette: ThemePalette = {
  // Surfaces
  bg: "#F9F8F5",
  surface: "#F0EFEB",
  card: "#FFFFFF",
  elevated: "#FFFFFF",

  // Borders & dividers
  border: "rgba(0, 0, 0, 0.10)",
  divider: "rgba(0, 0, 0, 0.06)",

  // Text hierarchy
  text1: "#1C1C1A",
  text2: "#3C3C3A",
  text3: "#918F88",
  text4: "#A8A6A0",

  // Accent — sage (darkened for readability on white)
  accent: "#4A6E47",
  accentDark: "#3A5E38",
  accentSoft: "rgba(193, 216, 190, 0.30)",
  accentWash: "rgba(193, 216, 190, 0.08)",

  // Primary — fern green (CTA)
  primary: "#3A7344",
  primarySoft: "rgba(58, 115, 68, 0.25)",
  onPrimary: "#F9F8F5",

  // Disabled controls
  disabledBg: "#E7E5DF",
  disabledText: "#7A786F",

  // Pills
  pillBg: "rgba(193, 216, 190, 0.30)",
  pillText: "#4A6E47",

  // Selection
  selected: "rgba(193, 216, 190, 0.30)",
  selectedBorder: "#4A6E47",

  // Star / rating
  star: "#D4A044",
  starEmpty: "#D4D2CC",

  // Reward / progress (light — darkened gold; ~4.5:1 on bg #F9F8F5)
  reward: "#A16207",

  // Semantic — error
  error: "#C4392C",
  errorSoft: "rgba(196, 57, 44, 0.10)",

  // Semantic — success
  success: "#3A7344",
  successSoft: "rgba(58, 115, 68, 0.10)",

  // Semantic — warning
  warning: "#B8860B",
  warningSoft: "rgba(184, 134, 11, 0.10)",

  // Toast
  toastBg: "#FFFFFF",
  toastBorder: "rgba(0, 0, 0, 0.06)",
  toastText: "#1C1C1A",
  toastSuccessBg: "rgba(58, 115, 68, 0.10)",
  toastSuccessText: "#3A7344",

  // Tab bar
  tabBarBg: "rgba(249, 248, 245, 0.92)",
  tabBarBorder: "rgba(0, 0, 0, 0.06)",
};

// ---------------------------------------------------------------------------
// Dark palette — focused, immersive workspace
// Values copied from colors.ts as literals. No runtime dependency on colors.ts.
// ---------------------------------------------------------------------------

export const darkPalette: ThemePalette = {
  // Surfaces
  bg: "#2C2C2A",
  surface: "#323230",
  card: "#3B3B38",
  elevated: "#464642",

  // Borders & dividers
  border: "rgba(241, 239, 232, 0.06)",
  divider: "rgba(241, 239, 232, 0.04)",

  // Text hierarchy
  text1: "#F1EFE8",
  text2: "#B4B2A9",
  text3: "#9A9890",
  text4: "#5F5E5A",

  // Accent — sage green
  accent: "#C1D8BE",
  accentDark: "#A8C5A3",
  accentSoft: "rgba(193, 216, 190, 0.12)",
  accentWash: "rgba(193, 216, 190, 0.06)",

  // Primary — fern green (CTA)
  primary: "#3A7344",
  primarySoft: "rgba(58, 115, 68, 0.35)",
  onPrimary: "#FAF9F6",

  // Disabled controls
  disabledBg: "#414140",
  disabledText: "#9A9890",

  // Pills
  pillBg: "rgba(193, 216, 190, 0.12)",
  pillText: "#C1D8BE",

  // Selection
  selected: "rgba(193, 216, 190, 0.12)",
  selectedBorder: "#C1D8BE",

  // Star / rating
  star: "#D4A044",
  starEmpty: "rgba(212, 160, 68, 0.20)",

  // Reward / progress (dark — gold; ~5.9:1 on bg #2C2C2A)
  reward: "#D4A044",

  // Semantic — error
  error: "#D96B6B",
  errorSoft: "rgba(217, 107, 107, 0.12)",

  // Semantic — success
  success: "#7FC8A9",
  successSoft: "rgba(127, 200, 169, 0.12)",

  // Semantic — warning
  warning: "#D4A044",
  warningSoft: "rgba(212, 160, 68, 0.12)",

  // Toast
  toastBg: "#464642",
  toastBorder: "rgba(241, 239, 232, 0.06)",
  toastText: "#F1EFE8",
  toastSuccessBg: "rgba(127, 200, 169, 0.12)",
  toastSuccessText: "#7FC8A9",

  // Tab bar
  tabBarBg: "rgba(50, 50, 48, 0.92)",
  tabBarBorder: "rgba(241, 239, 232, 0.06)",
};
