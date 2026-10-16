/**
 * Typography system — font families and size scale.
 * Serif (Cormorant Garamond) for headings only.
 * Sans (Karla) for everything else.
 */
export const fonts = {
  heading: "CormorantGaramond_400Regular",
  headingMedium: "CormorantGaramond_500Medium",
  headingSemiBold: "CormorantGaramond_600SemiBold",
  headingBold: "CormorantGaramond_700Bold",
  // Italic name will be confirmed against actual expo-google-fonts export in Step 2
  headingItalic: "CormorantGaramond_400Regular_Italic",
  body: "Karla_400Regular",
  bodyMedium: "Karla_500Medium",
  bodySemiBold: "Karla_600SemiBold",
  bodyBold: "Karla_700Bold",
} as const;

export const fontSize = {
  sm: 12,
  base: 15,
  md: 17,
  lg: 19,
  title: 22,
  xl: 26,
  xxl: 34,
  hero: 42,
} as const;

export const lineHeight = {
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.65,
} as const;
