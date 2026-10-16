"""
Merge-only quantity parsing and arithmetic for grocery consolidation.

Parses quantity strings into exact fractions (stdlib fractions.Fraction)
and supports addition + display for merged grocery items.

Canonical parser contract mirrors tastelog-mobile/lib/ingredients/parseQuantity.ts.
Scope: parse, add, display. No scaling, no classification, no formatting beyond display.
"""

from __future__ import annotations

import re
from fractions import Fraction


# ---------------------------------------------------------------------------
# Unicode fraction map (matches TS UNICODE_FRACTIONS exactly)
# ---------------------------------------------------------------------------

_UNICODE_FRACTIONS: dict[str, Fraction] = {
    "\u00bd": Fraction(1, 2),
    "\u2153": Fraction(1, 3),
    "\u2154": Fraction(2, 3),
    "\u00bc": Fraction(1, 4),
    "\u00be": Fraction(3, 4),
    "\u2155": Fraction(1, 5),
    "\u2156": Fraction(2, 5),
    "\u2157": Fraction(3, 5),
    "\u2158": Fraction(4, 5),
    "\u2159": Fraction(1, 6),
    "\u215a": Fraction(5, 6),
    "\u215b": Fraction(1, 8),
    "\u215c": Fraction(3, 8),
    "\u215d": Fraction(5, 8),
    "\u215e": Fraction(7, 8),
}

# ---------------------------------------------------------------------------
# Patterns (no flags, applied to trimmed input)
# ---------------------------------------------------------------------------

_INTEGER_RE = re.compile(r"^(\d+)$")
_DECIMAL_RE = re.compile(r"^(\d+)\.(\d+)$")
_FRACTION_RE = re.compile(r"^(\d+)/(\d+)$")
_MIXED_RE = re.compile(r"^(\d+)\s+(\d+)/(\d+)$")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def parse_quantity(raw: str | None) -> Fraction | None:
    """
    Parse a quantity string into an exact Fraction.
    Returns None if the string cannot be parsed deterministically.

    Supported formats:
      - Integer: "2", "10"
      - Decimal: "1.5", "0.75"
      - Fraction: "1/2", "3/4"
      - Mixed number: "1 1/2", "2 3/4"
      - Unicode fraction: "½", "¼", "1½"

    Rejected (returns None):
      - None, empty, whitespace-only
      - Negative numbers
      - Ranges: "1-2", "2 to 3"
      - Approximations: "about 2", "~3"
      - Free text: "some", "a few", "pinch"
    """
    if raw is None:
        return None

    trimmed = raw.strip()
    if not trimmed:
        return None

    if trimmed.startswith("-"):
        return None

    # Unicode fraction (single char or integer + unicode)
    result = _parse_unicode(trimmed)
    if result is not None:
        return result

    # Integer: "2", "10"
    m = _INTEGER_RE.match(trimmed)
    if m:
        return Fraction(int(m.group(1)))

    # Decimal: "1.5", "0.75"
    m = _DECIMAL_RE.match(trimmed)
    if m:
        whole_str = m.group(1)
        frac_str = m.group(2)
        denom = 10 ** len(frac_str)
        numer = int(whole_str) * denom + int(frac_str)
        return Fraction(numer, denom)

    # Fraction: "1/2", "3/4"
    m = _FRACTION_RE.match(trimmed)
    if m:
        num, den = int(m.group(1)), int(m.group(2))
        if den == 0:
            return None
        return Fraction(num, den)

    # Mixed number: "1 1/2", "2 3/4"
    m = _MIXED_RE.match(trimmed)
    if m:
        whole, num, den = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if den == 0:
            return None
        if num >= den:
            return None
        return Fraction(whole * den + num, den)

    return None


def display_quantity(value: Fraction) -> str:
    """
    Format a Fraction as a user-friendly quantity string.

    Returns integer, simple fraction, or mixed number as appropriate.
    Examples: Fraction(3) -> "3", Fraction(1,2) -> "1/2", Fraction(3,2) -> "1 1/2"
    """
    if value == 0:
        return "0"

    whole = int(value)
    remainder = value - whole

    if remainder == 0:
        return str(whole)
    if whole == 0:
        return f"{remainder.numerator}/{remainder.denominator}"
    return f"{whole} {remainder.numerator}/{remainder.denominator}"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _parse_unicode(s: str) -> Fraction | None:
    """Handle unicode fractions, optionally preceded by an integer."""
    if len(s) == 1:
        return _UNICODE_FRACTIONS.get(s)

    last = s[-1]
    frac = _UNICODE_FRACTIONS.get(last)
    if frac is None:
        return None

    before = s[:-1].strip()
    if not _INTEGER_RE.match(before):
        return None

    return Fraction(int(before)) + frac
