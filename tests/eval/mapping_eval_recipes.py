"""Issue 1: adversarial fixture corpus for the step-mapping quality gate.

Three hand-authored recipes jointly covering: exact names, shorthand/head
nouns, collective references ("the dry ingredients"), repeated ingredient
use, ingredients reused across multiple steps, near-duplicate rows,
same-head negative traps (white vs brown sugar, all-purpose vs cake flour
class, olive vs sesame oil), ranges, "to taste", non-ASCII names, genuine
no-ingredient steps, and a step using more than four ingredients.

GOLDEN SEMANTICS
  Each step's golden is a list of ACCEPTED sets of fixture ingredient
  positions (1-based). A produced mapping for a step passes iff it equals
  one of the accepted sets. Most steps have exactly one accepted set; the
  intermediate-mixture case (R3 step 4) accepts either the minimal reading
  or the constituents-included reading, both truthful.

  PASS gate (run_mapping_eval.py):
    a. zero false positives: every produced association set must equal an
       accepted set (a superset/foreign ingredient is a failure);
    b. expected associations present on BOTH runs of a cell;
    c. golden [] steps must come back authoritative-empty;
    d. malformed output never surfaces as authoritative (harness asserts
       the four-state validator output only);
    e. extraction equivalence (vision/text paths): every fixture
       ingredient matches exactly one extracted ingredient and step count
       matches.
"""

from __future__ import annotations

from typing import Any

# Each ingredient: fixture position order defines identity.
#   text       -> the raw line as it appears in the rendered/text recipe
#   structured -> dict used for the mapper paths (JSON-LD / riff shapes)
#   match      -> lowercase name the extraction aligner requires (unique
#                 within the recipe when paired with quantity)

MAPPING_EVAL_RECIPES: list[dict[str, Any]] = [
    {
        "id": "R1_cookies",
        "title": "Brown Butter Chocolate Chip Cookies",
        "servings": "24 cookies",
        "ingredients": [
            {"text": "2 cups all-purpose flour", "quantity": "2", "unit": "cups", "name": "all-purpose flour", "prep": None},
            {"text": "1/2 cup white sugar", "quantity": "1/2", "unit": "cup", "name": "white sugar", "prep": None},
            {"text": "3/4 cup brown sugar", "quantity": "3/4", "unit": "cup", "name": "brown sugar", "prep": None},
            {"text": "1 tsp baking soda", "quantity": "1", "unit": "tsp", "name": "baking soda", "prep": None},
            {"text": "1/2 tsp salt", "quantity": "1/2", "unit": "tsp", "name": "salt", "prep": None},
            {"text": "1 cup butter", "quantity": "1", "unit": "cup", "name": "butter", "prep": None},
            {"text": "2 eggs", "quantity": "2", "unit": None, "name": "eggs", "prep": None},
            {"text": "2 cups chocolate chips", "quantity": "2", "unit": "cups", "name": "chocolate chips", "prep": None},
        ],
        "steps": [
            {
                "text": "Preheat the oven to 350°F and line a baking sheet with parchment.",
                "accepted": [[]],
            },
            {
                # Shorthand: "the butter" vs "1 cup butter".
                "text": "Brown the butter in a saucepan, then let it cool slightly.",
                "accepted": [[6]],
            },
            {
                # Exact + same-head discrimination is NOT required here, but
                # flour shorthand is ("the flour" = all-purpose flour).
                "text": "Whisk the flour, baking soda, and salt together in a bowl.",
                "accepted": [[1, 4, 5]],
            },
            {
                # Same-head trap: BOTH sugars named explicitly; butter reused.
                "text": "Beat the browned butter with the white sugar and brown sugar until fluffy.",
                "accepted": [[2, 3, 6]],
            },
            {
                # Collective ("the dry ingredients" = flour + baking soda +
                # salt) + >4 ingredients + reuse across steps.
                "text": "Add the eggs one at a time, then fold in the dry ingredients and the chocolate chips.",
                "accepted": [[1, 4, 5, 7, 8]],
            },
            {
                "text": "Rest the dough in the refrigerator for 30 minutes.",
                "accepted": [[]],
            },
            {
                "text": "Bake for 11 to 12 minutes, then cool on a rack.",
                "accepted": [[]],
            },
        ],
    },
    {
        "id": "R2_noodles",
        "title": "Sesame Ginger Noodles",
        "servings": "2 servings",
        "ingredients": [
            {"text": "8 oz rice noodles", "quantity": "8", "unit": "oz", "name": "rice noodles", "prep": None},
            {"text": "2 tbsp sesame oil", "quantity": "2", "unit": "tbsp", "name": "sesame oil", "prep": None},
            {"text": "1 tbsp olive oil", "quantity": "1", "unit": "tbsp", "name": "olive oil", "prep": None},
            {"text": "2-3 cloves garlic, minced", "quantity": "2-3", "unit": "cloves", "name": "garlic", "prep": "minced"},
            {"text": "1 inch fresh ginger, grated", "quantity": "1", "unit": "inch", "name": "fresh ginger", "prep": "grated"},
            {"text": "2 tbsp soy sauce", "quantity": "2", "unit": "tbsp", "name": "soy sauce", "prep": None},
            {"text": "1 jalapeño, thinly sliced", "quantity": "1", "unit": None, "name": "jalapeño", "prep": "thinly sliced"},
            {"text": "salt to taste", "quantity": None, "unit": None, "name": "salt", "prep": "to taste"},
            {"text": "2 scallions, chopped", "quantity": "2", "unit": None, "name": "scallions", "prep": "chopped"},
        ],
        "steps": [
            {
                "text": "Bring a large pot of water to a boil.",
                "accepted": [[]],
            },
            {
                # Shorthand "the noodles".
                "text": "Cook the noodles until just tender, then drain and rinse.",
                "accepted": [[1]],
            },
            {
                # Oil same-head trap: olive, NOT sesame. Range + non-ASCII.
                "text": "Heat the olive oil in a skillet and fry the garlic, ginger, and jalapeño until fragrant.",
                "accepted": [[3, 4, 5, 7]],
            },
            {
                # Reuse (noodles) + the OTHER oil.
                "text": "Toss the noodles with the soy sauce and sesame oil.",
                "accepted": [[1, 2, 6]],
            },
            {
                # "to taste" qualifier row.
                "text": "Season with salt and top with the scallions.",
                "accepted": [[8, 9]],
            },
        ],
    },
    {
        "id": "R3_alfredo",
        "title": "Cashew Alfredo",
        "servings": "4 servings",
        # Riff-shaped: structured only, no raw_text on the wire, including a
        # near-duplicate pair (two soy sauce rows differing by quantity/prep).
        "ingredients": [
            {"text": "1 cup cashews, soaked", "quantity": "1", "unit": "cup", "name": "cashews", "prep": "soaked"},
            {"text": "2 tbsp soy sauce", "quantity": "2", "unit": "tbsp", "name": "soy sauce", "prep": None},
            {"text": "1 tsp soy sauce, for finishing", "quantity": "1", "unit": "tsp", "name": "soy sauce", "prep": "for finishing"},
            {"text": "12 oz fettuccine", "quantity": "12", "unit": "oz", "name": "fettuccine", "prep": None},
            {"text": "2 cloves garlic", "quantity": "2", "unit": "cloves", "name": "garlic", "prep": None},
            {"text": "1/2 lemon, juiced", "quantity": "1/2", "unit": None, "name": "lemon", "prep": "juiced"},
        ],
        "steps": [
            {
                "text": "Soak the cashews in hot water for 20 minutes.",
                "accepted": [[1]],
            },
            {
                # Shorthand: "the fettuccine".
                "text": "Boil the fettuccine until al dente, reserving some pasta water.",
                "accepted": [[4]],
            },
            {
                # Near-duplicate discrimination: the 2 tbsp soy row, not the
                # finishing 1 tsp row.
                "text": "Blend the cashews with the garlic, 2 tablespoons of soy sauce, and the lemon juice until smooth.",
                "accepted": [[1, 2, 5, 6]],
            },
            {
                # Intermediate mixture: "the sauce" was built in step 3.
                # Accepted: minimal reading (pasta + finishing soy) or the
                # constituents-included reading. Both are truthful; a set
                # containing the WRONG soy row alone is not.
                "text": "Toss the pasta with the sauce and finish with the remaining teaspoon of soy sauce.",
                "accepted": [[3, 4], [1, 2, 3, 4, 5, 6]],
            },
        ],
    },
]

RECIPES_BY_ID = {r["id"]: r for r in MAPPING_EVAL_RECIPES}


def recipe_text(recipe: dict[str, Any]) -> str:
    """Plain-text rendering used for the text path and the fixture images."""
    lines = [recipe["title"], "", f"Servings: {recipe['servings']}", "", "Ingredients:"]
    for ing in recipe["ingredients"]:
        lines.append(f"- {ing['text']}")
    lines.append("")
    lines.append("Instructions:")
    for i, step in enumerate(recipe["steps"], start=1):
        lines.append(f"{i}. {step['text']}")
    return "\n".join(lines)


def structured_ingredients(
    recipe: dict[str, Any], *, include_raw_text: bool
) -> list[dict[str, Any]]:
    """Mapper-path inputs: JSON-LD shape (raw_text) or riff shape (no raw_text)."""
    out = []
    for ing in recipe["ingredients"]:
        row = {
            "quantity": ing["quantity"],
            "unit": ing["unit"],
            "name": ing["name"],
            "prep": ing["prep"],
        }
        if include_raw_text:
            row["raw_text"] = ing["text"]
        out.append(row)
    return out


def publisher_steps(recipe: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"position": i, "instruction": step["text"]}
        for i, step in enumerate(recipe["steps"], start=1)
    ]
