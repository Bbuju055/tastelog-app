"""
Parity tests for api/core/quantity.py.

Mirrors tastelog-mobile/__tests__/lib/ingredients/parseQuantity.test.ts
to guard against behavioral drift between the TS and Python parsers.
"""

from fractions import Fraction

import pytest

from api.core.quantity import display_quantity, parse_quantity


# ---------------------------------------------------------------------------
# Parsing — fixture table mirrors TS test cases exactly
# ---------------------------------------------------------------------------


class TestParseIntegers:
    def test_single_digit(self):
        assert parse_quantity("2") == Fraction(2)
        assert parse_quantity("0") == Fraction(0)

    def test_multi_digit(self):
        assert parse_quantity("10") == Fraction(10)
        assert parse_quantity("123") == Fraction(123)

    def test_trims_whitespace(self):
        assert parse_quantity("  2  ") == Fraction(2)


class TestParseDecimals:
    def test_simple_decimals(self):
        assert parse_quantity("1.5") == Fraction(3, 2)
        assert parse_quantity("0.5") == Fraction(1, 2)
        assert parse_quantity("2.0") == Fraction(2)

    def test_multiple_decimal_places(self):
        assert parse_quantity("0.75") == Fraction(3, 4)
        assert parse_quantity("0.25") == Fraction(1, 4)
        assert parse_quantity("1.125") == Fraction(9, 8)

    def test_rejects_malformed_decimals(self):
        assert parse_quantity(".5") is None
        assert parse_quantity("1.") is None
        assert parse_quantity("1..5") is None


class TestParseFractions:
    def test_simple_fractions(self):
        assert parse_quantity("1/2") == Fraction(1, 2)
        assert parse_quantity("3/4") == Fraction(3, 4)
        assert parse_quantity("1/8") == Fraction(1, 8)

    def test_improper_fractions(self):
        assert parse_quantity("3/2") == Fraction(3, 2)
        assert parse_quantity("5/4") == Fraction(5, 4)

    def test_reduces_fractions(self):
        assert parse_quantity("2/4") == Fraction(1, 2)
        assert parse_quantity("6/8") == Fraction(3, 4)

    def test_rejects_zero_denominator(self):
        assert parse_quantity("1/0") is None


class TestParseMixedNumbers:
    def test_mixed_numbers(self):
        assert parse_quantity("1 1/2") == Fraction(3, 2)
        assert parse_quantity("2 3/4") == Fraction(11, 4)
        assert parse_quantity("1 1/4") == Fraction(5, 4)

    def test_multiple_spaces(self):
        assert parse_quantity("1  1/2") == Fraction(3, 2)

    def test_rejects_improper_fraction_part(self):
        assert parse_quantity("1 5/4") is None
        assert parse_quantity("2 3/2") is None
        assert parse_quantity("1 4/4") is None

    def test_rejects_zero_denominator(self):
        assert parse_quantity("1 1/0") is None


class TestParseUnicodeFractions:
    def test_single_unicode(self):
        assert parse_quantity("\u00bd") == Fraction(1, 2)
        assert parse_quantity("\u00bc") == Fraction(1, 4)
        assert parse_quantity("\u00be") == Fraction(3, 4)
        assert parse_quantity("\u2153") == Fraction(1, 3)
        assert parse_quantity("\u2154") == Fraction(2, 3)

    def test_integer_plus_unicode(self):
        assert parse_quantity("1\u00bd") == Fraction(3, 2)
        assert parse_quantity("2\u00bc") == Fraction(9, 4)
        assert parse_quantity("1\u00be") == Fraction(7, 4)

    def test_integer_space_unicode(self):
        assert parse_quantity("1 \u00bd") == Fraction(3, 2)
        assert parse_quantity("2 \u00bc") == Fraction(9, 4)

    def test_rejects_invalid_prefix(self):
        assert parse_quantity("a\u00bd") is None
        assert parse_quantity("1.5\u00bd") is None

    def test_rejects_unicode_with_suffix(self):
        assert parse_quantity("\u00bd tsp") is None
        assert parse_quantity("1\u00bd cups") is None


class TestParseRejections:
    def test_none(self):
        assert parse_quantity(None) is None

    def test_empty_and_whitespace(self):
        assert parse_quantity("") is None
        assert parse_quantity("   ") is None

    def test_negative_numbers(self):
        assert parse_quantity("-1") is None
        assert parse_quantity("-1/2") is None
        assert parse_quantity("-0.5") is None

    def test_ranges(self):
        assert parse_quantity("1-2") is None
        assert parse_quantity("2 to 3") is None
        assert parse_quantity("1 or 2") is None

    def test_approximations(self):
        assert parse_quantity("about 2") is None
        assert parse_quantity("~3") is None
        assert parse_quantity("2-ish") is None
        assert parse_quantity("approx 1") is None

    def test_free_text(self):
        assert parse_quantity("some") is None
        assert parse_quantity("a few") is None
        assert parse_quantity("pinch") is None
        assert parse_quantity("several") is None

    def test_mixed_text_and_numbers(self):
        assert parse_quantity("2 cups") is None
        assert parse_quantity("one") is None
        assert parse_quantity("2x") is None


# ---------------------------------------------------------------------------
# Display — covers summed output for merged grocery items
# ---------------------------------------------------------------------------


class TestDisplayQuantity:
    def test_integer(self):
        assert display_quantity(Fraction(3)) == "3"
        assert display_quantity(Fraction(0)) == "0"

    def test_simple_fraction(self):
        assert display_quantity(Fraction(1, 2)) == "1/2"
        assert display_quantity(Fraction(3, 4)) == "3/4"

    def test_mixed_number(self):
        assert display_quantity(Fraction(3, 2)) == "1 1/2"
        assert display_quantity(Fraction(11, 4)) == "2 3/4"

    def test_summed_display(self):
        """Verify display after adding two parsed quantities (merge scenario)."""
        a = parse_quantity("1")
        b = parse_quantity("2")
        assert a is not None and b is not None
        assert display_quantity(a + b) == "3"

        c = parse_quantity("1/2")
        d = parse_quantity("3/4")
        assert c is not None and d is not None
        assert display_quantity(c + d) == "1 1/4"

        e = parse_quantity("1 1/2")
        f = parse_quantity("2 3/4")
        assert e is not None and f is not None
        assert display_quantity(e + f) == "4 1/4"
