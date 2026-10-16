"""Phase 13.4.C — Riff prompt revision eval set.

Source recipes + case registry for baseline and post-revision evals.
Hand-authored, deterministic, committed as fixtures. Not loaded by
production code or pytest test collection.

Recipe shape matches what `core.recipes.get_recipe` returns and what
`api.core.riff.build_riff_system_prompt` consumes (i.e., the same shape
as `tests/test_riff.py::_fake_recipe()`).

The case registry maps each case to a single-turn user message plus
the expected response shape and gate notes from
`docs/phase13-4-A-riff-prompt-audit.md` (§9 / §10).
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Source recipes
# ---------------------------------------------------------------------------

R1_PASTA: dict = {
    "id": "r1-pasta-alfredo",
    "user_id": "00000000-0000-0000-0000-000000000001",
    "title": "Fettuccine Alfredo with Garlic Cream",
    "servings": "4",
    "prep_time": "10 min",
    "cook_time": "20 min",
    "ingredients": [
        {"quantity": "1", "unit": "lb", "name": "fettuccine", "prep": None},
        {"quantity": "4", "unit": "tbsp", "name": "unsalted butter", "prep": None},
        {"quantity": "3", "unit": None, "name": "garlic cloves", "prep": "minced"},
        {"quantity": "1", "unit": "cup", "name": "heavy cream", "prep": None},
        {"quantity": "1", "unit": "cup", "name": "parmesan", "prep": "finely grated"},
        {"quantity": None, "unit": None, "name": "salt", "prep": "to taste"},
        {"quantity": None, "unit": None, "name": "black pepper", "prep": "freshly ground"},
        {"quantity": "1", "unit": "pinch", "name": "nutmeg", "prep": "freshly grated"},
        {"quantity": "2", "unit": "tbsp", "name": "parsley", "prep": "chopped, for garnish"},
    ],
    "steps": [
        {
            "position": 1,
            "instruction": (
                "Bring a large pot of salted water to a boil and cook the fettuccine "
                "until just shy of al dente. Reserve 1 cup of pasta water and drain."
            ),
        },
        {
            "position": 2,
            "instruction": (
                "While the pasta cooks, melt the butter in a wide skillet over "
                "medium-low heat. Add the garlic and sweat for 1 minute without browning."
            ),
        },
        {
            "position": 3,
            "instruction": (
                "Pour in the heavy cream and bring to a gentle simmer. Reduce for "
                "2 minutes until it coats the back of a spoon."
            ),
        },
        {
            "position": 4,
            "instruction": (
                "Lower the heat. Whisk in the parmesan a handful at a time until the "
                "sauce is smooth and glossy. Season with salt, pepper, and the pinch of nutmeg."
            ),
        },
        {
            "position": 5,
            "instruction": (
                "Add the drained fettuccine and toss to coat, loosening with reserved "
                "pasta water as needed."
            ),
        },
        {
            "position": 6,
            "instruction": "Serve immediately, finishing each portion with chopped parsley.",
        },
    ],
    "tags": [],
}


R2_SHEETPAN_CHICKEN: dict = {
    "id": "r2-soy-sheetpan-chicken",
    "user_id": "00000000-0000-0000-0000-000000000001",
    "title": "Soy-Glazed Sheet-Pan Chicken Thighs",
    # Servings deliberately absent — exercises F14 (do not invent missing details).
    "servings": None,
    "prep_time": "15 min",
    "cook_time": "35 min",
    "ingredients": [
        {"quantity": "6", "unit": None, "name": "bone-in skin-on chicken thighs", "prep": None},
        {"quantity": "1/4", "unit": "cup", "name": "soy sauce", "prep": None},
        {"quantity": "2", "unit": "tbsp", "name": "mirin", "prep": None},
        {"quantity": "2", "unit": "tbsp", "name": "brown sugar", "prep": "packed"},
        {"quantity": "1", "unit": "tbsp", "name": "fresh ginger", "prep": "grated"},
        {"quantity": "3", "unit": None, "name": "garlic cloves", "prep": "minced"},
        {"quantity": "1", "unit": "tsp", "name": "toasted sesame oil", "prep": None},
        {"quantity": "1", "unit": "tsp", "name": "fish sauce", "prep": None},
        {"quantity": "4", "unit": "cups", "name": "broccoli florets", "prep": None},
        {"quantity": "2", "unit": "tbsp", "name": "scallions", "prep": "thinly sliced"},
        {"quantity": "1", "unit": "tbsp", "name": "sesame seeds", "prep": "toasted"},
    ],
    "steps": [
        {
            "position": 1,
            "instruction": "Heat the oven to 425°F. Line a sheet pan with foil.",
        },
        {
            "position": 2,
            "instruction": (
                "In a small bowl, whisk together the soy sauce, mirin, brown sugar, "
                "ginger, garlic, sesame oil, and fish sauce."
            ),
        },
        {
            "position": 3,
            "instruction": (
                "Toss the chicken thighs in two-thirds of the glaze and let them sit "
                "while the oven heats — at least 10 minutes."
            ),
        },
        {
            "position": 4,
            "instruction": (
                "Arrange the chicken skin-side up on the sheet pan. Toss the broccoli "
                "with the remaining glaze and scatter it around the chicken."
            ),
        },
        {
            "position": 5,
            "instruction": (
                "Roast for 30–35 minutes, until the chicken registers 175°F at the "
                "thigh and the skin is deeply burnished."
            ),
        },
        {
            "position": 6,
            "instruction": "Rest 5 minutes, then garnish with scallions and sesame seeds.",
        },
    ],
    "tags": [],
}


R3_CORNMEAL_FISH: dict = {
    "id": "r3-cornmeal-fish",
    "user_id": "00000000-0000-0000-0000-000000000001",
    "title": "Pan-Fried Cornmeal-Crusted Catfish",
    "servings": "2",
    "prep_time": "10 min",
    "cook_time": "12 min",
    "ingredients": [
        {"quantity": "2", "unit": None, "name": "catfish fillets", "prep": "about 6 oz each"},
        {"quantity": "1", "unit": "cup", "name": "buttermilk", "prep": None},
        {"quantity": "1/2", "unit": "cup", "name": "fine cornmeal", "prep": None},
        {"quantity": "1/4", "unit": "cup", "name": "all-purpose flour", "prep": None},
        {"quantity": "1", "unit": "tsp", "name": "smoked paprika", "prep": None},
        {"quantity": "1/2", "unit": "tsp", "name": "garlic powder", "prep": None},
        {"quantity": "1", "unit": "tsp", "name": "kosher salt", "prep": None},
        {"quantity": "1/4", "unit": "tsp", "name": "black pepper", "prep": None},
        {"quantity": "1/4", "unit": "cup", "name": "neutral oil", "prep": "for frying"},
        {"quantity": "1", "unit": None, "name": "lemon", "prep": "cut into wedges"},
    ],
    "steps": [
        {
            "position": 1,
            "instruction": "Soak the fillets in buttermilk for 30 minutes in the fridge.",
        },
        {
            "position": 2,
            "instruction": (
                "On a wide plate, whisk together the cornmeal, flour, paprika, "
                "garlic powder, salt, and pepper."
            ),
        },
        {
            "position": 3,
            "instruction": (
                "Lift each fillet from the buttermilk, letting the excess drip off, "
                "and dredge thoroughly in the cornmeal mixture, pressing to adhere."
            ),
        },
        {
            "position": 4,
            "instruction": "Heat the oil in a heavy skillet over medium-high until it shimmers.",
        },
        {
            "position": 5,
            "instruction": (
                "Lay the fillets in away from you and pan-fry undisturbed for 3–4 "
                "minutes per side, until the crust is deep gold and the fish flakes."
            ),
        },
        {
            "position": 6,
            "instruction": "Drain briefly on a wire rack. Serve with lemon wedges.",
        },
    ],
    "tags": [],
}


RECIPES_BY_ID: dict[str, dict] = {
    R1_PASTA["id"]: R1_PASTA,
    R2_SHEETPAN_CHICKEN["id"]: R2_SHEETPAN_CHICKEN,
    R3_CORNMEAL_FISH["id"]: R3_CORNMEAL_FISH,
}


# ---------------------------------------------------------------------------
# Eval cases
# ---------------------------------------------------------------------------
#
# expected_shape values:
#   "recipe_json"  — a fenced ```recipe-json``` block IS expected
#   "prose_only"   — NO fenced block expected
#   "either"       — either is acceptable (G2 not gated for these cells)
#
# anchor: the eval-set ID from docs/phase13-4-A-riff-prompt-audit.md §9.
#         E_DIAB is the additional diabetic / blood-sugar-friendly case
#         added in 13.4.C.

EVAL_CASES: list[dict] = [
    # ---- R1 — Pasta (Italian, stovetop, dairy-rich, high-glycemic carb base)
    {
        "case_id": "C01",
        "recipe_id": R1_PASTA["id"],
        "anchor": "E1",
        "user_turn": "Make it dairy-free.",
        "expected_shape": "recipe_json",
        "preservation": (
            "Title, servings, timing, non-dairy ingredients, non-dairy steps unchanged."
        ),
        "gate_focus": ["G1", "G2", "G3", "G7"],
        "notes": (
            "Hidden dairy: parmesan + butter + heavy cream. Step 4 (whisk-in parmesan) "
            "must update. Cuisine drift signal: should remain Italian."
        ),
    },
    {
        "case_id": "C02",
        "recipe_id": R1_PASTA["id"],
        "anchor": "E3",
        "user_turn": "Double this for 8 people.",
        "expected_shape": "recipe_json",
        "preservation": (
            "Title, prep/cook descriptions, ingredient names, step structure unchanged."
        ),
        "gate_focus": ["G1", "G2", "G3", "G6"],
        "notes": (
            "Pan-cooked → G6 triggers (skillet size or two-batch note expected). "
            "Servings field must update from '4' to '8'."
        ),
    },
    {
        "case_id": "C03",
        "recipe_id": R1_PASTA["id"],
        "anchor": "E7",
        "user_turn": "What can I use instead of heavy cream?",
        "expected_shape": "prose_only",
        "preservation": "Source recipe untouched.",
        "gate_focus": ["G2", "G4", "G5", "G7"],
        "notes": (
            "Substitute must be grounded in cream's role in this recipe "
            "(richness + emulsification with parmesan + body of the sauce). "
            "Generic substitution lists fail G5."
        ),
    },
    {
        "case_id": "C04",
        "recipe_id": R1_PASTA["id"],
        "anchor": "E12",
        "user_turn": "What should I serve with this?",
        "expected_shape": "prose_only",
        "preservation": "Source recipe untouched.",
        "gate_focus": ["G2", "G4", "G7"],
        "notes": "One or two specific pairings. No long list. No block.",
    },
    {
        "case_id": "C05",
        "recipe_id": R1_PASTA["id"],
        "anchor": "E11",
        "user_turn": "Turn this into meal prep for the week.",
        "expected_shape": "recipe_json",
        "preservation": "Cuisine and flavor profile preserved.",
        "gate_focus": ["G1", "G2", "G3"],
        "notes": (
            "Real adaptation expected: undercook pasta, sauce + pasta separation for "
            "storage, reheat with reserved water. Storage advice without ingredient/step "
            "changes is a half-done answer."
        ),
    },
    {
        "case_id": "C06",
        "recipe_id": R1_PASTA["id"],
        "anchor": "E_DIAB",
        "user_turn": "Make it diabetic-friendly.",
        "expected_shape": "either",
        "preservation": "Cuisine kept; flavor profile preserved within the constraint.",
        "gate_focus": ["G1", "G3", "G4", "G5", "G7"],
        "notes": (
            "Adapt the high-glycemic carb base (e.g. pasta swap to chickpea/lentil pasta "
            "or zucchini ribbons) and/or add protein/fiber to slow absorption. MUST NOT "
            "include medical claims, diagnostic language, or 'consult your doctor' filler. "
            "Should stay cooking-focused, not advice-mode. Recipe-json only if a "
            "complete coherent variant is produced; prose otherwise."
        ),
    },

    # ---- R2 — Sheet-pan chicken (Japanese-leaning, oven, soy/fish sauce hazards)
    {
        "case_id": "C07",
        "recipe_id": R2_SHEETPAN_CHICKEN["id"],
        "anchor": "E2",
        "user_turn": "Make this gluten-free.",
        "expected_shape": "recipe_json",
        "preservation": (
            "Title, servings (null), timing, non-gluten ingredients/steps unchanged."
        ),
        "gate_focus": ["G1", "G2", "G3", "G7"],
        "notes": (
            "Hidden gluten: soy sauce → swap for tamari or GF soy sauce. "
            "Mirin and fish sauce vary by brand — minimally a callout, ideally a swap."
        ),
    },
    {
        "case_id": "C08",
        "recipe_id": R2_SHEETPAN_CHICKEN["id"],
        "anchor": "E4",
        "user_turn": (
            "I only have boneless skinless thighs, not bone-in skin-on. Will it still work?"
        ),
        "expected_shape": "either",
        "preservation": "Source recipe untouched in prose response.",
        "gate_focus": ["G2", "G4", "G5"],
        "notes": (
            "Should call out lower fat → drier outcome and shorter cook time. "
            "Generic 'they're interchangeable' is a G5 failure."
        ),
    },
    {
        "case_id": "C09",
        "recipe_id": R2_SHEETPAN_CHICKEN["id"],
        "anchor": "E8",
        "user_turn": "Make it vegetarian.",
        "expected_shape": "recipe_json",
        "preservation": (
            "Servings (null), timing, non-meat steps largely unchanged. "
            "Title changes ONLY the replaced core protein words per the "
            "truthful-title rule."
        ),
        "gate_focus": ["G1", "G2", "G3", "G7"],
        "notes": (
            "Must replace chicken with structurally appropriate sub (firm tofu, tempeh, "
            "or roasted king oyster mushrooms) AND remove fish sauce. Half-done answers "
            "(meat removed but fish sauce retained) are explicit G3 failures."
        ),
    },
    {
        "case_id": "C10",
        "recipe_id": R2_SHEETPAN_CHICKEN["id"],
        "anchor": "E11",
        "user_turn": "Turn this into meal prep.",
        "expected_shape": "recipe_json",
        "preservation": "Cuisine + flavor profile preserved.",
        "gate_focus": ["G1", "G2", "G3"],
        "notes": (
            "Re-portioning + storage note in steps; ingredients/steps actually updated, "
            "not just appended commentary."
        ),
    },

    # ---- R3 — Pan-fried fish (American, stovetop, cornmeal crust + buttermilk marinade)
    {
        "case_id": "C11",
        "recipe_id": R3_CORNMEAL_FISH["id"],
        "anchor": "E5",
        "user_turn": "Make it spicier.",
        "expected_shape": "either",
        "preservation": "Cuisine, flavor profile preserved minus the spice axis.",
        "gate_focus": ["G2", "G4", "G5", "G7"],
        "notes": (
            "Specific addition expected (e.g. cayenne in dredge; hot sauce in buttermilk "
            "soak). Block only if multiple lines change."
        ),
    },
    {
        "case_id": "C12",
        "recipe_id": R3_CORNMEAL_FISH["id"],
        "anchor": "E6",
        "user_turn": "Can I bake this instead of pan-frying?",
        "expected_shape": "recipe_json",
        "preservation": (
            "Ingredients (mostly), serving size unchanged. Title changes ONLY "
            "the cooking-method words per the truthful-title rule."
        ),
        "gate_focus": ["G1", "G2", "G3", "G6"],
        "notes": (
            "Method, temperature, timing, doneness cues all updated. Equipment delta "
            "acknowledged (sheet pan + wire rack vs. skillet)."
        ),
    },
    {
        "case_id": "C13",
        "recipe_id": R3_CORNMEAL_FISH["id"],
        "anchor": "E9",
        "user_turn": "I only have 30 minutes total. Can I still make this?",
        "expected_shape": "either",
        "preservation": "Source recipe untouched in prose response.",
        "gate_focus": ["G2", "G4", "G5", "G7"],
        "notes": (
            "Cut the buttermilk soak (or shorten to 10 min), keep the dredge, total ≤30 min. "
            "Generic 'use shortcuts' is a G5 failure."
        ),
    },
    {
        "case_id": "C14",
        "recipe_id": R3_CORNMEAL_FISH["id"],
        "anchor": "E10",
        "user_turn": "Make this less salty.",
        "expected_shape": "either",
        "preservation": "Recipe structure unchanged.",
        "gate_focus": ["G2", "G4", "G5", "G7"],
        "notes": (
            "Specific reduction (drop or halve the 1 tsp kosher salt in the dredge; "
            "consider unsalted buttermilk note). Vague 'reduce salt' is a G5 failure."
        ),
    },
]
