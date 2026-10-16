-- Migration: Capture Token System
-- Creates tables for capture tokens, rate limiting, and idempotency

-- ============================================================================
-- 1. Capture Tokens Table
-- ============================================================================
CREATE TABLE capture_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'capture',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_capture_tokens_user_id ON capture_tokens(user_id);
CREATE UNIQUE INDEX idx_capture_tokens_hash ON capture_tokens(token_hash);
CREATE UNIQUE INDEX idx_capture_tokens_user_name ON capture_tokens(user_id, name);

ALTER TABLE capture_tokens ENABLE ROW LEVEL SECURITY;

-- Users can manage their own tokens via Supabase JWT auth
CREATE POLICY "capture_tokens_user_access"
    ON capture_tokens
    FOR ALL
    USING (user_id = auth.uid());

-- ============================================================================
-- 2. Rate Limits Table
-- ============================================================================
CREATE TABLE capture_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL,
    request_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rate_limits_token_time ON capture_rate_limits(token_hash, request_at DESC);

ALTER TABLE capture_rate_limits ENABLE ROW LEVEL SECURITY;

-- Service role only - allows API to read/write rate limit records
CREATE POLICY "rate_limits_service_only"
    ON capture_rate_limits
    FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================================================
-- 3. Idempotency Keys Table
-- ============================================================================
CREATE TABLE capture_idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID NOT NULL REFERENCES capture_tokens(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    response_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE UNIQUE INDEX idx_idempotency_token_key ON capture_idempotency_keys(token_id, idempotency_key);
CREATE INDEX idx_idempotency_expires ON capture_idempotency_keys(expires_at);

ALTER TABLE capture_idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Service role only - allows API to read/write idempotency records
CREATE POLICY "idempotency_keys_service_only"
    ON capture_idempotency_keys
    FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================================================
-- 4. Cleanup function for expired records (optional, run via cron)
-- ============================================================================
-- To clean up old rate limit and idempotency records, run periodically:
--
-- DELETE FROM capture_rate_limits WHERE request_at < now() - interval '2 hours';
-- DELETE FROM capture_idempotency_keys WHERE expires_at < now();
