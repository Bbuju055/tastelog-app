-- tests/db/seed_pre026.sql
-- Production-shaped data inserted BEFORE migration 026 is applied, so the
-- proof can show existing rows survive the migration with honest legacy
-- semantics (mapping version NULL, outcome NULL).
--
-- Fixed UUIDs (referenced by the proof batteries):
--   user A  00000000-0000-4000-8000-00000000000a
--   user B  00000000-0000-4000-8000-00000000000b
--   legacy recipe A1   00000000-0000-4000-8000-0000000000a1  (user A, 3 ing / 3 steps)
--   legacy recipe B1   00000000-0000-4000-8000-0000000000b1  (user B, 2 ing / 1 step)
--   legacy draft D1    00000000-0000-4000-8000-0000000000d1  (user A, no mapping key)
--   mapped draft D2    00000000-0000-4000-8000-0000000000d2  (user A, mapping key)
--   riff session S1    00000000-0000-4000-8000-0000000000c1  (user A, recipe-anchored to A1)
--   riff message M1    00000000-0000-4000-8000-0000000000e1  (assistant, generated_recipe)
--   riff session S2    00000000-0000-4000-8000-0000000000c2  (user A, draft-anchored to D2)
--   riff message M2    00000000-0000-4000-8000-0000000000e2  (assistant, generated_recipe)

-- auth.users rows are inserted by the driver (as supabase_admin) before
-- this file runs.

INSERT INTO recipes (id, user_id, title, servings, confidence_score)
VALUES
    ('00000000-0000-4000-8000-0000000000a1',
     '00000000-0000-4000-8000-00000000000a', 'Legacy Cookies', '4', 0.9),
    ('00000000-0000-4000-8000-0000000000b1',
     '00000000-0000-4000-8000-00000000000b', 'B Noodles', '2', 0.9);

INSERT INTO recipe_ingredients (id, recipe_id, position, quantity, unit, name, raw_text)
VALUES
    ('00000000-0000-4000-8000-0000000000f1',
     '00000000-0000-4000-8000-0000000000a1', 1, '2', 'cups', 'flour', '2 cups flour'),
    ('00000000-0000-4000-8000-0000000000f2',
     '00000000-0000-4000-8000-0000000000a1', 2, '1', 'cup', 'sugar', '1 cup sugar'),
    ('00000000-0000-4000-8000-0000000000f3',
     '00000000-0000-4000-8000-0000000000a1', 3, NULL, NULL, 'butter', 'butter'),
    ('00000000-0000-4000-8000-0000000000f4',
     '00000000-0000-4000-8000-0000000000b1', 1, '200', 'g', 'noodles', '200 g noodles'),
    ('00000000-0000-4000-8000-0000000000f5',
     '00000000-0000-4000-8000-0000000000b1', 2, '1', 'tbsp', 'soy sauce', '1 tbsp soy sauce');

INSERT INTO recipe_steps (id, recipe_id, position, instruction)
VALUES
    ('00000000-0000-4000-8000-0000000000a2',
     '00000000-0000-4000-8000-0000000000a1', 1, 'Preheat the oven'),
    ('00000000-0000-4000-8000-0000000000a3',
     '00000000-0000-4000-8000-0000000000a1', 2, 'Mix flour and sugar'),
    ('00000000-0000-4000-8000-0000000000a4',
     '00000000-0000-4000-8000-0000000000a1', 3, 'Fold in the butter'),
    ('00000000-0000-4000-8000-0000000000b2',
     '00000000-0000-4000-8000-0000000000b1', 1, 'Boil the noodles');

-- Legacy draft: raw_model_json WITHOUT the mapping key (build-3 shape).
INSERT INTO recipe_drafts
    (id, user_id, image_storage_keys, title, servings, confidence_score,
     ingredients, steps, raw_model_json, model_version, parser_version)
VALUES (
    '00000000-0000-4000-8000-0000000000d1',
    '00000000-0000-4000-8000-00000000000a',
    '["k1.jpg"]'::jsonb,
    'Legacy Draft', '2', 0.8,
    '[{"quantity":"1","unit":"cup","name":"rice","prep":null,"raw_text":"1 cup rice"}]'::jsonb,
    '[{"position":1,"instruction":"Cook the rice"}]'::jsonb,
    '{"title":"Legacy Draft"}'::jsonb,
    'test-model', '1.0'
);

-- Mapping-aware draft: raw_model_json WITH step_ingredient_positions.
INSERT INTO recipe_drafts
    (id, user_id, image_storage_keys, title, servings, confidence_score,
     ingredients, steps, raw_model_json, model_version, parser_version)
VALUES (
    '00000000-0000-4000-8000-0000000000d2',
    '00000000-0000-4000-8000-00000000000a',
    '["k2.jpg"]'::jsonb,
    'Mapped Draft', '2', 0.8,
    '[{"quantity":"1","unit":"cup","name":"oats","prep":null,"raw_text":"1 cup oats"}]'::jsonb,
    '[{"position":1,"instruction":"Toast the oats"}]'::jsonb,
    '{"title":"Mapped Draft","step_ingredient_positions":[[1]]}'::jsonb,
    'test-model', '1.1'
);

-- Recipe-anchored riff session + assistant message with generated_recipe.
INSERT INTO riff_sessions (id, user_id, source_recipe_id)
VALUES ('00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000a1');

INSERT INTO riff_messages (id, session_id, role, content, generated_recipe)
VALUES ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000c1',
        'assistant', 'Here is a riff.',
        '{"title":"Riffed Cookies","servings":"4","prep_time":null,"cook_time":null,
          "confidence":1.0,
          "ingredients":[{"quantity":"2","unit":"cups","name":"flour","prep":null},
                         {"quantity":null,"unit":null,"name":"honey","prep":null}],
          "steps":[{"position":1,"instruction":"Mix flour and honey"},
                   {"position":2,"instruction":"Bake"}]}'::jsonb);

-- Draft-anchored riff session + assistant message (Slice F shape).
INSERT INTO riff_sessions (id, user_id, source_recipe_id, source_draft_id)
VALUES ('00000000-0000-4000-8000-0000000000c2',
        '00000000-0000-4000-8000-00000000000a',
        NULL,
        '00000000-0000-4000-8000-0000000000d2');

INSERT INTO riff_messages (id, session_id, role, content, generated_recipe)
VALUES ('00000000-0000-4000-8000-0000000000e2',
        '00000000-0000-4000-8000-0000000000c2',
        'assistant', 'Here is a draft riff.',
        '{"title":"Riffed Oats","servings":"2","prep_time":null,"cook_time":null,
          "confidence":1.0,
          "ingredients":[{"quantity":"1","unit":"cup","name":"oats","prep":null}],
          "steps":[{"position":1,"instruction":"Toast the oats well"}]}'::jsonb);
