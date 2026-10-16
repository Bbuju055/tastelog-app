// ---------------------------------------------------------------------------
// Mocks — declared before require() of module under test
// ---------------------------------------------------------------------------

const mockCreateCaptureToken = jest.fn();
const mockGetCaptureToken = jest.fn();
const mockGetCaptureTokenId = jest.fn();
const mockSetCaptureToken = jest.fn();
const mockRemoveCaptureToken = jest.fn();
const mockMirrorTokenToAppGroup = jest.fn();
const mockVerifyTokenStorage = jest.fn();

jest.mock("../../../lib/api/endpoints", () => ({
  __esModule: true,
  createCaptureToken: (...args: unknown[]) => mockCreateCaptureToken(...args),
}));

jest.mock("../../../lib/auth/storage", () => ({
  __esModule: true,
  getCaptureToken: (...args: unknown[]) => mockGetCaptureToken(...args),
  getCaptureTokenId: (...args: unknown[]) => mockGetCaptureTokenId(...args),
  setCaptureToken: (...args: unknown[]) => mockSetCaptureToken(...args),
  removeCaptureToken: (...args: unknown[]) => mockRemoveCaptureToken(...args),
  mirrorTokenToAppGroup: (...args: unknown[]) => mockMirrorTokenToAppGroup(...args),
  verifyTokenStorage: (...args: unknown[]) => mockVerifyTokenStorage(...args),
}));

// Import after mocks
const {
  provisionAndStoreCaptureToken,
} = require("../../../lib/auth/tokenOrchestrator");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupSuccessMocks() {
  mockCreateCaptureToken.mockResolvedValue({
    id: "tok-id-1",
    token: "tl_cap_abc123",
  });
  mockSetCaptureToken.mockResolvedValue(undefined);
  mockVerifyTokenStorage.mockResolvedValue(true);
  mockRemoveCaptureToken.mockResolvedValue(undefined);
  mockGetCaptureToken.mockResolvedValue(null);
  mockGetCaptureTokenId.mockResolvedValue(null);
  mockMirrorTokenToAppGroup.mockReturnValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provisionAndStoreCaptureToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setupSuccessMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---- Success path ----

  test("success: create → store → verify → returns token + tokenId", async () => {
    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      success: true,
      token: "tl_cap_abc123",
      tokenId: "tok-id-1",
    });

    expect(mockCreateCaptureToken).toHaveBeenCalledWith({ name: "Mobile (auto)" });
    expect(mockSetCaptureToken).toHaveBeenCalledWith("tl_cap_abc123", "tok-id-1");
    expect(mockVerifyTokenStorage).toHaveBeenCalledWith("tl_cap_abc123", "tok-id-1");
    expect(mockRemoveCaptureToken).not.toHaveBeenCalled();
  });

  test("success: uses custom name when provided", async () => {
    const promise = provisionAndStoreCaptureToken("My Token");
    await jest.runAllTimersAsync();
    await promise;

    expect(mockCreateCaptureToken).toHaveBeenCalledWith({ name: "My Token" });
  });

  // ---- Provisioning request failure ----

  test("failure: backend request fails → classified error", async () => {
    mockCreateCaptureToken.mockRejectedValue(new Error("Network timeout"));

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result).toHaveProperty("error");
    if (!result.success) {
      expect(result.error).toContain("Provisioning request failed");
      expect(result.error).toContain("Network timeout");
    }
  });

  // ---- Local storage failure ----

  test("failure: setCaptureToken rejects → cleanup + classified error", async () => {
    mockSetCaptureToken.mockRejectedValue(new Error("SecureStore write failed"));

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Local token storage failed");
    }
    // Cleanup called on every failed attempt (3 attempts total)
    expect(mockRemoveCaptureToken).toHaveBeenCalled();
  });

  // ---- Verification mismatch ----

  test("failure: verification returns false → cleanup + classified error", async () => {
    mockVerifyTokenStorage.mockResolvedValue(false);

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Token storage verification failed");
      expect(result.error).toContain("read-back mismatch");
    }
    expect(mockRemoveCaptureToken).toHaveBeenCalled();
  });

  test("failure: verification throws → cleanup + classified error", async () => {
    mockVerifyTokenStorage.mockRejectedValue(new Error("Read failed"));

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Token storage verification failed");
    }
    expect(mockRemoveCaptureToken).toHaveBeenCalled();
  });

  // ---- Retry behavior ----

  test("retries full flow up to 3 attempts before failing", async () => {
    mockCreateCaptureToken.mockRejectedValue(new Error("server down"));

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(mockCreateCaptureToken).toHaveBeenCalledTimes(3);
  });

  test("succeeds on retry after initial failure", async () => {
    mockVerifyTokenStorage
      .mockResolvedValueOnce(false) // attempt 1: verify fails
      .mockResolvedValue(true);     // attempt 2: verify succeeds

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(mockCreateCaptureToken).toHaveBeenCalledTimes(2);
    expect(mockSetCaptureToken).toHaveBeenCalledTimes(2);
    expect(mockVerifyTokenStorage).toHaveBeenCalledTimes(2);
    // Cleanup called once for the failed first attempt
    expect(mockRemoveCaptureToken).toHaveBeenCalledTimes(1);
  });

  test("cleanup failure during retry does not block next attempt", async () => {
    mockVerifyTokenStorage
      .mockResolvedValueOnce(false) // attempt 1 fails
      .mockResolvedValue(true);     // attempt 2 succeeds
    mockRemoveCaptureToken
      .mockRejectedValueOnce(new Error("cleanup crash"))
      .mockResolvedValue(undefined);

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    // Cleanup failure is swallowed; retry still proceeds
    expect(result.success).toBe(true);
  });

  // ---- Dedup ----

  test("concurrent callers share the same in-flight promise", async () => {
    const p1 = provisionAndStoreCaptureToken();
    const p2 = provisionAndStoreCaptureToken();

    await jest.runAllTimersAsync();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2); // same reference
    expect(mockCreateCaptureToken).toHaveBeenCalledTimes(1);
  });

  test("dedup resets after completion — next call is fresh", async () => {
    const p1 = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    await p1;

    const p2 = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    await p2;

    expect(mockCreateCaptureToken).toHaveBeenCalledTimes(2);
  });

  // ---- Fallback: recover existing token when backend fails ----

  test("fallback: backend fails but existing SecureStore token recovered", async () => {
    mockCreateCaptureToken.mockRejectedValue(new Error("server down"));
    mockGetCaptureToken.mockResolvedValue("tl_cap_existing");
    mockGetCaptureTokenId.mockResolvedValue("existing-id");
    // verifyTokenStorage already mocked to return true

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      success: true,
      token: "tl_cap_existing",
      tokenId: "existing-id",
    });
    expect(mockMirrorTokenToAppGroup).toHaveBeenCalledWith("tl_cap_existing");
    expect(mockVerifyTokenStorage).toHaveBeenCalledWith("tl_cap_existing", "existing-id");
  });

  test("fallback: fails when tokenId missing in SecureStore", async () => {
    mockCreateCaptureToken.mockRejectedValue(new Error("server down"));
    mockGetCaptureToken.mockResolvedValue("tl_cap_existing");
    mockGetCaptureTokenId.mockResolvedValue(null);

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(mockMirrorTokenToAppGroup).not.toHaveBeenCalled();
  });

  test("fallback: verification failure during recovery does not claim success", async () => {
    mockCreateCaptureToken.mockRejectedValue(new Error("server down"));
    mockGetCaptureToken.mockResolvedValue("tl_cap_existing");
    mockGetCaptureTokenId.mockResolvedValue("existing-id");
    mockVerifyTokenStorage.mockResolvedValue(false);

    const promise = provisionAndStoreCaptureToken();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(mockMirrorTokenToAppGroup).toHaveBeenCalledWith("tl_cap_existing");
  });
});
