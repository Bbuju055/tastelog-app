import { createCaptureToken } from "../api/endpoints";
import {
  getCaptureToken,
  getCaptureTokenId,
  setCaptureToken,
  removeCaptureToken,
  mirrorTokenToAppGroup,
  verifyTokenStorage,
} from "./storage";

const DEFAULT_TOKEN_NAME = "Mobile (auto)";
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries
const BACKOFF_MS = [500, 1000]; // delay before retry 2, retry 3

export type ProvisionCaptureTokenResult =
  | { success: true; token: string; tokenId: string }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Dedup — only one in-flight provisioning at a time
// ---------------------------------------------------------------------------

let inflightPromise: Promise<ProvisionCaptureTokenResult> | null = null;

/**
 * Single orchestration path for capture token provisioning.
 *
 * 1. Call backend (create or rotate)
 * 2. Write to SecureStore + App Group
 * 3. Verify read-back
 * 4. On failure: cleanup local state, retry whole flow (up to 3 total attempts)
 *
 * Concurrent callers share the same in-flight promise.
 * Pure orchestration — caller owns UI/error state.
 */
export function provisionAndStoreCaptureToken(
  name?: string,
): Promise<ProvisionCaptureTokenResult> {
  if (inflightPromise) return inflightPromise;

  inflightPromise = executeWithRetry(name ?? DEFAULT_TOKEN_NAME).finally(() => {
    inflightPromise = null;
  });

  return inflightPromise;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function executeWithRetry(
  name: string,
): Promise<ProvisionCaptureTokenResult> {
  let lastError = "";
  let hadLocalFailure = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await delay(BACKOFF_MS[attempt - 1]);
    }

    const result = await attemptProvision(name);
    if (result.success) return result;

    lastError = result.error;

    // Track whether any attempt failed due to local write/verification —
    // if so, local state may be corrupt and fallback is not safe.
    if (!result.success && !result.error.startsWith("Provisioning request failed")) {
      hadLocalFailure = true;
    }
  }

  // Fallback: if ALL failures were backend/network (not local corruption),
  // try to recover by mirroring an existing SecureStore token to App Group.
  // This covers the case where App Group was wiped (rebuild/reinstall)
  // but SecureStore (Keychain) still holds a valid token.
  if (!hadLocalFailure) {
    const recovered = await recoverExistingToken();
    if (recovered) return recovered;
  }

  return { success: false, error: lastError };
}

/**
 * Attempt to recover from provisioning failure using an existing SecureStore token.
 * Mirrors to App Group and verifies. Does NOT touch SecureStore.
 */
async function recoverExistingToken(): Promise<ProvisionCaptureTokenResult | null> {
  try {
    const [existingToken, existingTokenId] = await Promise.all([
      getCaptureToken(),
      getCaptureTokenId(),
    ]);

    if (!existingToken || !existingTokenId) return null;

    mirrorTokenToAppGroup(existingToken);

    const verified = await verifyTokenStorage(existingToken, existingTokenId);
    if (!verified) return null;

    return { success: true, token: existingToken, tokenId: existingTokenId };
  } catch {
    return null;
  }
}

async function attemptProvision(
  name: string,
): Promise<ProvisionCaptureTokenResult> {
  // Step 1: Backend create-or-rotate
  let token: string;
  let tokenId: string;
  try {
    const response = await createCaptureToken({ name });
    token = response.token;
    tokenId = response.id;
  } catch (err) {
    return {
      success: false,
      error: `Provisioning request failed: ${messageFrom(err)}`,
    };
  }

  // Step 2: Write to SecureStore + App Group
  try {
    await setCaptureToken(token, tokenId);
  } catch (err) {
    await removeCaptureToken().catch(() => {});
    return {
      success: false,
      error: `Local token storage failed: ${messageFrom(err)}`,
    };
  }

  // Step 3: Verify read-back
  try {
    const verified = await verifyTokenStorage(token, tokenId);
    if (!verified) {
      await removeCaptureToken().catch(() => {});
      return {
        success: false,
        error: "Token storage verification failed: read-back mismatch",
      };
    }
  } catch (err) {
    await removeCaptureToken().catch(() => {});
    return {
      success: false,
      error: `Token storage verification failed: ${messageFrom(err)}`,
    };
  }

  return { success: true, token, tokenId };
}

function messageFrom(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
