"""Real PDF regression cases. No model or database access."""
import logging
from pathlib import Path
from unittest.mock import Mock

import pytest

from api.core.exceptions import ImageProcessingError
from api.core.image_encoding import encode_image
from api.core.parser import get_default_config, parse_recipe_image, parse_recipe_images

INPUTS = Path(__file__).parent / "eval/fidelity/inputs"


@pytest.mark.parametrize("name", ["avocado_salad", "caramelized_onions", "garlic_aioli"])
def test_single_page_pdf_still_encodes(name):
    data, mime = encode_image(str(INPUTS / f"{name}.pdf"), max_size=1568, pdf_dpi=150, jpeg_quality=85)
    assert data and mime == "image/jpeg"


@pytest.mark.parametrize("name", ["beef_bourguignon", "croque_monsieur", "french_onion_soup", "halal_guys_sauces"])
@pytest.mark.parametrize("multiple", [False, True])
def test_both_parsers_refuse_multipage_before_model(name, multiple):
    client = Mock()
    path = str(INPUTS / f"{name}.pdf")
    parser = parse_recipe_images if multiple else parse_recipe_image
    paths = [str(INPUTS / "garlic_aioli.pdf"), path] if multiple else path
    with pytest.raises(ImageProcessingError) as error:
        parser(paths, client=client, config=get_default_config(), logger=logging.getLogger(__name__))
    assert error.value.code == "PDF_MULTIPAGE_UNSUPPORTED"
    client.messages.create.assert_not_called()


@pytest.mark.parametrize("pages", [None, 0, -1, "1", True])
def test_unverifiable_count_fails_closed(monkeypatch, pages):
    monkeypatch.setattr("api.core.image_encoding.pdfinfo_from_path", lambda *a, **k: {"Pages": pages})
    render = Mock()
    monkeypatch.setattr("api.core.image_encoding.convert_from_path", render)
    with pytest.raises(ImageProcessingError) as error:
        encode_image(str(INPUTS / "garlic_aioli.pdf"), max_size=1568, pdf_dpi=150, jpeg_quality=85)
    assert error.value.code == "PDF_PAGE_COUNT_FAILED"
    render.assert_not_called()


def test_broken_pdf_fails_closed(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.4\ninvalid")
    with pytest.raises(ImageProcessingError) as error:
        encode_image(str(path), max_size=1568, pdf_dpi=150, jpeg_quality=85)
    assert error.value.code == "PDF_PAGE_COUNT_FAILED"
