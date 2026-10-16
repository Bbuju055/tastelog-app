import { NativeModules, Platform } from "react-native";

type AppGroupUserDefaultsNative = {
  setString(key: string, value: string): void;
  getString(key: string): Promise<string | null>;
  remove(key: string): void;
};

const Native: AppGroupUserDefaultsNative | undefined =
  (NativeModules as Record<string, unknown>).AppGroupUserDefaultsModule as
    | AppGroupUserDefaultsNative
    | undefined;

export function setAppGroupString(key: string, value: string): void {
  if (Platform.OS !== "ios") return;
  Native?.setString(key, value);
}

export async function getAppGroupString(key: string): Promise<string | null> {
  if (Platform.OS !== "ios") return null;
  const value = await Native?.getString(key);
  return value ?? null;
}

export function removeAppGroupKey(key: string): void {
  if (Platform.OS !== "ios") return;
  Native?.remove(key);
}
