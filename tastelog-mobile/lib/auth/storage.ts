import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { CAPTURE_TOKEN_KEY, CAPTURE_TOKEN_ID_KEY } from "../../constants/keys";
import {
  setAppGroupString,
  getAppGroupString,
  removeAppGroupKey,
} from "../native/appGroupUserDefaults";

/** Key used by the Share Extension to read the capture token from App Group. */
const APP_GROUP_TOKEN_KEY = "capture_token";

/**
 * Capture token storage — SecureStore (primary) + App Group UserDefaults (for Share Extension).
 * Stores both the token string and its server-side ID.
 * Supabase session uses AsyncStorage (see supabase.ts).
 */

export async function getCaptureToken(): Promise<string | null> {
  return (await SecureStore.getItemAsync(CAPTURE_TOKEN_KEY)) ?? null;
}

export async function getCaptureTokenId(): Promise<string | null> {
  return (await SecureStore.getItemAsync(CAPTURE_TOKEN_ID_KEY)) ?? null;
}

/**
 * Write token + tokenId concurrently and fail the call if either write rejects.
 * Mirrors token to App Group for the Share Extension.
 */
export async function setCaptureToken(token: string, tokenId: string): Promise<void> {
  const value = token.trim();
  const id = tokenId.trim();
  if (!value || !id) throw new Error("Cannot store empty capture token / id");

  await Promise.all([
    SecureStore.setItemAsync(CAPTURE_TOKEN_KEY, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
    SecureStore.setItemAsync(CAPTURE_TOKEN_ID_KEY, id, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ]);

  // Mirror token to App Group UserDefaults so Share Extension can read it.
  setAppGroupString(APP_GROUP_TOKEN_KEY, value);
}

export async function removeCaptureToken(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(CAPTURE_TOKEN_KEY),
    SecureStore.deleteItemAsync(CAPTURE_TOKEN_ID_KEY),
  ]);

  // Remove from App Group so Share Extension fails closed.
  removeAppGroupKey(APP_GROUP_TOKEN_KEY);
}

/**
 * Mirror an existing token to App Group without touching SecureStore.
 * Used only by the orchestrator's fallback path when App Group was wiped
 * but SecureStore (Keychain) still holds a valid token.
 */
export function mirrorTokenToAppGroup(token: string): void {
  setAppGroupString(APP_GROUP_TOKEN_KEY, token);
}

/**
 * Read back all three storage locations and verify they match the expected values.
 * On iOS, App Group token must equal expectedToken (catches silent write failures).
 * On non-iOS, App Group check is skipped (not applicable).
 */
export async function verifyTokenStorage(
  expectedToken: string,
  expectedTokenId: string,
): Promise<boolean> {
  const [storedToken, storedId] = await Promise.all([
    getCaptureToken(),
    getCaptureTokenId(),
  ]);

  if (storedToken !== expectedToken || storedId !== expectedTokenId) {
    return false;
  }

  if (Platform.OS === "ios") {
    const appGroupToken = await getAppGroupString(APP_GROUP_TOKEN_KEY);
    return appGroupToken === expectedToken;
  }

  return true;
}
