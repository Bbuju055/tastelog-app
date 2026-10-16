import "dotenv/config";
import type { ExpoConfig, ConfigContext } from "@expo/config";

function requireEnv(name: string): string {
  const raw = process.env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(
      `[tastelog-mobile] Missing required env var: ${name}\n` +
        `Create a local .env with ${name}=... or configure it in EAS.`
    );
  }
  return value;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  // Fail-fast at config load time (prevents ambiguous runtime failures)
  const apiBaseUrl = requireEnv("EXPO_PUBLIC_API_BASE_URL");
  const webBaseUrl =
    (process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "").trim() || undefined;
  const supabaseUrl = requireEnv("EXPO_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = requireEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY");

  return {
    ...config,
    name: config.name ?? "Tastelog",
    slug: config.slug ?? "tastelog-mobile",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "tastelog",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.mohangom.tastelog-mobile",
      buildNumber: "8",
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      edgeToEdgeEnabled: true,
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
      ["@sentry/react-native/expo", {}],
      [
        "expo-image-picker",
        {
          photosPermission:
            "Tastelog needs access to your photos to capture recipes.",
        },
      ],
      [
        "expo-speech-recognition",
        {
          microphonePermission:
            "Tastelog uses the microphone for hands-free voice commands while cooking.",
          speechRecognitionPermission:
            "Tastelog uses speech recognition for hands-free voice commands while cooking.",
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      ...config.extra,
      eas: {
        projectId: "00000000-0000-0000-0000-000000000000",
      },
      EXPO_PUBLIC_API_BASE_URL: apiBaseUrl,
      EXPO_PUBLIC_WEB_BASE_URL: webBaseUrl,
      EXPO_PUBLIC_SUPABASE_URL: supabaseUrl,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
      EXPO_PUBLIC_SENTRY_DSN: (process.env.EXPO_PUBLIC_SENTRY_DSN ?? "").trim() || undefined,
    },
  };
};
