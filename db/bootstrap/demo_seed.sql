-- db/bootstrap/demo_seed.sql
-- Three sample recipes for the demo user, so a fresh local stack has
-- something to show before the first capture. Idempotent: fixed ids with
-- ON CONFLICT DO NOTHING. The demo user row is created by scripts/demo.sh
-- through the local Auth admin API (so it has a real password); this file
-- only looks it up.

DO $$
DECLARE
    v_user UUID;
BEGIN
    SELECT id INTO v_user FROM auth.users WHERE email = 'demo@tastelog.local';
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'demo user missing: run scripts/demo.sh, which creates it first';
    END IF;

    INSERT INTO recipes (id, user_id, title, servings, prep_time, cook_time, confidence_score)
    VALUES
        ('00000000-0000-4000-8000-0000000000d1', v_user, 'Weeknight Lentil Soup', '4', '10 min', '35 min', 0.95),
        ('00000000-0000-4000-8000-0000000000d2', v_user, 'Lemon Garlic Roast Chicken', '6', '15 min', '1 hr 20 min', 0.92),
        ('00000000-0000-4000-8000-0000000000d3', v_user, 'Overnight Oats', '2', '5 min', NULL, 0.98)
    ON CONFLICT (id) DO NOTHING;
END $$;

INSERT INTO recipe_ingredients (id, recipe_id, position, quantity, unit, name, prep, raw_text) VALUES
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000d1', 1, '1', 'tbsp', 'olive oil', NULL, '1 tbsp olive oil'),
    ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000d1', 2, '1', NULL, 'onion', 'diced', '1 onion, diced'),
    ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000d1', 3, '2', 'cloves', 'garlic', 'minced', '2 cloves garlic, minced'),
    ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000d1', 4, '1 1/2', 'cups', 'red lentils', 'rinsed', '1 1/2 cups red lentils, rinsed'),
    ('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-0000000000d1', 5, '6', 'cups', 'vegetable stock', NULL, '6 cups vegetable stock'),
    ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-0000000000d1', 6, NULL, NULL, 'salt', NULL, 'salt to taste'),
    ('00000000-0000-4000-8000-0000000000e7', '00000000-0000-4000-8000-0000000000d2', 1, '1', NULL, 'whole chicken', 'about 4 lb', '1 whole chicken, about 4 lb'),
    ('00000000-0000-4000-8000-0000000000e8', '00000000-0000-4000-8000-0000000000d2', 2, '2', NULL, 'lemons', 'halved', '2 lemons, halved'),
    ('00000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-0000000000d2', 3, '6', 'cloves', 'garlic', 'smashed', '6 cloves garlic, smashed'),
    ('00000000-0000-4000-8000-0000000000ea', '00000000-0000-4000-8000-0000000000d2', 4, '3', 'tbsp', 'butter', 'softened', '3 tbsp butter, softened'),
    ('00000000-0000-4000-8000-0000000000eb', '00000000-0000-4000-8000-0000000000d3', 1, '1/2', 'cup', 'rolled oats', NULL, '1/2 cup rolled oats'),
    ('00000000-0000-4000-8000-0000000000ec', '00000000-0000-4000-8000-0000000000d3', 2, '1/2', 'cup', 'milk', NULL, '1/2 cup milk'),
    ('00000000-0000-4000-8000-0000000000ed', '00000000-0000-4000-8000-0000000000d3', 3, '1', 'tbsp', 'chia seeds', NULL, '1 tbsp chia seeds'),
    ('00000000-0000-4000-8000-0000000000ee', '00000000-0000-4000-8000-0000000000d3', 4, '1', 'tsp', 'honey', NULL, '1 tsp honey')
ON CONFLICT (id) DO NOTHING;

INSERT INTO recipe_steps (id, recipe_id, position, instruction) VALUES
    ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000d1', 1, 'Warm the oil in a large pot and soften the onion and garlic, about 5 minutes.'),
    ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000d1', 2, 'Add the lentils and stock, bring to a boil, then simmer uncovered for 25 minutes.'),
    ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000d1', 3, 'Season with salt and blend half the soup if you like it thicker.'),
    ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000d2', 1, 'Heat the oven to 425°F. Pat the chicken dry and rub the butter under and over the skin.'),
    ('00000000-0000-4000-8000-0000000000f5', '00000000-0000-4000-8000-0000000000d2', 2, 'Stuff the cavity with the lemons and garlic, then roast for 1 hour 20 minutes until the juices run clear.'),
    ('00000000-0000-4000-8000-0000000000f6', '00000000-0000-4000-8000-0000000000d2', 3, 'Rest for 15 minutes before carving.'),
    ('00000000-0000-4000-8000-0000000000f7', '00000000-0000-4000-8000-0000000000d3', 1, 'Stir everything together in a jar.'),
    ('00000000-0000-4000-8000-0000000000f8', '00000000-0000-4000-8000-0000000000d3', 2, 'Refrigerate overnight and eat cold or warmed.')
ON CONFLICT (id) DO NOTHING;
