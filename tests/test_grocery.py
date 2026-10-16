"""Tests for grocery substitution-provenance notes (PROVIDER-S1.1 closure W2).

Covers the additive `grocery_items.note` pipeline:
  - OD-1 note derivation from ingredient prep (`_note_from_prep`)
  - OD-2 note-aware merge identity (`_merge_key`, `_normalize_note`)
  - `_merge_items_into_list` note-aware merge/insert behavior
  - `_add_recipe_to_list` prep -> note carriage (ordinary remake)
  - `_add_override_items` note passthrough (scaled remake, OD-5)
  - model + route-transform surface (`RemakeItemInput.note`,
    `GroceryItemResponse.note`, `_transform_item`)

File placement note: grocery tests are otherwise split per endpoint
(test_grocery_remake.py etc.); this file is the Binding-Gate-allowlisted
path for the W2 additions and leaves the existing files untouched.
"""

from unittest.mock import MagicMock
from uuid import UUID

import pytest
from pydantic import ValidationError

from api.core.grocery import (
    _add_override_items,
    _add_recipe_to_list,
    _merge_items_into_list,
    _merge_key,
    _normalize_note,
    _note_from_prep,
)
from api.models.grocery import GroceryItemResponse, RemakeItemInput
from api.routes.grocery import _transform_item

FAKE_LIST_ID = "00000000-0000-0000-0000-00000000000a"
FAKE_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_RECIPE_TITLE = "Soy-Glazed Sheet-Pan Portobello Mushrooms"

LABEL = "in place of fish sauce"


# ====================================================================
# Part 1 — OD-1 note derivation from prep
# ====================================================================


class TestNoteFromPrep:
    """Only convention-matching preps become notes; everything else is null."""

    def test_bare_label_carried_trimmed(self):
        assert _note_from_prep("  in place of fish sauce  ") == LABEL

    def test_parenthesized_label_carried_without_parens(self):
        assert _note_from_prep("(in place of fish sauce)") == LABEL

    def test_prefix_is_case_insensitive(self):
        assert _note_from_prep("In Place Of Fish Sauce") == "In Place Of Fish Sauce"

    @pytest.mark.parametrize(
        "prep", ["diced", "sliced", "packed", "minced", "divided", "about 6 oz each"]
    )
    def test_ordinary_prep_yields_null(self, prep):
        assert _note_from_prep(prep) is None

    def test_none_and_empty_yield_null(self):
        assert _note_from_prep(None) is None
        assert _note_from_prep("") is None
        assert _note_from_prep("   ") is None

    def test_label_not_at_start_yields_null(self):
        assert _note_from_prep("added in place of fish sauce") is None


class TestNormalizeNote:
    """Merge-comparison normalization: trim, collapse whitespace, lowercase."""

    def test_none_normalizes_to_empty(self):
        assert _normalize_note(None) == ""

    def test_trim_collapse_lowercase(self):
        assert _normalize_note("  In  Place   of Fish Sauce ") == LABEL


# ====================================================================
# Part 2 — OD-2 merge identity
# ====================================================================


class TestMergeKeyWithNote:
    """Note-aware merge key; unlabeled key format is byte-identical to before."""

    def test_unlabeled_key_format_unchanged(self):
        assert _merge_key("Flour", "cups") == "flour::cups"
        assert _merge_key("Flour", "cups", None) == "flour::cups"
        assert _merge_key("Flour", "cups", "   ") == "flour::cups"

    def test_labeled_and_unlabeled_keys_differ(self):
        assert _merge_key("soy sauce", "tsp", LABEL) != _merge_key(
            "soy sauce", "tsp"
        )

    def test_equal_normalized_notes_share_a_key(self):
        assert _merge_key("soy sauce", "tsp", "In Place  of FISH sauce") == _merge_key(
            "soy sauce", "tsp", LABEL
        )

    def test_different_notes_different_keys(self):
        assert _merge_key("soy sauce", "tsp", LABEL) != _merge_key(
            "soy sauce", "tsp", "in place of oyster sauce"
        )


# ====================================================================
# Part 3 — merge behavior (mocked Supabase, grocery_items only)
# ====================================================================


def _mock_db_with_existing(rows):
    """Mock Supabase where grocery_items already holds `rows`."""
    db = MagicMock()
    select_chain = MagicMock()
    select_chain.execute.return_value = MagicMock(data=rows)
    db.table.return_value.select.return_value.eq.return_value.order.return_value = (
        select_chain
    )
    insert_chain = MagicMock()
    insert_chain.execute.return_value = MagicMock(data=[])
    db.table.return_value.insert.return_value = insert_chain
    update_chain = MagicMock()
    update_chain.eq.return_value.execute.return_value = MagicMock(data=[])
    db.table.return_value.update.return_value = update_chain
    return db


def _existing_row(
    *, row_id="e1", name="soy sauce", unit="tsp", quantity="1", position=1, note=None
):
    return {
        "id": row_id,
        "name": name,
        "unit": unit,
        "quantity": quantity,
        "position": position,
        "source_recipes": None,
        "note": note,
    }


class TestNoteAwareMerge:
    """_merge_items_into_list respects the note-extended identity."""

    def test_same_name_unit_different_note_does_not_merge(self):
        """Test 1: labeled replacement never merges into unlabeled retained row."""
        db = _mock_db_with_existing([_existing_row(note=None)])

        result = _merge_items_into_list(
            FAKE_LIST_ID,
            None,
            None,
            [{"name": "soy sauce", "quantity": "1", "unit": "tsp", "note": LABEL}],
            supabase=db,
        )

        assert result.merged == 0
        assert result.inserted == 1
        inserted = db.table.return_value.insert.call_args[0][0]
        assert len(inserted) == 1
        assert inserted[0]["name"] == "soy sauce"
        assert inserted[0]["note"] == LABEL
        assert inserted[0]["position"] == 2

    def test_same_normalized_note_merges_and_preserves_note(self):
        """Test 3: equal normalized notes merge; quantity sums; note untouched."""
        db = _mock_db_with_existing([_existing_row(note=LABEL)])

        result = _merge_items_into_list(
            FAKE_LIST_ID,
            None,
            None,
            [
                {
                    "name": "Soy Sauce",
                    "quantity": "1",
                    "unit": "tsp",
                    "note": "In Place  of Fish Sauce",
                }
            ],
            supabase=db,
        )

        assert result.merged == 1
        assert result.inserted == 0
        update_fields = db.table.return_value.update.call_args[0][0]
        assert update_fields["quantity"] == "2"
        # The stored note is never rewritten by a merge.
        assert "note" not in update_fields

    def test_different_unit_different_note_stays_separate_and_labeled(self):
        """Test 2: unit mismatch inserts a separate row that keeps its label."""
        db = _mock_db_with_existing([_existing_row(unit="tbsp", quantity="2")])

        result = _merge_items_into_list(
            FAKE_LIST_ID,
            None,
            None,
            [{"name": "soy sauce", "quantity": "1", "unit": "tsp", "note": LABEL}],
            supabase=db,
        )

        assert result.merged == 0
        assert result.inserted == 1
        inserted = db.table.return_value.insert.call_args[0][0]
        assert inserted[0]["unit"] == "tsp"
        assert inserted[0]["note"] == LABEL

    def test_unlabeled_incoming_still_merges_with_unlabeled_existing(self):
        """Regression pin: pre-note behavior for unlabeled rows is unchanged."""
        db = _mock_db_with_existing([_existing_row(note=None)])

        result = _merge_items_into_list(
            FAKE_LIST_ID,
            None,
            None,
            [{"name": "soy sauce", "quantity": "1", "unit": "tsp"}],
            supabase=db,
        )

        assert result.merged == 1
        assert result.inserted == 0

    def test_empty_string_note_normalized_to_null_at_boundary(self):
        """4.1.D-style hardening: '' / whitespace notes are stored as null."""
        db = _mock_db_with_existing([])

        _merge_items_into_list(
            FAKE_LIST_ID,
            None,
            None,
            [{"name": "salt", "quantity": None, "unit": None, "note": "   "}],
            supabase=db,
        )

        inserted = db.table.return_value.insert.call_args[0][0]
        assert inserted[0]["note"] is None


# ====================================================================
# Part 4 — ordinary remake carries prep -> note (Test 5 included)
# ====================================================================


def _mock_db_for_recipe_add(ingredient_rows):
    """Dispatching mock: recipe_ingredients select + empty grocery_items."""
    ingredients_table = MagicMock()
    ingredients_table.select.return_value.eq.return_value.order.return_value.execute.return_value = MagicMock(
        data=ingredient_rows
    )

    items_table = MagicMock()
    items_table.select.return_value.eq.return_value.order.return_value.execute.return_value = MagicMock(
        data=[]
    )
    items_table.insert.return_value.execute.return_value = MagicMock(data=[])

    def _table(name):
        if name == "recipe_ingredients":
            return ingredients_table
        if name == "grocery_items":
            return items_table
        raise AssertionError(f"unexpected table: {name}")

    db = MagicMock()
    db.table.side_effect = _table
    return db, items_table


class TestRecipeRemakeCarriesNote:
    """_add_recipe_to_list derives note from prep per OD-1."""

    def test_labeled_prep_becomes_note_ordinary_prep_does_not(self):
        db, items_table = _mock_db_for_recipe_add(
            [
                {
                    "name": "soy sauce",
                    "quantity": "2",
                    "unit": "tbsp",
                    "prep": None,
                    "position": 1,
                },
                {
                    "name": "soy sauce",
                    "quantity": "1",
                    "unit": "tsp",
                    "prep": LABEL,
                    "position": 2,
                },
                {
                    "name": "scallions",
                    "quantity": "4",
                    "unit": None,
                    "prep": "sliced",
                    "position": 3,
                },
            ]
        )

        result = _add_recipe_to_list(
            FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE, supabase=db
        )

        assert result.inserted == 3
        assert result.merged == 0
        rows = items_table.insert.call_args[0][0]
        assert rows[0]["note"] is None
        assert rows[1]["note"] == LABEL
        assert rows[2]["note"] is None  # "sliced" is not provenance

    def test_second_remake_is_note_aware(self):
        """Test 5: re-adding the recipe merges per-row against equal identities."""
        db, items_table = _mock_db_for_recipe_add(
            [
                {
                    "name": "soy sauce",
                    "quantity": "1",
                    "unit": "tsp",
                    "prep": LABEL,
                    "position": 1,
                },
            ]
        )
        # Existing list already holds the labeled row from the first remake.
        items_table.select.return_value.eq.return_value.order.return_value.execute.return_value = MagicMock(
            data=[_existing_row(note=LABEL)]
        )

        result = _add_recipe_to_list(
            FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE, supabase=db
        )

        assert result.merged == 1
        assert result.inserted == 0


# ====================================================================
# Part 5 — scaled override passthrough (OD-5, Tests 9-11)
# ====================================================================


class TestOverridePathCarriesNote:
    """_add_override_items passes the client-derived note through."""

    def test_override_note_reaches_insert(self):
        db = _mock_db_with_existing([])

        items = [
            RemakeItemInput(name="soy sauce", quantity="2", unit="tbsp"),
            RemakeItemInput(name="soy sauce", quantity="1", unit="tsp", note=LABEL),
        ]

        result = _add_override_items(
            FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE, items, supabase=db
        )

        assert result.inserted == 2
        rows = db.table.return_value.insert.call_args[0][0]
        assert rows[0]["note"] is None
        assert rows[1]["note"] == LABEL

    def test_override_labeled_row_does_not_merge_into_unlabeled_existing(self):
        db = _mock_db_with_existing([_existing_row(note=None)])

        items = [
            RemakeItemInput(name="soy sauce", quantity="1", unit="tsp", note=LABEL),
        ]

        result = _add_override_items(
            FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE, items, supabase=db
        )

        assert result.merged == 0
        assert result.inserted == 1


# ====================================================================
# Part 6 — model + transform surface (Tests 4, 6, 7 backend mirrors)
# ====================================================================


class TestNoteModelSurface:
    """Additive model fields stay backward-compatible."""

    def test_remake_item_note_defaults_none(self):
        item = RemakeItemInput(name="flour", quantity="1", unit="cup")
        assert item.note is None

    def test_remake_item_accepts_note(self):
        item = RemakeItemInput(name="soy sauce", quantity="1", unit="tsp", note=LABEL)
        assert item.note == LABEL

    def test_remake_item_still_rejects_prep_field(self):
        with pytest.raises(ValidationError):
            RemakeItemInput(name="soy sauce", prep=LABEL)

    def test_item_response_validates_without_note(self):
        """Old-API payload shape (no note) still validates (Test 7 mirror)."""
        payload = _transformed_item(note_absent=True)
        model = GroceryItemResponse.model_validate(payload)
        assert model.note is None

    def test_item_response_validates_with_note(self):
        payload = _transformed_item()
        model = GroceryItemResponse.model_validate(payload)
        assert model.note == LABEL


def _raw_item_row(**overrides):
    row = {
        "id": "00000000-0000-0000-0000-0000000000b1",
        "list_id": "00000000-0000-0000-0000-00000000000a",
        "recipe_id": None,
        "position": 1,
        "quantity": "1",
        "unit": "tsp",
        "name": "soy sauce",
        "checked": False,
        "recipes": None,
        "source_recipes": None,
        "note": LABEL,
    }
    row.update(overrides)
    return row


def _transformed_item(*, note_absent=False):
    row = _raw_item_row()
    if note_absent:
        row.pop("note")
    payload = _transform_item(row)
    if note_absent:
        assert payload["note"] is None
    return payload


class TestTransformItemNote:
    """_transform_item surfaces note and tolerates its absence."""

    def test_note_passed_through(self):
        assert _transform_item(_raw_item_row())["note"] == LABEL

    def test_missing_note_transforms_to_none(self):
        row = _raw_item_row()
        row.pop("note")
        assert _transform_item(row)["note"] is None

    def test_unknown_raw_columns_never_reach_the_model(self):
        """Migration-first safety pin: the transform is an explicit allowlist."""
        row = _raw_item_row(surprise_column="anything")
        payload = _transform_item(row)
        assert "surprise_column" not in payload
        GroceryItemResponse.model_validate(payload)


# ====================================================================
# Part 7 — merge SELECT column contract (post-rescue correction 7a)
# ====================================================================


class TestMergeSelectIncludesNote:
    """The existing-items merge query MUST request the note column.

    The merge mocks ignore the select argument, so without this pin a
    regression dropping `note` from the SELECT would pass every other test
    while silently breaking note-aware merging against pre-existing rows.
    Membership is asserted, not ordering — ordering is not load-bearing.
    """

    def test_existing_items_select_requests_note(self):
        db = _mock_db_with_existing([])

        _merge_items_into_list(
            FAKE_LIST_ID,
            None,
            None,
            [{"name": "salt", "quantity": None, "unit": None}],
            supabase=db,
        )

        select_mock = db.table.return_value.select
        select_mock.assert_called_once()
        columns = [
            c.strip() for c in select_mock.call_args[0][0].split(",")
        ]
        assert "note" in columns
        # The other columns the merge logic reads must stay requested too.
        for required in ("id", "name", "unit", "quantity", "position",
                        "source_recipes"):
            assert required in columns


# ====================================================================
# Part 8 — OD-1 backend/mobile parity table (post-rescue correction 7b)
#
# The SAME case names, inputs, and expected outputs appear verbatim in
# tastelog-mobile/__tests__/lib/ingredients/groceryOverride.test.ts
# ("OD-1 parity table"). Keep the two tables in lockstep: any change here
# without the mirror change there is a contract break.
# ====================================================================


OD1_PARITY_TABLE = [
    ("valid_bare", "in place of fish sauce", "in place of fish sauce"),
    ("valid_parenthesized", "(in place of fish sauce)", "in place of fish sauce"),
    ("mixed_case", "In Place Of Fish Sauce", "In Place Of Fish Sauce"),
    (
        "leading_trailing_whitespace",
        "  in place of fish sauce  ",
        "in place of fish sauce",
    ),
    ("ordinary_prep", "diced", None),
    ("phrase_later_in_text", "added in place of fish sauce", None),
    ("no_space_after_of", "in place ofX", None),
    ("empty_target", "in place of", None),
    ("whitespace_only_target", "in place of   ", None),
    ("unmatched_opening_paren", "(in place of fish sauce", None),
    (
        "unmatched_closing_paren",
        "in place of fish sauce)",
        "in place of fish sauce)",
    ),
    ("double_parens", "((in place of fish sauce))", None),
    (
        "punctuation_after_target",
        "in place of fish sauce.",
        "in place of fish sauce.",
    ),
]


class TestNoteFromPrepParityTable:
    """Tightened OD-1 rule over the shared backend/mobile parity table."""

    @pytest.mark.parametrize(
        "case_name,prep,expected",
        OD1_PARITY_TABLE,
        ids=[c[0] for c in OD1_PARITY_TABLE],
    )
    def test_parity_case(self, case_name, prep, expected):
        assert _note_from_prep(prep) == expected
