-- tests/db/proof_migration_028.sql
-- Real-PostgreSQL proof battery for migration 028 (draft capture
-- idempotency). Runs AFTER the 027 batteries and migration 028 itself.
-- Single-session batteries I0..I14; the concurrent battery C-ID1 lives in
-- run_db_proof.sh.
--
-- Every check either raises (via _assert / _expect_err) or passes
-- silently; the driver treats any error as failure of the whole proof.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION _assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF cond IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'ASSERT FAILED: %', msg;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION _expect_err(sql text, want_state text, msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE sql;
        RAISE EXCEPTION 'ASSERT FAILED (no error raised): %', msg;
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM LIKE 'ASSERT FAILED%' THEN
                RAISE;
            END IF;
            IF SQLSTATE IS DISTINCT FROM want_state THEN
                RAISE EXCEPTION
                    'ASSERT FAILED (wanted % got % / %): %',
                    want_state, SQLSTATE, SQLERRM, msg;
            END IF;
    END;
END;
$$;

-- Fixed ids: user A / user B are seeded by the driver.
--   user A  00000000-0000-4000-8000-00000000000a
--   user B  00000000-0000-4000-8000-00000000000b

-- Draft ids minted by the "API" for each reservation.
--   D1 00000000-0000-4000-8000-00000000d001   D9 00000000-0000-4000-8000-00000000d009
--   DX 00000000-0000-4000-8000-00000000d0ff   (a stale owner's id, never reserved)

\echo '=== I0: table posture (RLS on, service_role only) ==='
SELECT _assert(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'draft_capture_idempotency'),
  'I0: RLS enabled');
SELECT _assert(
  NOT has_table_privilege('anon', 'draft_capture_idempotency', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'draft_capture_idempotency', 'SELECT')
  AND NOT has_table_privilege('anon', 'draft_capture_idempotency', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'draft_capture_idempotency', 'INSERT'),
  'I0: anon/authenticated hold no table privilege');
SELECT _assert(
  has_table_privilege('service_role', 'draft_capture_idempotency', 'INSERT'),
  'I0: service_role may write');
SELECT _assert(
  NOT has_function_privilege('anon', 'reserve_draft_capture(uuid, text, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'reserve_draft_capture(uuid, text, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'complete_draft_capture(uuid, text, uuid, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'release_draft_capture(uuid, text, uuid)', 'EXECUTE'),
  'I0: anon/authenticated cannot execute the RPCs');
SELECT _assert(
  has_function_privilege('service_role', 'reserve_draft_capture(uuid, text, text, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'complete_draft_capture(uuid, text, uuid, jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'release_draft_capture(uuid, text, uuid)', 'EXECUTE'),
  'I0: service_role can execute the RPCs');

\echo '=== I1: first reservation wins and records the draft id ==='
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h1',
                        '00000000-0000-4000-8000-00000000d001') = '{"outcome":"reserved"}'::jsonb,
  'I1: fresh key is reserved');
SELECT _assert(
  (SELECT status = 'pending' AND response_json IS NULL
      AND draft_id = '00000000-0000-4000-8000-00000000d001'
   FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1'),
  'I1: row is pending, no response, owner draft id stored');

\echo '=== I2: same key, same payload, holder has no draft yet -> in_progress ==='
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h1',
                        '00000000-0000-4000-8000-00000000d0ff') = '{"outcome":"in_progress"}'::jsonb,
  'I2: pending key reports in_progress');

\echo '=== I3: same key, different payload -> mismatch ==='
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'OTHER',
                        '00000000-0000-4000-8000-00000000d0ff') = '{"outcome":"mismatch"}'::jsonb,
  'I3: payload mismatch while pending');

\echo '=== I4: only the owner can complete; completion happens once ==='
SELECT _assert(
  NOT complete_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1',
                             '00000000-0000-4000-8000-00000000d0ff', '{"id":"stale"}'::jsonb),
  'I4: a stale owner (other draft id) cannot complete');
SELECT _assert(
  (SELECT status = 'pending' FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1'),
  'I4: row untouched by the stale completion');
SELECT _assert(
  complete_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1',
                         '00000000-0000-4000-8000-00000000d001', '{"id":"d1","title":"Pancakes"}'::jsonb),
  'I4: owner completes its pending row');
SELECT _assert(
  (SELECT status = 'done' AND response_json = '{"id":"d1","title":"Pancakes"}'::jsonb
   FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1'),
  'I4: row is done with the response');
SELECT _assert(
  NOT complete_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1',
                             '00000000-0000-4000-8000-00000000d001', '{"id":"d2"}'::jsonb),
  'I4: completing a done row is a no-op (false)');
SELECT _assert(
  (SELECT response_json ->> 'id' = 'd1'
   FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1'),
  'I4: second completion did not overwrite the response');

\echo '=== I5: replay returns the recorded response ==='
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h1',
                        '00000000-0000-4000-8000-00000000d0ff')
    = '{"outcome":"replay","response":{"id":"d1","title":"Pancakes"}}'::jsonb,
  'I5: done key replays its response');

\echo '=== I6: mismatch is reported even after completion ==='
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'OTHER',
                        '00000000-0000-4000-8000-00000000d0ff') = '{"outcome":"mismatch"}'::jsonb,
  'I6: payload mismatch on a done key');

\echo '=== I7: keys are scoped per user ==='
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000b', 'k1', 'h1',
                        '00000000-0000-4000-8000-00000000d0b1') = '{"outcome":"reserved"}'::jsonb,
  'I7: user B reserves the same key independently');

\echo '=== I8: only the owner can release, and only a pending row ==='
SELECT _assert(
  NOT release_draft_capture('00000000-0000-4000-8000-00000000000b', 'k1',
                            '00000000-0000-4000-8000-00000000d0ff'),
  'I8: a stale owner cannot release');
SELECT _assert(
  release_draft_capture('00000000-0000-4000-8000-00000000000b', 'k1',
                        '00000000-0000-4000-8000-00000000d0b1'),
  'I8: owner releases its pending reservation');
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000b', 'k1', 'h2',
                        '00000000-0000-4000-8000-00000000d0b2') = '{"outcome":"reserved"}'::jsonb,
  'I8: released key can be reserved again (new payload accepted)');
SELECT _assert(
  NOT release_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1',
                            '00000000-0000-4000-8000-00000000d001'),
  'I8: releasing a done key is refused (false)');
SELECT _assert(
  (SELECT count(*) = 1 FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1' AND status = 'done'),
  'I8: done row survives a release attempt');

\echo '=== I9: an expired row is reusable ==='
UPDATE draft_capture_idempotency SET expires_at = now() - INTERVAL '1 second'
 WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1';
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h9',
                        '00000000-0000-4000-8000-00000000d009') = '{"outcome":"reserved"}'::jsonb,
  'I9: expired key reserved afresh, even with a new payload');
SELECT _assert(
  (SELECT status = 'pending' AND payload_hash = 'h9' AND response_json IS NULL
      AND draft_id = '00000000-0000-4000-8000-00000000d009'
   FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1'),
  'I9: the fresh row replaced the expired one');

\echo '=== I10: no time-based takeover of a pending key ==='
UPDATE draft_capture_idempotency SET created_at = now() - INTERVAL '3 hours'
 WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1';
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h9',
                        '00000000-0000-4000-8000-00000000d0ff') = '{"outcome":"in_progress"}'::jsonb,
  'I10: an old pending key without a draft stays in_progress (no takeover)');
SELECT _assert(
  (SELECT draft_id = '00000000-0000-4000-8000-00000000d009' AND status = 'pending'
   FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1'),
  'I10: the original owner still holds the row');

\echo '=== I11: holder wrote its draft but never completed -> recover ==='
INSERT INTO recipe_drafts (id, user_id, title, model_version, parser_version, image_storage_keys)
VALUES ('00000000-0000-4000-8000-00000000d009', '00000000-0000-4000-8000-00000000000a',
        'Recovered Pancakes', 'm', 'p', '["a/x.jpg"]'::jsonb);
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h9',
                        '00000000-0000-4000-8000-00000000d0ff')
    = '{"outcome":"recover","draft_id":"00000000-0000-4000-8000-00000000d009"}'::jsonb,
  'I11: retry recovers the exact draft the holder wrote');
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'OTHER',
                        '00000000-0000-4000-8000-00000000d0ff') = '{"outcome":"mismatch"}'::jsonb,
  'I11: a different payload is still a mismatch, never a recovery');
SELECT _assert(
  (SELECT count(*) = 1 FROM draft_capture_idempotency
   WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND idempotency_key = 'k1' AND status = 'pending'),
  'I11: recovery does not change the row');
-- A draft owned by ANOTHER user under that id is not recoverable for this user.
DELETE FROM recipe_drafts WHERE id = '00000000-0000-4000-8000-00000000d009';
INSERT INTO recipe_drafts (id, user_id, title, model_version, parser_version, image_storage_keys)
VALUES ('00000000-0000-4000-8000-00000000d009', '00000000-0000-4000-8000-00000000000b',
        'Not Yours', 'm', 'p', '["b/x.jpg"]'::jsonb);
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', 'h9',
                        '00000000-0000-4000-8000-00000000d0ff') = '{"outcome":"in_progress"}'::jsonb,
  'I11: a draft with that id owned by someone else is not recovered');
DELETE FROM recipe_drafts WHERE id = '00000000-0000-4000-8000-00000000d009';

\echo '=== I12: table invariants ==='
SELECT _expect_err(
  $q$INSERT INTO draft_capture_idempotency (user_id, idempotency_key, payload_hash, draft_id, status)
     VALUES ('00000000-0000-4000-8000-00000000000a', 'bad-done', 'h', gen_random_uuid(), 'done')$q$,
  '23514', 'I12: done without a response is rejected');
SELECT _expect_err(
  $q$INSERT INTO draft_capture_idempotency (user_id, idempotency_key, payload_hash, draft_id, status, response_json)
     VALUES ('00000000-0000-4000-8000-00000000000a', 'bad-pending', 'h', gen_random_uuid(), 'pending', '{}'::jsonb)$q$,
  '23514', 'I12: pending with a response is rejected');
SELECT _expect_err(
  $q$INSERT INTO draft_capture_idempotency (user_id, idempotency_key, payload_hash, draft_id, status)
     VALUES ('00000000-0000-4000-8000-00000000000a', '', 'h', gen_random_uuid(), 'pending')$q$,
  '23514', 'I12: empty key is rejected');
SELECT _expect_err(
  $q$INSERT INTO draft_capture_idempotency (user_id, idempotency_key, payload_hash, status)
     VALUES ('00000000-0000-4000-8000-00000000000a', 'no-draft', 'h', 'pending')$q$,
  '23502', 'I12: a reservation without a draft id is rejected');
SELECT _expect_err(
  $q$INSERT INTO draft_capture_idempotency (user_id, idempotency_key, payload_hash, draft_id, status)
     VALUES ('00000000-0000-4000-8000-0000000000ff', 'orphan', 'h', gen_random_uuid(), 'pending')$q$,
  '23503', 'I12: unknown user is rejected');

\echo '=== I13: null arguments are a typed error ==='
SELECT _expect_err(
  $q$SELECT reserve_draft_capture(NULL, 'k', 'h', gen_random_uuid())$q$, 'TL422', 'I13: null user');
SELECT _expect_err(
  $q$SELECT reserve_draft_capture('00000000-0000-4000-8000-00000000000a', NULL, 'h', gen_random_uuid())$q$, 'TL422', 'I13: null key');
SELECT _expect_err(
  $q$SELECT reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k', 'h', NULL)$q$, 'TL422', 'I13: null draft id');
SELECT _expect_err(
  $q$SELECT complete_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', '00000000-0000-4000-8000-00000000d009', NULL)$q$, 'TL422', 'I13: null response');

\echo '=== I14: lesser roles are refused at the function boundary ==='
SET ROLE anon;
SELECT _expect_err(
  $q$SELECT reserve_draft_capture('00000000-0000-4000-8000-00000000000a', 'k-anon', 'h', gen_random_uuid())$q$,
  '42501', 'I14: anon cannot reserve');
SELECT _expect_err(
  $q$SELECT * FROM draft_capture_idempotency$q$, '42501', 'I14: anon cannot read the table');
RESET ROLE;
SET ROLE authenticated;
SELECT _expect_err(
  $q$SELECT release_draft_capture('00000000-0000-4000-8000-00000000000a', 'k1', '00000000-0000-4000-8000-00000000d009')$q$,
  '42501', 'I14: authenticated cannot release');
RESET ROLE;
SET ROLE service_role;
SELECT _assert(
  reserve_draft_capture('00000000-0000-4000-8000-00000000000b', 'k-svc', 'h',
                        '00000000-0000-4000-8000-00000000d0b3') = '{"outcome":"reserved"}'::jsonb,
  'I14: service_role reserves');
SELECT _assert(release_draft_capture('00000000-0000-4000-8000-00000000000b', 'k-svc',
                                     '00000000-0000-4000-8000-00000000d0b3'),
  'I14: service_role releases');
RESET ROLE;

\echo '=== 028 single-session batteries passed ==='
