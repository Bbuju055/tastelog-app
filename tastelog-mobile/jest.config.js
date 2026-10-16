module.exports = {
  preset: "jest-expo",
  testMatch: ["**/__tests__/**/*.test.ts?(x)"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-async-storage|@react-navigation|expo(nent)?|@expo(nent)?/.*|expo-modules-core|expo-router|expo-secure-store|expo-status-bar|react-native-webview|react-native-gesture-handler|react-native-reanimated|react-native-worklets|nativewind|@supabase)/)",
  ],
};
