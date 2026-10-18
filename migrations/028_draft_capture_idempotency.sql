-- migrations/028_draft_capture_idempotency.sql
-- Idempotency for the draft capture routes (/api/drafts/capture and
-- /api/drafts/capture-url), scoped by USER, not capture token: both routes
-- resolve to a user id (JWT or capture token), and a capture token belongs
-- to exactly one user.
--
-- The capture_idempotency_keys helper (007) is check-then-store: two
-- concurrent misses can both create a draft. This table is reserved
-- INSERT-FIRST inside one RPC, so a key is claimed atomically:
--   reserved     caller owns the key; do the work, then complete or release
--   in_progress  another request holds the key and has not finished
--   recover      the holder wrote its draft but never completed (lost
--                response, crash): the draft id is returned so the caller
--                can hand back that exact draft instead of making another
--   replay       the key finished; the recorded response is returned
--   mismatch     the key was used with a different payload
--
-- The caller mints the draft id BEFORE reserving and creates the draft under
-- that id. The reservation stores it, which gives two properties:
--   1. recovery: a pending reservation whose draft exists is a finished
--      capture whose completion was lost, not a duplicate to create;
--   2. ownership: complete and release match on draft_id, so a request can
--      only ever finish or free its own reservation.
-- There is deliberately NO time-based takeover of a pending reservation: a
-- holder that died before writing its draft leaves that one key answering
-- in_progress until the row expires (24 h). A new capture attempt uses a new
-- key, so nothing else is blocked, and no stale owner can ever act on a
-- reservation it does not hold.
--
-- Access: service_role only, as every API-owned table. The three functions
-- are SECURITY DEFINER with EXECUTE granted to service_role alone.

CREATE TABLE draft_capture_idempotency (
    user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    idempotency_key TEXT        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 100),
    payload_hash    TEXT        NOT NULL,
    draft_id        UUID        NOT NULL,
    status          TEXT        NOT NULL CHECK (status IN ('pending', 'done')),
    response_json   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
    PRIMARY KEY (user_id, idempotency_key),
    CHECK ((status = 'done') = (response_json IS NOT NULL))
);

CREATE INDEX idx_draft_capture_idempotency_expires
    ON draft_capture_idempotency (expires_at);

ALTER TABLE draft_capture_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY "draft_capture_idempotency_service_only"
    ON draft_capture_idempotency
    FOR ALL
    USING (auth.role() = 'service_role');

REVOKE ALL ON draft_capture_idempotency FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON draft_capture_idempotency TO service_role;

-- ---------------------------------------------------------------------------
-- reserve_draft_capture: atomic claim.
-- Returns jsonb {"outcome": ...} plus "response" (replay) or "draft_id"
-- (recover).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_draft_capture(
    p_user_id uuid,
    p_idempotency_key text,
    p_payload_hash text,
    p_draft_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row draft_capture_idempotency%ROWTYPE;
BEGIN
    IF p_user_id IS NULL OR p_idempotency_key IS NULL
       OR p_payload_hash IS NULL OR p_draft_id IS NULL THEN
        RAISE EXCEPTION 'reserve_draft_capture: null argument' USING ERRCODE = 'TL422';
    END IF;

    -- An expired row (done or pending) frees its key.
    DELETE FROM draft_capture_idempotency
     WHERE user_id = p_user_id
       AND idempotency_key = p_idempotency_key
       AND expires_at <= now();

    -- Insert-first. A concurrent caller with the same key blocks on the
    -- primary key until this transaction ends, then sees the conflict.
    INSERT INTO draft_capture_idempotency
        (user_id, idempotency_key, payload_hash, draft_id, status)
    VALUES (p_user_id, p_idempotency_key, p_payload_hash, p_draft_id, 'pending')
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING * INTO v_row;

    IF FOUND THEN
        RETURN jsonb_build_object('outcome', 'reserved');
    END IF;

    SELECT * INTO v_row
      FROM draft_capture_idempotency
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
        -- The conflicting row vanished between the insert and the read
        -- (released by its owner). Let the caller retry the reservation.
        RETURN jsonb_build_object('outcome', 'in_progress');
    END IF;

    IF v_row.payload_hash <> p_payload_hash THEN
        RETURN jsonb_build_object('outcome', 'mismatch');
    END IF;

    IF v_row.status = 'done' THEN
        RETURN jsonb_build_object('outcome', 'replay', 'response', v_row.response_json);
    END IF;

    -- Pending. If the holder already wrote its draft, the capture finished
    -- and only the completion was lost: hand that draft back.
    IF EXISTS (SELECT 1 FROM recipe_drafts
                WHERE id = v_row.draft_id AND user_id = p_user_id) THEN
        RETURN jsonb_build_object('outcome', 'recover', 'draft_id', v_row.draft_id);
    END IF;

    RETURN jsonb_build_object('outcome', 'in_progress');
END;
$$;

-- ---------------------------------------------------------------------------
-- complete_draft_capture: record the response for the reservation this
-- caller owns (matched by draft_id). Returns true when a pending row was
-- completed, false when none matched (stale owner, released, or expired).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_draft_capture(
    p_user_id uuid,
    p_idempotency_key text,
    p_draft_id uuid,
    p_response jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF p_response IS NULL THEN
        RAISE EXCEPTION 'complete_draft_capture: null response' USING ERRCODE = 'TL422';
    END IF;
    UPDATE draft_capture_idempotency
       SET status = 'done', response_json = p_response
     WHERE user_id = p_user_id
       AND idempotency_key = p_idempotency_key
       AND draft_id = p_draft_id
       AND status = 'pending';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- release_draft_capture: drop the pending reservation this caller owns after
-- a failed capture, so the client's retry can reserve the key again. Done
-- rows and other owners' rows are never touched. Returns true when removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_draft_capture(
    p_user_id uuid,
    p_idempotency_key text,
    p_draft_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted integer;
BEGIN
    DELETE FROM draft_capture_idempotency
     WHERE user_id = p_user_id
       AND idempotency_key = p_idempotency_key
       AND draft_id = p_draft_id
       AND status = 'pending';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted = 1;
END;
$$;

REVOKE ALL ON FUNCTION reserve_draft_capture(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION complete_draft_capture(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION release_draft_capture(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_draft_capture(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION complete_draft_capture(uuid, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION release_draft_capture(uuid, text, uuid) TO service_role;
