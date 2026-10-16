"""Issue 1: deterministic tests for the step-ingredient mapping contract.

Covers the four-state validation semantics, parser preservation, the
soft-failure provider mapper, atomic attach outcome recording, draft
normalization, and server-side semantic edit invalidation. No provider
calls: the Anthropic client is stubbed per test.
"""

import json
import logging
from unittest.mock import MagicMock

import pytest

from api.core.parser import ParsedRecipe, get_default_config
from api.core.step_mapping import (
    STEP_MAPPING_KEY,
    apply_step_mapping,
    canonicalize_parsed_recipe,
    compute_confirm_mappings,
    derive_step_ingredient_positions,
    map_ingredients_to_steps,
    normalize_edited_ingredients,
    strip_step_mapping,
    validate_positions_value,
)

logger = logging.getLogger("test_step_mapping")


# ---------------------------------------------------------------------------
# Four-state validation
# ---------------------------------------------------------------------------


class TestValidatePositionsValue:
    def test_none_is_unknown(self):
        assert validate_positions_value(None, 3) is None

    def test_empty_list_is_authoritative_empty(self):
        assert validate_positions_value([], 3) == []

    def test_valid_list(self):
        assert validate_positions_value([1, 3], 3) == [1, 3]

    def test_duplicates_dedupe_preserving_order(self):
        assert validate_positions_value([2, 2, 1], 3) == [2, 1]

    def test_out_of_range_degrades_whole_value(self):
        # [99] must NOT become []
        assert validate_positions_value([99], 3) is None

    def test_partial_out_of_range_degrades_whole_value(self):
        # [1, 99] must NOT become [1]
        assert validate_positions_value([1, 99], 3) is None

    def test_zero_degrades(self):
        assert validate_positions_value([0], 3) is None

    def test_negative_degrades(self):
        assert validate_positions_value([-1], 3) is None

    def test_boolean_degrades(self):
        assert validate_positions_value([True], 3) is None

    def test_mixed_types_degrade(self):
        assert validate_positions_value([1, "2"], 3) is None

    def test_float_degrades(self):
        assert validate_positions_value([1.5], 3) is None

    def test_non_list_degrades(self):
        assert validate_positions_value("1,2", 3) is None
        assert validate_positions_value({"a": 1}, 3) is None
        assert validate_positions_value(2, 3) is None


# ---------------------------------------------------------------------------
# Parser integration: preservation + range check
# ---------------------------------------------------------------------------


def _parsed(steps: list[dict], ingredient_count: int = 2) -> ParsedRecipe:
    return ParsedRecipe.model_validate(
        {
            "title": "T",
            "confidence": 0.5,
            "ingredients": [
                {"name": f"ing{i}"} for i in range(ingredient_count)
            ],
            "steps": steps,
        }
    )


class TestParsedRecipeMapping:
    def test_normalization_preserves_field(self):
        # Step positions get re-indexed; ingredient_positions must survive.
        pr = _parsed(
            [
                {"position": 5, "instruction": "a", "ingredient_positions": [1]},
                {"position": 9, "instruction": "b", "ingredient_positions": []},
            ]
        )
        assert [s.position for s in pr.steps] == [1, 2]
        assert [s.ingredient_positions for s in pr.steps] == [[1], []]

    def test_null_is_unknown_empty_stays_empty_list_stays_authority(self):
        """The three states are distinct end-to-end through the parser
        schema: null -> unknown, [] -> authoritative empty, [i..] ->
        authoritative list."""
        recipe = ParsedRecipe.model_validate(
            {
                "title": "T",
                "confidence": 1.0,
                "ingredients": [{"name": "a", "raw_text": "a"}],
                "steps": [
                    {
                        "position": 1,
                        "instruction": "x",
                        "ingredient_positions": None,
                    },
                    {
                        "position": 2,
                        "instruction": "y",
                        "ingredient_positions": [],
                    },
                    {
                        "position": 3,
                        "instruction": "z",
                        "ingredient_positions": [1],
                    },
                ],
            }
        )
        assert [s.ingredient_positions for s in recipe.steps] == [
            None,
            [],
            [1],
        ]

    def test_absent_field_is_unknown(self):
        pr = _parsed([{"position": 1, "instruction": "a"}])
        assert pr.steps[0].ingredient_positions is None

    def test_out_of_range_degrades_that_step_only(self):
        pr = _parsed(
            [
                {"position": 1, "instruction": "a", "ingredient_positions": [1, 99]},
                {"position": 2, "instruction": "b", "ingredient_positions": [2]},
            ]
        )
        assert pr.steps[0].ingredient_positions is None
        assert pr.steps[1].ingredient_positions == [2]

    def test_malformed_field_is_unknown_not_sanitized(self):
        pr = _parsed(
            [
                {"position": 1, "instruction": "a", "ingredient_positions": [True]},
                {"position": 2, "instruction": "b", "ingredient_positions": "1"},
            ]
        )
        assert pr.steps[0].ingredient_positions is None
        assert pr.steps[1].ingredient_positions is None


# ---------------------------------------------------------------------------
# Canonicalization helpers
# ---------------------------------------------------------------------------


class TestCanonicalize:
    def test_derive_reads_field_defaulting_none(self):
        steps = [
            {"position": 1, "instruction": "a", "ingredient_positions": [1]},
            {"position": 2, "instruction": "b", "ingredient_positions": []},
            {"position": 3, "instruction": "c"},
        ]
        assert derive_step_ingredient_positions(steps) == [[1], [], None]

    def test_strip_removes_mapping_from_public_shape(self):
        steps = [
            {"position": 1, "instruction": "a", "ingredient_positions": [1]},
        ]
        assert strip_step_mapping(steps) == [
            {"position": 1, "instruction": "a"}
        ]

    def test_canonicalize_splits_mapping_out_of_steps(self):
        parsed = {
            "title": "T",
            "ingredients": [{"name": "x"}],
            "steps": [
                {"position": 1, "instruction": "a", "ingredient_positions": [1]},
                {"position": 2, "instruction": "b"},
            ],
        }
        out = canonicalize_parsed_recipe(parsed)
        assert out[STEP_MAPPING_KEY] == [[1], None]
        assert out["steps"] == [
            {"position": 1, "instruction": "a"},
            {"position": 2, "instruction": "b"},
        ]
        # Original dict is not mutated.
        assert "ingredient_positions" in parsed["steps"][0]


# ---------------------------------------------------------------------------
# Soft-failure provider mapper
# ---------------------------------------------------------------------------


def _mapper_client(response_text: str) -> MagicMock:
    client = MagicMock()
    block = MagicMock()
    block.text = response_text
    message = MagicMock()
    message.content = [block]
    client.messages.create.return_value = message
    return client


_INGS = [{"name": "flour", "raw_text": "2 cups flour"}, {"name": "salt"}]
_STEPS = [
    {"position": 1, "instruction": "Preheat"},
    {"position": 2, "instruction": "Mix flour and salt"},
]


class TestMapIngredientsToSteps:
    def _run(self, response_text: str):
        return map_ingredients_to_steps(
            _INGS,
            _STEPS,
            client=_mapper_client(response_text),
            config=get_default_config(),
            logger=logger,
        )

    def test_valid_response(self):
        result = self._run(
            json.dumps(
                [
                    {"step": 1, "ingredients": []},
                    {"step": 2, "ingredients": [1, 2]},
                ]
            )
        )
        assert result == [[], [1, 2]]

    def test_null_ingredients_is_unknown_not_empty(self):
        """Uncertainty contract: a null "ingredients" arrives as unknown
        (fallback), never coerced into authoritative empty, while a
        confident [] on another step stays authoritative empty."""
        result = self._run(
            json.dumps(
                [
                    {"step": 1, "ingredients": None},
                    {"step": 2, "ingredients": []},
                ]
            )
        )
        assert result == [None, []]

    def test_fenced_response(self):
        result = self._run(
            "```json\n"
            + json.dumps([{"step": 1, "ingredients": []}])
            + "\n```"
        )
        assert result == [[], None]

    def test_partial_output_leaves_missing_steps_unknown(self):
        result = self._run(json.dumps([{"step": 2, "ingredients": [1]}]))
        assert result == [None, [1]]

    def test_malformed_ingredients_degrade_that_step(self):
        result = self._run(
            json.dumps(
                [
                    {"step": 1, "ingredients": [99]},
                    {"step": 2, "ingredients": [2]},
                ]
            )
        )
        assert result == [None, [2]]

    def test_invalid_json_returns_none(self):
        assert self._run("not json at all") is None

    def test_non_list_returns_none(self):
        assert self._run(json.dumps({"step": 1})) is None

    def test_duplicate_step_records_return_none(self):
        result = self._run(
            json.dumps(
                [
                    {"step": 1, "ingredients": [1]},
                    {"step": 1, "ingredients": [2]},
                ]
            )
        )
        assert result is None

    def test_out_of_range_step_record_skipped(self):
        result = self._run(
            json.dumps(
                [
                    {"step": 7, "ingredients": [1]},
                    {"step": 1, "ingredients": [1]},
                ]
            )
        )
        assert result == [[1], None]

    def test_provider_exception_returns_none(self):
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("boom")
        assert (
            map_ingredients_to_steps(
                _INGS,
                _STEPS,
                client=client,
                config=get_default_config(),
                logger=logger,
            )
            is None
        )

    def test_empty_inputs_return_none(self):
        client = MagicMock()
        assert (
            map_ingredients_to_steps(
                [],
                _STEPS,
                client=client,
                config=get_default_config(),
                logger=logger,
            )
            is None
        )
        assert (
            map_ingredients_to_steps(
                _INGS,
                [],
                client=client,
                config=get_default_config(),
                logger=logger,
            )
            is None
        )
        client.messages.create.assert_not_called()


class TestUncertaintyPromptContract:
    """Every production mapping prompt must route model uncertainty to
    step-level null (never to omission inside an authoritative list)
    and must reserve [] for confidently ingredient-free steps.
    (MULTI_IMAGE_PARSE_PROMPT embeds DEFAULT_PARSE_PROMPT and is covered
    through it.)"""

    @staticmethod
    def _prompts() -> dict[str, str]:
        from api.core.parser import DEFAULT_PARSE_PROMPT
        from api.core.step_mapping import STEP_MAPPING_PROMPT
        from api.core.url_extractor import URL_TEXT_PARSE_PROMPT

        return {
            "parser": DEFAULT_PARSE_PROMPT,
            "mapper": STEP_MAPPING_PROMPT,
            "url_text": URL_TEXT_PARSE_PROMPT,
        }

    def test_uncertainty_routes_to_step_level_null(self):
        for name, prompt in self._prompts().items():
            assert "null" in prompt, name
            assert "COMPLETE set" in prompt, name
            assert "an incomplete list is worse than null" in prompt, name

    def test_omission_instruction_is_gone(self):
        for name, prompt in self._prompts().items():
            assert "leave it out" not in prompt, name

    def test_empty_reserved_for_confident_no_ingredient_steps(self):
        for name, prompt in self._prompts().items():
            assert "ONLY when you are confident" in prompt, name


# ---------------------------------------------------------------------------
# Atomic attach + outcome recording
# ---------------------------------------------------------------------------


def _supabase_mock() -> MagicMock:
    sb = MagicMock()
    sb.rpc.return_value.execute.return_value = MagicMock(data={"status": "attached"})
    return sb


class TestApplyStepMapping:
    def test_complete_outcome(self):
        sb = _supabase_mock()
        outcome = apply_step_mapping(
            "rid", [[1], []], expected_content_rev=1, supabase=sb, logger=logger
        )
        assert outcome == "complete"
        # Issue 3: the attach RPC is the 3-arg rev-guarded form.
        rpc_params = sb.rpc.call_args[0][1]
        assert rpc_params == {
            "p_recipe_id": "rid",
            "p_expected_content_rev": 1,
            "p_mappings": [
                {"step_position": 1, "ingredient_positions": [1]},
                {"step_position": 2, "ingredient_positions": []},
            ],
        }
        sb.table.return_value.update.assert_called_once_with(
            {"step_mapping_outcome": "complete"}
        )
        # Rev-guarded outcome write: a stale attempt cannot overwrite a
        # newer edit's atomically-recorded outcome.
        eq_calls = [
            c.args
            for c in sb.table.return_value.update.return_value.eq.call_args_list
        ] + [
            c.args
            for c in sb.table.return_value.update.return_value.eq.return_value.eq.call_args_list
        ]
        assert ("content_rev", 1) in eq_calls

    def test_partial_outcome(self):
        sb = _supabase_mock()
        outcome = apply_step_mapping(
            "rid", [[1], None], expected_content_rev=1, supabase=sb, logger=logger
        )
        assert outcome == "partial"
        payload = sb.rpc.call_args[0][1]["p_mappings"]
        assert payload == [{"step_position": 1, "ingredient_positions": [1]}]

    def test_all_unknown_is_degraded_without_rpc(self):
        sb = _supabase_mock()
        outcome = apply_step_mapping(
            "rid", [None, None], expected_content_rev=1, supabase=sb, logger=logger
        )
        assert outcome == "degraded"
        sb.rpc.assert_not_called()
        sb.table.return_value.update.assert_called_once_with(
            {"step_mapping_outcome": "degraded"}
        )

    def test_rpc_failure_degrades_and_never_raises(self):
        sb = _supabase_mock()
        sb.rpc.return_value.execute.side_effect = RuntimeError("db down")
        outcome = apply_step_mapping(
            "rid", [[1]], expected_content_rev=1, supabase=sb, logger=logger
        )
        assert outcome == "degraded"
        # Recipe rows are never touched by this helper on failure.
        sb.table.return_value.delete.assert_not_called()

    def test_stale_rev_refusal_degrades_and_never_raises(self):
        """Issue 3: a TL428 stale refusal is the designed freshness outcome."""
        sb = _supabase_mock()
        sb.rpc.return_value.execute.side_effect = RuntimeError(
            "Stale content revision for mapping attach (TL428)"
        )
        outcome = apply_step_mapping(
            "rid", [[1]], expected_content_rev=1, supabase=sb, logger=logger
        )
        assert outcome == "degraded"
        sb.table.return_value.delete.assert_not_called()

    def test_outcome_update_failure_is_swallowed(self):
        sb = _supabase_mock()
        sb.table.return_value.update.return_value.eq.return_value.eq.return_value.execute.side_effect = (
            RuntimeError("db down")
        )
        outcome = apply_step_mapping(
            "rid", [[1]], expected_content_rev=1, supabase=sb, logger=logger
        )
        assert outcome == "complete"


# ---------------------------------------------------------------------------
# Draft normalization + semantic edit invalidation
# ---------------------------------------------------------------------------


def _draft(
    mapping,
    *,
    steps=None,
    ingredients=None,
    include_key: bool = True,
) -> dict:
    steps = steps or [
        {"position": 1, "instruction": "Preheat"},
        {"position": 2, "instruction": "Mix flour and salt"},
    ]
    ingredients = ingredients or [
        {
            "quantity": "2",
            "unit": "cups",
            "name": "flour",
            "prep": None,
            "raw_text": "2 cups flour",
        },
        {
            "quantity": None,
            "unit": None,
            "name": "salt",
            "prep": None,
            "raw_text": "salt to taste",
        },
    ]
    raw: dict = {"title": "T"}
    if include_key:
        raw[STEP_MAPPING_KEY] = mapping
    return {
        "steps": steps,
        "ingredients": ingredients,
        "raw_model_json": raw,
    }


class TestNormalizeEditedIngredients:
    def test_raw_text_only_edit_collapses_to_truthful_row(self):
        draft = _draft([[1], []])
        edited = [dict(draft["ingredients"][0]), dict(draft["ingredients"][1])]
        edited[0]["raw_text"] = "3 tbsp butter"
        out = normalize_edited_ingredients(draft["ingredients"], edited)
        assert out[0] == {
            "quantity": None,
            "unit": None,
            "name": "3 tbsp butter",
            "prep": None,
            "raw_text": "3 tbsp butter",
        }
        # Untouched row passes through unchanged.
        assert out[1] == edited[1]

    def test_structured_edit_passes_through(self):
        draft = _draft([[1], []])
        edited = [dict(draft["ingredients"][0]), dict(draft["ingredients"][1])]
        edited[0]["quantity"] = "3"
        edited[0]["raw_text"] = "3 cups flour"
        out = normalize_edited_ingredients(draft["ingredients"], edited)
        assert out[0] == edited[0]

    def test_blank_raw_text_edit_left_alone(self):
        draft = _draft([[1], []])
        edited = [dict(draft["ingredients"][0]), dict(draft["ingredients"][1])]
        edited[0]["raw_text"] = "   "
        out = normalize_edited_ingredients(draft["ingredients"], edited)
        assert out[0] == edited[0]

    def test_count_change_identical_row_passes_through(self):
        """Count change alone: a surviving row byte-identical to an
        original keeps its structured fields."""
        draft = _draft([[1], []])
        edited = [dict(draft["ingredients"][0])]
        assert (
            normalize_edited_ingredients(draft["ingredients"], edited)
            == edited
        )

    def test_count_change_collapses_raw_text_edited_row(self):
        """Count change + raw_text edit: the edited row must not keep
        stale structured fields that no longer describe its text."""
        draft = _draft([[1], []])
        edited = [dict(draft["ingredients"][0])]
        edited[0]["raw_text"] = "3 tbsp butter"
        out = normalize_edited_ingredients(draft["ingredients"], edited)
        assert out == [
            {
                "quantity": None,
                "unit": None,
                "name": "3 tbsp butter",
                "prep": None,
                "raw_text": "3 tbsp butter",
            }
        ]

    def test_count_change_added_row_collapses_to_its_raw_text(self):
        """A user-added row (unmatched, raw_text only) lands as
        unstructured truth; untouched originals pass through."""
        draft = _draft([[1], []])
        added = {
            "quantity": None,
            "unit": None,
            "name": None,
            "prep": None,
            "raw_text": "1 cup oats",
        }
        edited = [
            dict(draft["ingredients"][0]),
            dict(draft["ingredients"][1]),
            added,
        ]
        out = normalize_edited_ingredients(draft["ingredients"], edited)
        assert out[0] == edited[0]
        assert out[1] == edited[1]
        assert out[2]["name"] == "1 cup oats"
        assert out[2]["quantity"] is None
        assert out[2]["unit"] is None
        assert out[2]["prep"] is None


class TestComputeConfirmMappings:
    def test_legacy_draft_returns_none(self):
        draft = _draft(None, include_key=False)
        assert compute_confirm_mappings(draft, None, None) is None
        draft_no_raw = _draft(None, include_key=False)
        draft_no_raw["raw_model_json"] = None
        assert compute_confirm_mappings(draft_no_raw, None, None) is None

    def test_unedited_confirm_keeps_mapping(self):
        draft = _draft([[1], [1, 2]])
        assert compute_confirm_mappings(draft, None, None) == [[1], [1, 2]]

    def test_authoritative_empty_survives(self):
        draft = _draft([[], [1]])
        assert compute_confirm_mappings(draft, None, None) == [[], [1]]

    def test_malformed_stored_entry_is_unknown(self):
        draft = _draft([[1, 99], [1]])
        assert compute_confirm_mappings(draft, None, None) == [None, [1]]

    def test_structurally_malformed_stored_mapping_all_unknown(self):
        draft = _draft([[1]])  # length 1 != 2 steps
        assert compute_confirm_mappings(draft, None, None) == [None, None]

    def test_step_instruction_edit_invalidates_that_step_only(self):
        draft = _draft([[1], [2]])
        steps_override = [
            {"position": 1, "instruction": "Preheat"},
            {"position": 2, "instruction": "Mix everything well"},
        ]
        assert compute_confirm_mappings(draft, None, steps_override) == [
            [1],
            None,
        ]

    def test_step_count_change_invalidates_all(self):
        draft = _draft([[1], [2]])
        steps_override = [{"position": 1, "instruction": "Preheat"}]
        assert compute_confirm_mappings(draft, None, steps_override) == [
            None,
            None,
        ]

    def test_ingredient_semantic_change_invalidates_referencing_steps(self):
        draft = _draft([[1], [2]])
        edited = [dict(draft["ingredients"][0]), dict(draft["ingredients"][1])]
        edited[0]["name"] = "butter"
        assert compute_confirm_mappings(draft, edited, None) == [None, [2]]

    def test_ingredient_count_change_invalidates_all(self):
        draft = _draft([[1], [2]])
        edited = [dict(draft["ingredients"][0])]
        assert compute_confirm_mappings(draft, edited, None) == [None, None]

    def test_untouched_overrides_keep_mapping(self):
        draft = _draft([[1], [2]])
        steps_override = [dict(s) for s in draft["steps"]]
        ingredients_override = [dict(i) for i in draft["ingredients"]]
        assert compute_confirm_mappings(
            draft, ingredients_override, steps_override
        ) == [[1], [2]]


# ---------------------------------------------------------------------------
# get_recipe composition + capture_recipe attach wiring
# ---------------------------------------------------------------------------


from unittest.mock import patch
from uuid import UUID

from api.core.recipes import capture_recipe, get_recipe

_RID = "00000000-0000-0000-0000-00000000000a"
_UID = UUID("00000000-0000-0000-0000-000000000001")
_STEP1 = "00000000-0000-0000-0000-0000000000s1".replace("s", "1")
_STEP2 = "00000000-0000-0000-0000-0000000000b2"
_ING1 = "00000000-0000-0000-0000-0000000000c1"
_ING2 = "00000000-0000-0000-0000-0000000000c2"


def _get_recipe_supabase(step_rows, assoc_rows):
    """Issue 3: get_recipe reads ONE coherent get_recipe_snapshot RPC."""
    snapshot = {
        "recipe": {
            "id": _RID,
            "user_id": str(_UID),
            "title": "T",
            "content_rev": 1,
            "last_content_mutation_id": None,
        },
        "ingredients": [
            {"id": _ING1, "recipe_id": _RID, "position": 1, "name": "flour"},
            {"id": _ING2, "recipe_id": _RID, "position": 2, "name": "salt"},
        ],
        "steps": step_rows,
        "associations": assoc_rows,
        "tags": [],
    }
    sb = MagicMock()
    sb.rpc.return_value.execute.return_value.data = snapshot
    return sb


class TestGetRecipeMappingComposition:
    def test_composes_three_states_in_position_order(self):
        step_rows = [
            {
                "id": _STEP1,
                "recipe_id": _RID,
                "position": 1,
                "instruction": "a",
                "ingredient_mapping_version": 1,
            },
            {
                "id": _STEP2,
                "recipe_id": _RID,
                "position": 2,
                "instruction": "b",
                "ingredient_mapping_version": None,
            },
        ]
        # Association rows deliberately out of ingredient order.
        assoc_rows = [
            {"step_id": _STEP1, "ingredient_id": _ING2},
            {"step_id": _STEP1, "ingredient_id": _ING1},
        ]
        sb = _get_recipe_supabase(step_rows, assoc_rows)
        result = get_recipe(UUID(_RID), user_id=_UID, supabase=sb)

        steps = result["steps"]
        # Canonical recipe ingredient (position) order, not join order.
        assert steps[0]["ingredient_ids"] == [_ING1, _ING2]
        # Unknown state: null, and the internal version never leaks.
        assert steps[1]["ingredient_ids"] is None
        assert "ingredient_mapping_version" not in steps[0]
        assert "ingredient_mapping_version" not in steps[1]

    def test_authoritative_empty_composes_empty_list(self):
        step_rows = [
            {
                "id": _STEP1,
                "recipe_id": _RID,
                "position": 1,
                "instruction": "Preheat",
                "ingredient_mapping_version": 1,
            },
        ]
        sb = _get_recipe_supabase(step_rows, [])
        result = get_recipe(UUID(_RID), user_id=_UID, supabase=sb)
        assert result["steps"][0]["ingredient_ids"] == []


class TestCaptureRecipeAttachWiring:
    def test_capture_attaches_derived_mapping(self):
        parsed = {
            "title": "T",
            "servings": None,
            "prep_time": None,
            "cook_time": None,
            "confidence": 0.9,
            "ingredients": [{"name": "flour"}],
            "steps": [
                {
                    "position": 1,
                    "instruction": "Mix",
                    "ingredient_positions": [1],
                },
                {"position": 2, "instruction": "Rest", "ingredient_positions": []},
            ],
        }
        recipes_tbl = MagicMock()
        recipes_tbl.insert.return_value.execute.return_value.data = [
            {"id": _RID}
        ]
        children_tbl = MagicMock()

        def _table(name):
            return recipes_tbl if name == "recipes" else children_tbl

        sb = MagicMock()
        sb.table.side_effect = _table

        with patch(
            "api.core.recipes.upload_image", return_value="key"
        ), patch(
            "api.core.recipes.parse_recipe_image", return_value=parsed
        ), patch(
            "api.core.recipes.apply_step_mapping", return_value="complete"
        ) as apply_spy:
            capture_recipe(
                "/tmp/fake.jpg",
                user_id=_UID,
                supabase=sb,
                anthropic_client=MagicMock(),
                parser_config=MagicMock(),
                logger=logger,
            )

        # Mapping-aware creation: pending stamped at insert, then the
        # derived mapping attached against the new recipe id.
        recipe_payload = recipes_tbl.insert.call_args.args[0]
        assert recipe_payload["step_mapping_outcome"] == "pending"
        apply_spy.assert_called_once()
        assert apply_spy.call_args.args[0] == _RID
        assert apply_spy.call_args.args[1] == [[1], []]
        # Issue 3: creation producers attach against content_rev DEFAULT 1.
        assert apply_spy.call_args.kwargs["expected_content_rev"] == 1
