"""
Test that get_recipe() returns a flat dict compatible with RecipeDetailResponse.

Issue 3: get_recipe reads ONE coherent get_recipe_snapshot RPC (single MVCC
snapshot); these tests mock that RPC and prove the flat composed shape,
content_rev inclusion, and that last_content_mutation_id never leaves the
API.

Uses unittest + unittest.mock — no external test dependencies required.
"""

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

from api.core.recipes import get_recipe
from api.models.recipe import RecipeDetailResponse


def _make_supabase_mock(snapshot: dict) -> MagicMock:
    """Build a mock Supabase client whose snapshot RPC returns `snapshot`."""
    db = MagicMock()
    db.rpc.return_value.execute.return_value = SimpleNamespace(data=snapshot)
    return db


class TestGetRecipeShape(unittest.TestCase):
    """Verify get_recipe() output is flat and validates against RecipeDetailResponse."""

    def setUp(self):
        self.user_id = uuid4()
        self.recipe_id = uuid4()
        self.now = datetime.now(timezone.utc).isoformat()

        self.recipe_row = {
            "id": str(self.recipe_id),
            "user_id": str(self.user_id),
            "title": "Test Recipe",
            "image_path": None,
            "source_url": None,
            "servings": "4",
            "prep_time": "10 min",
            "cook_time": "30 min",
            "confidence_score": 0.95,
            "favorite": False,
            "created_at": self.now,
            "updated_at": self.now,
            "parent_recipe_id": None,
            "riff_session_id": None,
            "riff_label": None,
            "content_rev": 2,
            "last_content_mutation_id": str(uuid4()),
        }

        self.ingredient_rows = [
            {
                "id": str(uuid4()),
                "recipe_id": str(self.recipe_id),
                "position": 1,
                "quantity": "1",
                "unit": "cup",
                "name": "flour",
                "prep": "sifted",
                "raw_text": "1 cup flour, sifted",
            },
            {
                "id": str(uuid4()),
                "recipe_id": str(self.recipe_id),
                "position": 2,
                "quantity": "2",
                "unit": None,
                "name": "eggs",
                "prep": None,
                "raw_text": "2 eggs",
            },
        ]

        self.step_rows = [
            {
                "id": str(uuid4()),
                "recipe_id": str(self.recipe_id),
                "position": 1,
                "instruction": "Mix dry ingredients.",
                "ingredient_mapping_version": None,
            },
            {
                "id": str(uuid4()),
                "recipe_id": str(self.recipe_id),
                "position": 2,
                "instruction": "Add eggs and stir.",
                "ingredient_mapping_version": None,
            },
        ]

    def _snapshot(self, recipe=None, ingredients=None, steps=None):
        return {
            "recipe": recipe if recipe is not None else self.recipe_row,
            "ingredients": (
                ingredients if ingredients is not None else self.ingredient_rows
            ),
            "steps": steps if steps is not None else self.step_rows,
            "associations": [],
            "tags": [],
        }

    def test_return_is_flat(self):
        """get_recipe() must return flat dict — no nested 'recipe' key."""
        db = _make_supabase_mock(self._snapshot())
        result = get_recipe(self.recipe_id, user_id=self.user_id, supabase=db)

        self.assertNotIn("recipe", result, "Result must not have nested 'recipe' key")
        self.assertIn("id", result)
        self.assertIn("title", result)
        self.assertIn("ingredients", result)
        self.assertIn("steps", result)
        self.assertIsInstance(result["ingredients"], list)
        self.assertIsInstance(result["steps"], list)

    def test_validates_against_response_model(self):
        """get_recipe() output must pass RecipeDetailResponse.model_validate()."""
        db = _make_supabase_mock(self._snapshot())
        result = get_recipe(self.recipe_id, user_id=self.user_id, supabase=db)

        detail = RecipeDetailResponse.model_validate(result)

        self.assertEqual(detail.title, "Test Recipe")
        self.assertEqual(len(detail.ingredients), 2)
        self.assertEqual(len(detail.steps), 2)
        self.assertEqual(detail.ingredients[0].name, "flour")
        self.assertEqual(detail.steps[0].instruction, "Mix dry ingredients.")
        self.assertAlmostEqual(detail.confidence_score, 0.95)

    def test_content_rev_exposed_mutation_id_hidden(self):
        """Issue 3: content_rev is on the wire; last_content_mutation_id is not."""
        db = _make_supabase_mock(self._snapshot())
        result = get_recipe(self.recipe_id, user_id=self.user_id, supabase=db)

        self.assertEqual(result["content_rev"], 2)
        self.assertNotIn("last_content_mutation_id", result)

        detail = RecipeDetailResponse.model_validate(result)
        self.assertEqual(detail.content_rev, 2)

    def test_snapshot_rpc_is_the_read_path(self):
        """Issue 3: the coherent snapshot RPC is the only read issued."""
        db = _make_supabase_mock(self._snapshot())
        get_recipe(self.recipe_id, user_id=self.user_id, supabase=db)

        db.rpc.assert_called_once_with(
            "get_recipe_snapshot",
            {
                "p_recipe_id": str(self.recipe_id),
                "p_user_id": str(self.user_id),
            },
        )
        db.table.assert_not_called()

    def test_empty_children(self):
        """Recipe with no ingredients or steps must still validate."""
        db = _make_supabase_mock(self._snapshot(ingredients=[], steps=[]))
        result = get_recipe(self.recipe_id, user_id=self.user_id, supabase=db)

        detail = RecipeDetailResponse.model_validate(result)

        self.assertEqual(detail.ingredients, [])
        self.assertEqual(detail.steps, [])

    def test_nullable_fields(self):
        """Recipe with all nullable fields as None must still validate."""
        row = {
            **self.recipe_row,
            "image_path": None,
            "servings": None,
            "prep_time": None,
            "cook_time": None,
            "confidence_score": None,
        }
        db = _make_supabase_mock(self._snapshot(recipe=row))
        result = get_recipe(self.recipe_id, user_id=self.user_id, supabase=db)

        detail = RecipeDetailResponse.model_validate(result)

        self.assertIsNone(detail.servings)
        self.assertIsNone(detail.prep_time)
        self.assertIsNone(detail.cook_time)
        self.assertIsNone(detail.confidence_score)


if __name__ == "__main__":
    unittest.main()
