"""Issue 1: render the mapping-eval fixture recipes to PNG images.

Deterministic generator for the vision-path inputs of the mapping quality
gate. Produces tests/eval/fixtures/<recipe_id>.png from the same
recipe_text() rendering the text path uses, so the two paths parse the
same source content.

Usage:
    api/.venv/bin/python tests/eval/make_mapping_fixture_images.py

Not a pytest test. Re-running overwrites the PNGs byte-for-byte only if
Pillow's encoder is deterministic on this platform; the committed images
are the fixtures of record.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parents[1]
for _path in (str(_REPO_ROOT), str(_THIS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from mapping_eval_recipes import MAPPING_EVAL_RECIPES, recipe_text  # noqa: E402

FIXTURES_DIR = _THIS_DIR / "fixtures"

WIDTH = 1200
MARGIN = 40
LINE_SPACING = 10
FONT_SIZE = 26
WRAP_COLS = 82

# Helvetica (system TTC) covers the non-ASCII fixture glyphs (jalapeño)
# that Pillow's embedded default font renders as tofu boxes.
_FONT_CANDIDATES = (
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
)


def _load_font() -> ImageFont.FreeTypeFont:
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, FONT_SIZE)
        except OSError:
            continue
    raise RuntimeError("No fixture font available; add a TTF path")


def render(text: str) -> Image.Image:
    import textwrap

    font = _load_font()
    lines: list[str] = []
    for raw_line in text.split("\n"):
        if not raw_line:
            lines.append("")
            continue
        lines.extend(
            textwrap.wrap(
                raw_line,
                WRAP_COLS,
                subsequent_indent="   ",
                break_long_words=False,
            )
        )
    # Measure line height from a representative glyph run.
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    bbox = probe.textbbox((0, 0), "Ag", font=font)
    line_height = (bbox[3] - bbox[1]) + LINE_SPACING
    height = MARGIN * 2 + line_height * len(lines)
    img = Image.new("RGB", (WIDTH, height), "white")
    draw = ImageDraw.Draw(img)
    y = MARGIN
    for line in lines:
        draw.text((MARGIN, y), line, fill="black", font=font)
        y += line_height
    return img


def main() -> None:
    FIXTURES_DIR.mkdir(exist_ok=True)
    for recipe in MAPPING_EVAL_RECIPES:
        out = FIXTURES_DIR / f"{recipe['id']}.png"
        render(recipe_text(recipe)).save(out, format="PNG")
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
