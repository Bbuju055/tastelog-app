describe("env validation", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Clear jest.setup.js defaults so explicit-set / explicit-delete
    // tests work as intended. jest.setup.js sets EXPO_PUBLIC_* defaults
    // via ??= for hook tests that import lib/config (Phase 13.5); this
    // test file intentionally controls each var per-test and must start
    // from a clean env baseline.
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_PUBLIC_WEB_BASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    delete process.env.EXPO_PUBLIC_RIFF_STREAMING;
  });

  afterEach(() => {
    jest.resetModules();
    process.env = ORIGINAL_ENV;
  });

  test("passes with valid env", () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = "https://api.example.com";
    process.env.EXPO_PUBLIC_WEB_BASE_URL = "https://web.example.com";
    process.env.EXPO_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "anon";

    const { env } = require("../../lib/config");
    expect(env).toBeTruthy();
    expect(env.EXPO_PUBLIC_API_BASE_URL).toBe("https://api.example.com");
  });

  test("fails when required env missing", () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    process.env.EXPO_PUBLIC_WEB_BASE_URL = "https://web.example.com";
    process.env.EXPO_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "anon";

    expect(() => require("../../lib/config")).toThrow(/Invalid env/i);
  });

  test("passes without EXPO_PUBLIC_WEB_BASE_URL", () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = "https://api.example.com";
    delete process.env.EXPO_PUBLIC_WEB_BASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "anon";

    const { env } = require("../../lib/config");
    expect(env).toBeTruthy();
    expect(env.EXPO_PUBLIC_WEB_BASE_URL).toBeUndefined();
  });

  test("fails when url is invalid", () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = "not-a-url";
    process.env.EXPO_PUBLIC_WEB_BASE_URL = "https://web.example.com";
    process.env.EXPO_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "anon";

    expect(() => require("../../lib/config")).toThrow(/Invalid env/i);
  });
});
